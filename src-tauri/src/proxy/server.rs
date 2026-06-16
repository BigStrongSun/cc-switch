//! HTTP代理服务器
//!
//! 基于Axum的HTTP服务器，处理代理请求
//!
//! Uses a manual hyper HTTP/1.1 accept loop with `preserve_header_case(true)` so
//! that the original header-name casing from the CLI client is captured in a
//! `HeaderCaseMap` extension.  This map is later forwarded to the upstream via
//! the hyper-based HTTP client, producing wire-level header casing identical to
//! a direct (non-proxied) CLI request.

use super::{
    failover_switch::FailoverSwitchManager,
    handlers,
    log_codes::srv as log_srv,
    provider_router::ProviderRouter,
    providers::{codex_chat_history::CodexChatHistoryStore, gemini_shadow::GeminiShadowStore},
    types::*,
    ProxyError,
};
use crate::database::Database;
use axum::{
    extract::DefaultBodyLimit,
    routing::{any, get, post},
    Router,
};
use hyper_util::rt::TokioIo;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};
use tokio::task::JoinHandle;

/// 代理服务器状态（共享）
#[derive(Clone)]
pub struct ProxyState {
    pub db: Arc<Database>,
    pub config: Arc<RwLock<ProxyConfig>>,
    pub status: Arc<RwLock<ProxyStatus>>,
    pub start_time: Arc<RwLock<Option<std::time::Instant>>>,
    /// 每个应用类型当前使用的 provider (app_type -> (provider_id, provider_name))
    pub current_providers: Arc<RwLock<std::collections::HashMap<String, (String, String)>>>,
    /// 共享的 ProviderRouter（持有熔断器状态，跨请求保持）
    pub provider_router: Arc<ProviderRouter>,
    /// Gemini Native shadow state，用于 thoughtSignature / tool call 回放
    pub gemini_shadow: Arc<GeminiShadowStore>,
    /// Codex Chat bridge history，用于恢复 previous_response_id 指向的 tool call
    pub codex_chat_history: Arc<CodexChatHistoryStore>,
    /// AppHandle，用于发射事件和更新托盘菜单
    pub app_handle: Option<tauri::AppHandle>,
    /// 故障转移切换管理器
    pub failover_manager: Arc<FailoverSwitchManager>,
}

/// 代理HTTP服务器
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyServerMode {
    FullProxy,
    ExternalOpenAiApiOnly,
}

pub struct ProxyServer {
    config: ProxyConfig,
    mode: ProxyServerMode,
    state: ProxyState,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    /// 服务器任务句柄，用于等待服务器实际关闭
    server_handle: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl ProxyServer {
    pub fn new(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        Self::new_with_mode(config, db, app_handle, ProxyServerMode::FullProxy)
    }

    pub fn new_external_openai_api(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        Self::new_with_mode(
            config,
            db,
            app_handle,
            ProxyServerMode::ExternalOpenAiApiOnly,
        )
    }

    fn new_with_mode(
        config: ProxyConfig,
        db: Arc<Database>,
        app_handle: Option<tauri::AppHandle>,
        mode: ProxyServerMode,
    ) -> Self {
        // 创建共享的 ProviderRouter（熔断器状态将跨所有请求保持）
        let provider_router = Arc::new(ProviderRouter::new(db.clone()));
        // 创建故障转移切换管理器
        let failover_manager = Arc::new(FailoverSwitchManager::new(db.clone()));

        let state = ProxyState {
            db,
            config: Arc::new(RwLock::new(config.clone())),
            status: Arc::new(RwLock::new(ProxyStatus::default())),
            start_time: Arc::new(RwLock::new(None)),
            current_providers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            provider_router,
            gemini_shadow: Arc::new(GeminiShadowStore::default()),
            codex_chat_history: Arc::new(CodexChatHistoryStore::default()),
            app_handle,
            failover_manager,
        };

        Self {
            config,
            mode,
            state,
            shutdown_tx: Arc::new(RwLock::new(None)),
            server_handle: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start(&self) -> Result<ProxyServerInfo, ProxyError> {
        // 检查是否已在运行
        if self.shutdown_tx.read().await.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        let addr: SocketAddr =
            format!("{}:{}", self.config.listen_address, self.config.listen_port)
                .parse()
                .map_err(|e| ProxyError::BindFailed(format!("无效的地址: {e}")))?;

        // 创建关闭通道
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        // 构建路由
        let app = self.build_router();

        // 绑定监听器
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| ProxyError::BindFailed(e.to_string()))?;
        let actual_port = local_addr.port();

        log::info!("[{}] 代理服务器启动于 {local_addr}", log_srv::STARTED);

        // 更新全局代理端口，用于系统代理检测
        crate::proxy::http_client::set_proxy_port(actual_port);

        // 保存关闭句柄
        *self.shutdown_tx.write().await = Some(shutdown_tx);

        // 更新状态
        let mut status = self.state.status.write().await;
        status.running = true;
        status.address = self.config.listen_address.clone();
        status.port = actual_port;
        drop(status);

        // 记录启动时间
        *self.state.start_time.write().await = Some(std::time::Instant::now());

        // 启动服务器 — 使用手动 hyper HTTP/1.1 accept loop
        // 开启 preserve_header_case 以捕获客户端请求头的原始大小写
        let state = self.state.clone();
        let handle = tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let (stream, _remote_addr) = match result {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("[{SRV}] accept 失败: {e}", SRV = log_srv::ACCEPT_ERR);
                                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                                continue;
                            }
                        };

                        let app = app.clone();
                        tokio::spawn(async move {
                            // Peek raw TCP bytes to capture original header casing
                            // before hyper parses (and lowercases) the header names.
                            let original_cases = {
                                let mut peek_buf = vec![0u8; 8192];
                                match stream.peek(&mut peek_buf).await {
                                    Ok(n) => {
                                        let cases = super::hyper_client::OriginalHeaderCases::from_raw_bytes(&peek_buf[..n]);
                                        log::debug!(
                                            "[ProxyServer] Peeked {} bytes, captured {} header casings",
                                            n, cases.cases.len()
                                        );
                                        cases
                                    }
                                    Err(e) => {
                                        log::debug!("[ProxyServer] peek failed (non-fatal): {e}");
                                        super::hyper_client::OriginalHeaderCases::default()
                                    }
                                }
                            };

                            // service_fn 将 axum Router（tower::Service）桥接到 hyper
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let mut router = app.clone();
                                let cases = original_cases.clone();
                                async move {
                                    // 将 hyper::body::Incoming 转为 axum::body::Body，保留 extensions
                                    let (mut parts, body) = req.into_parts();

                                    // Insert our own header case map alongside hyper's internal one
                                    parts.extensions.insert(cases);

                                    let body = axum::body::Body::new(body);
                                    let axum_req = http::Request::from_parts(parts, body);
                                    <Router as tower::Service<http::Request<axum::body::Body>>>::call(&mut router, axum_req).await
                                }
                            });

                            if let Err(e) = hyper::server::conn::http1::Builder::new()
                                .preserve_header_case(true)
                                .serve_connection(TokioIo::new(stream), service)
                                .await
                            {
                                // Connection reset / broken pipe 等在代理场景下很常见，debug 级别
                                log::debug!("[{SRV}] connection error: {e}", SRV = log_srv::CONN_ERR);
                            }
                        });
                    }
                    _ = &mut shutdown_rx => {
                        break;
                    }
                }
            }

            // 服务器停止后更新状态
            state.status.write().await.running = false;
            *state.start_time.write().await = None;
        });

        // 保存服务器任务句柄
        *self.server_handle.write().await = Some(handle);

        Ok(ProxyServerInfo {
            address: self.config.listen_address.clone(),
            port: actual_port,
            started_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub async fn stop(&self) -> Result<(), ProxyError> {
        // 1. 发送关闭信号
        if let Some(tx) = self.shutdown_tx.write().await.take() {
            let _ = tx.send(());
        } else {
            return Err(ProxyError::NotRunning);
        }

        // 2. 等待服务器任务结束（带 5 秒超时保护）
        if let Some(handle) = self.server_handle.write().await.take() {
            match tokio::time::timeout(std::time::Duration::from_secs(5), handle).await {
                Ok(Ok(())) => {
                    log::info!("[{}] 代理服务器已完全停止", log_srv::STOPPED);
                    Ok(())
                }
                Ok(Err(e)) => {
                    log::warn!("[{}] 代理服务器任务异常终止: {e}", log_srv::TASK_ERROR);
                    Err(ProxyError::StopFailed(e.to_string()))
                }
                Err(_) => {
                    log::warn!(
                        "[{}] 代理服务器停止超时（5秒），强制继续",
                        log_srv::STOP_TIMEOUT
                    );
                    Err(ProxyError::StopTimeout)
                }
            }
        } else {
            Ok(())
        }
    }

    pub async fn get_status(&self) -> ProxyStatus {
        let mut status = self.state.status.read().await.clone();

        // 计算运行时间
        if let Some(start) = *self.state.start_time.read().await {
            status.uptime_seconds = start.elapsed().as_secs();
        }

        // 从 current_providers HashMap 获取每个应用类型当前正在使用的 provider
        let current_providers = self.state.current_providers.read().await;
        status.active_targets = current_providers
            .iter()
            .map(|(app_type, (provider_id, provider_name))| ActiveTarget {
                app_type: app_type.clone(),
                provider_id: provider_id.clone(),
                provider_name: provider_name.clone(),
            })
            .collect();

        status
    }

    /// 更新某个应用类型当前“目标供应商”（用于 UI 展示 active_targets）
    ///
    /// 注意：这不代表该供应商一定已经处理过请求，而是用于“热切换/启用故障转移立即切 P1”
    /// 等场景下，让 UI 能立刻反映最新目标。
    pub async fn set_active_target(&self, app_type: &str, provider_id: &str, provider_name: &str) {
        let mut current_providers = self.state.current_providers.write().await;
        current_providers.insert(
            app_type.to_string(),
            (provider_id.to_string(), provider_name.to_string()),
        );
    }

    fn build_router(&self) -> Router {
        if self.mode == ProxyServerMode::ExternalOpenAiApiOnly {
            return self.build_external_openai_api_router();
        }

        Router::new()
            // 健康检查
            .route("/health", get(handlers::health_check))
            .route("/status", get(handlers::get_status))
            // Claude API (支持带前缀和不带前缀两种格式)
            .route("/v1/messages", post(handlers::handle_messages))
            .route("/claude/v1/messages", post(handlers::handle_messages))
            // Claude Desktop 3P 本地 gateway（独立 provider namespace）
            .route(
                "/claude-desktop/v1/models",
                get(handlers::handle_claude_desktop_models),
            )
            .route(
                "/claude-desktop/v1/messages",
                post(handlers::handle_claude_desktop_messages),
            )
            // OpenAI Chat Completions API (Codex CLI，支持带前缀和不带前缀)
            .route("/chat/completions", post(handlers::handle_chat_completions))
            .route(
                "/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/v1/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            .route(
                "/codex/v1/chat/completions",
                post(handlers::handle_chat_completions),
            )
            // OpenAI Models API (Codex CLI reachability check)
            .route("/models", get(handlers::handle_models))
            .route("/v1/models", get(handlers::handle_models))
            // OpenAI Responses API (Codex CLI，支持带前缀和不带前缀)
            .route(
                "/responses",
                get(handlers::handle_responses_websocket).post(handlers::handle_responses),
            )
            .route(
                "/v1/responses",
                get(handlers::handle_responses_websocket).post(handlers::handle_responses),
            )
            .route(
                "/v1/v1/responses",
                get(handlers::handle_responses_websocket).post(handlers::handle_responses),
            )
            .route(
                "/codex/v1/responses",
                get(handlers::handle_responses_websocket).post(handlers::handle_responses),
            )
            // OpenAI Responses Compact API (Codex CLI 远程压缩，透传)
            .route(
                "/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/v1/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            .route(
                "/codex/v1/responses/compact",
                post(handlers::handle_responses_compact),
            )
            // Gemini API (支持带前缀和不带前缀)
            //
            // 用 `any(..)` 覆盖所有 HTTP 方法：除了 POST `:generateContent` /
            // `:streamGenerateContent` / `:countTokens` 之外，Gemini SDK / CLI 还会发
            // GET `/models`、GET `/models/<id>` 等只读端点。如果只挂 POST，这些 GET
            // 请求会在路由层 404，绕过本地代理的统计、整流和故障转移。
            .route("/v1beta/*path", any(handlers::handle_gemini))
            .route("/gemini/v1beta/*path", any(handlers::handle_gemini))
            // Gemini 的 GA 版本也叫 /v1，给原 SDK 留一条出口
            .route("/gemini/v1/*path", any(handlers::handle_gemini))
            // 提高默认请求体大小限制（避免 413 Payload Too Large）
            .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
            .with_state(self.state.clone())
    }

    fn build_external_openai_api_router(&self) -> Router {
        Router::new()
            .route("/health", get(handlers::health_check))
            .route("/v1/models", get(handlers::handle_external_models))
            .route(
                "/v1/chat/completions",
                post(handlers::handle_external_chat_completions),
            )
            .route(
                "/v1/responses",
                get(handlers::handle_responses_websocket).post(handlers::handle_external_responses),
            )
            .layer(DefaultBodyLimit::max(200 * 1024 * 1024))
            .with_state(self.state.clone())
    }

    /// 在不重启服务的情况下更新运行时配置
    pub async fn apply_runtime_config(&self, config: &ProxyConfig) {
        *self.state.config.write().await = config.clone();
    }

    /// 热更新熔断器配置
    ///
    /// 将新配置应用到所有已创建的熔断器实例
    pub async fn update_circuit_breaker_configs(
        &self,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state.provider_router.update_all_configs(config).await;
    }

    pub async fn update_circuit_breaker_config_for_app(
        &self,
        app_type: &str,
        config: super::circuit_breaker::CircuitBreakerConfig,
    ) {
        self.state
            .provider_router
            .update_app_configs(app_type, config)
            .await;
    }

    /// 重置指定 Provider 的熔断器
    pub async fn reset_provider_circuit_breaker(&self, provider_id: &str, app_type: &str) {
        self.state
            .provider_router
            .reset_provider_breaker(provider_id, app_type)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider::Provider,
        proxy::external_openai_api::{
            self, ExternalOpenAiApiBackendType, ExternalOpenAiApiProfileUpdate,
        },
    };
    use axum::{body::Body, response::IntoResponse, Json};
    use http::{header, Method, Request, StatusCode};
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use serial_test::serial;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    /// 测试专用 home，用于隔离 Codex live config/catalog 文件。
    struct TestHomeGuard {
        _dir: tempfile::TempDir,
        original_home: Option<String>,
        original_userprofile: Option<String>,
        original_test_home: Option<String>,
    }

    impl TestHomeGuard {
        /// 创建临时 home 并覆盖环境变量，避免 endpoint 测试读取真实用户 `.codex`。
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("create temp home");
            let original_home = std::env::var("HOME").ok();
            let original_userprofile = std::env::var("USERPROFILE").ok();
            let original_test_home = std::env::var("CC_SWITCH_TEST_HOME").ok();

            std::env::set_var("HOME", dir.path());
            std::env::set_var("USERPROFILE", dir.path());
            std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());

            Self {
                _dir: dir,
                original_home,
                original_userprofile,
                original_test_home,
            }
        }
    }

    impl Drop for TestHomeGuard {
        /// 测试结束后恢复调用方环境变量，避免影响后续用例。
        fn drop(&mut self) {
            match &self.original_home {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            match &self.original_userprofile {
                Some(value) => std::env::set_var("USERPROFILE", value),
                None => std::env::remove_var("USERPROFILE"),
            }
            match &self.original_test_home {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
        }
    }

    /// 构造只用于 router 测试的内存数据库和 proxy server。
    fn build_test_server() -> (ProxyServer, Arc<Database>) {
        let db = Arc::new(Database::memory().expect("memory db"));
        let config = ProxyConfig {
            listen_address: "127.0.0.1".to_string(),
            listen_port: 15721,
            ..ProxyConfig::default()
        };
        (ProxyServer::new(config, db.clone(), None), db)
    }

    fn build_external_test_server() -> (ProxyServer, Arc<Database>) {
        let db = Arc::new(Database::memory().expect("memory db"));
        let config = ProxyConfig {
            listen_address: "127.0.0.1".to_string(),
            listen_port: 15722,
            ..ProxyConfig::default()
        };
        (
            ProxyServer::new_external_openai_api(config, db.clone(), None),
            db,
        )
    }

    /// 读取 Axum 响应体为 JSON，方便断言 OpenAI-compatible 响应结构。
    async fn response_json(response: axum::response::Response) -> Value {
        let body = response
            .into_body()
            .collect()
            .await
            .expect("collect body")
            .to_bytes();
        serde_json::from_slice(&body).expect("json body")
    }

    #[tokio::test]
    async fn v1_models_requires_external_api_key_for_non_codex_clients() {
        let (server, _db) = build_test_server();
        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/models")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = response_json(response).await;
        assert_eq!(body["error"]["type"], "authentication_error");
        assert_eq!(body["error"]["code"], "external_openai_api_disabled");
    }

    #[tokio::test]
    #[serial]
    async fn v1_models_for_codex_client_returns_catalog_and_openai_data() {
        let _home = TestHomeGuard::new();
        std::fs::create_dir_all(crate::codex_config::get_codex_config_dir())
            .expect("create codex dir");
        std::fs::write(
            crate::codex_config::get_codex_config_path(),
            r#"model_provider = "custom"
model_catalog_json = "cc-switch-model-catalog.json"

[model_providers.custom]
base_url = "http://127.0.0.1:15721/v1"
"#,
        )
        .expect("write config");
        std::fs::write(
            crate::codex_config::get_codex_model_catalog_path(),
            serde_json::to_string_pretty(&json!({
                "models": [
                    { "slug": "qwen3.6", "model": "qwen3.6", "display_name": "Qwen 3.6" },
                    {
                        "slug": "deepseek-v4-flash",
                        "model": "deepseek-v4-flash",
                        "display_name": "DeepSeek V4 Flash"
                    }
                ]
            }))
            .expect("serialize catalog"),
        )
        .expect("write catalog");

        let (server, _db) = build_test_server();
        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/models")
                    .header(header::USER_AGENT, "codex-cli/0.140.0")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["object"], "list");
        assert!(
            body["models"].as_array().is_some(),
            "Codex CLI raw catalog shape should remain available"
        );
        let ids: Vec<_> = body["data"]
            .as_array()
            .expect("OpenAI data array")
            .iter()
            .filter_map(|model| model.get("id").and_then(|id| id.as_str()))
            .collect();
        assert!(ids.contains(&"qwen3.6"));
        assert!(ids.contains(&"deepseek-v4-flash"));
    }

    #[tokio::test]
    async fn external_only_v1_models_never_serves_codex_catalog_by_user_agent() {
        let (server, _db) = build_external_test_server();
        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/models")
                    .header(header::USER_AGENT, "codex-cli-test")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = response_json(response).await;
        assert_eq!(body["error"]["type"], "authentication_error");
        assert_eq!(body["error"]["code"], "external_openai_api_disabled");
    }

    #[tokio::test]
    async fn v1_models_returns_profile_backend_models_with_valid_key() {
        let (server, db) = build_test_server();
        db.save_provider(
            "hermes",
            &Provider::with_id(
                "selected".to_string(),
                "Selected".to_string(),
                json!({
                    "base_url": "https://selected.example/v1",
                    "api_key": "sk-selected",
                    "models": ["visible-model"]
                }),
                None,
            ),
        )
        .expect("save provider");
        let generated = external_openai_api::regenerate_api_key(&db).expect("generate key");
        external_openai_api::update_profile(
            &db,
            ExternalOpenAiApiProfileUpdate {
                enabled: true,
                backend_type: ExternalOpenAiApiBackendType::Provider,
                app_type: Some("hermes".to_string()),
                provider_id: Some("selected".to_string()),
                route_id: None,
                default_model: Some("default-visible".to_string()),
                listen_address: None,
                listen_port: None,
            },
        )
        .expect("enable profile");

        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/models")
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", generated.api_key),
                    )
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let ids: Vec<_> = body["data"]
            .as_array()
            .expect("data array")
            .iter()
            .filter_map(|model| model.get("id").and_then(|id| id.as_str()))
            .collect();

        assert!(ids.contains(&"visible-model"));
        assert!(ids.contains(&"default-visible"));
        assert_eq!(body["object"], "list");
    }

    #[tokio::test]
    async fn v1_chat_completions_forwards_to_profile_backend() {
        let (upstream_base_url, _upstream_task) = spawn_openai_chat_mock().await;
        let (server, db) = build_test_server();
        db.save_provider(
            "hermes",
            &Provider::with_id(
                "selected".to_string(),
                "Selected".to_string(),
                json!({
                    "base_url": upstream_base_url,
                    "api_key": "sk-selected",
                    "models": ["visible-model"]
                }),
                None,
            ),
        )
        .expect("save provider");
        let generated = external_openai_api::regenerate_api_key(&db).expect("generate key");
        external_openai_api::update_profile(
            &db,
            ExternalOpenAiApiProfileUpdate {
                enabled: true,
                backend_type: ExternalOpenAiApiBackendType::Provider,
                app_type: Some("hermes".to_string()),
                provider_id: Some("selected".to_string()),
                route_id: None,
                default_model: Some("visible-model".to_string()),
                listen_address: None,
                listen_port: None,
            },
        )
        .expect("enable profile");

        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/chat/completions")
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", generated.api_key),
                    )
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "visible-model",
                            "messages": [{ "role": "user", "content": "ping" }]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        let status = response.status();
        let body = response_json(response).await;
        assert_eq!(status, StatusCode::OK, "unexpected response body: {body}");
        assert_eq!(body["object"], "chat.completion");
        assert_eq!(body["choices"][0]["message"]["content"], "pong");
    }

    #[tokio::test]
    async fn v1_chat_completions_preserves_chinese_for_profile_backend() {
        let captured_body = Arc::new(Mutex::new(None));
        let (upstream_base_url, _upstream_task) =
            spawn_openai_chat_mock_with_capture(captured_body.clone()).await;
        let (server, db) = build_test_server();
        db.save_provider(
            "hermes",
            &Provider::with_id(
                "selected".to_string(),
                "Selected".to_string(),
                json!({
                    "base_url": upstream_base_url,
                    "api_key": "sk-selected",
                    "models": ["visible-model"]
                }),
                None,
            ),
        )
        .expect("save provider");
        let generated = external_openai_api::regenerate_api_key(&db).expect("generate key");
        external_openai_api::update_profile(
            &db,
            ExternalOpenAiApiProfileUpdate {
                enabled: true,
                backend_type: ExternalOpenAiApiBackendType::Provider,
                app_type: Some("hermes".to_string()),
                provider_id: Some("selected".to_string()),
                route_id: None,
                default_model: Some("visible-model".to_string()),
                listen_address: None,
                listen_port: None,
            },
        )
        .expect("enable profile");

        let user_text = "当前页是教材与参考资料页，请用两句话说明应该学什么。Bondy-Murty、West";
        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/chat/completions")
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", generated.api_key),
                    )
                    .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "model": "visible-model",
                            "messages": [{ "role": "user", "content": user_text }]
                        }))
                        .expect("serialize request"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        let captured = captured_body
            .lock()
            .expect("captured body lock")
            .clone()
            .expect("mock upstream body");
        assert_eq!(captured["messages"][0]["content"], user_text);
        assert!(!captured["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains('?'));

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["choices"][0]["message"]["content"], "pong");
    }

    #[tokio::test]
    async fn v1_chat_completions_stream_forwards_sse_chunks() {
        let (upstream_base_url, _upstream_task) = spawn_openai_chat_mock().await;
        let (server, db) = build_test_server();
        db.save_provider(
            "hermes",
            &Provider::with_id(
                "selected".to_string(),
                "Selected".to_string(),
                json!({
                    "base_url": upstream_base_url,
                    "api_key": "sk-selected",
                    "models": ["visible-model"]
                }),
                None,
            ),
        )
        .expect("save provider");
        let generated = external_openai_api::regenerate_api_key(&db).expect("generate key");
        external_openai_api::update_profile(
            &db,
            ExternalOpenAiApiProfileUpdate {
                enabled: true,
                backend_type: ExternalOpenAiApiBackendType::Provider,
                app_type: Some("hermes".to_string()),
                provider_id: Some("selected".to_string()),
                route_id: None,
                default_model: Some("visible-model".to_string()),
                listen_address: None,
                listen_port: None,
            },
        )
        .expect("enable profile");

        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/chat/completions")
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", generated.api_key),
                    )
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "visible-model",
                            "stream": true,
                            "messages": [{ "role": "user", "content": "ping" }]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&http::HeaderValue::from_static("text/event-stream"))
        );
        let body = response
            .into_body()
            .collect()
            .await
            .expect("collect stream")
            .to_bytes();
        let text = String::from_utf8(body.to_vec()).expect("utf8 stream");

        assert!(text.contains("\"object\":\"chat.completion.chunk\""));
        assert!(text.contains("\"content\":\"pong\""));
        assert!(text.contains("data: [DONE]"));
    }

    #[tokio::test]
    async fn v1_responses_requires_external_api_key_for_non_codex_clients() {
        let (server, _db) = build_test_server();
        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/responses")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "visible-model",
                            "input": "ping"
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let body = response_json(response).await;
        assert_eq!(body["error"]["type"], "authentication_error");
        assert_eq!(body["error"]["code"], "external_openai_api_disabled");
    }

    #[tokio::test]
    async fn v1_responses_websocket_probe_returns_http_426() {
        let (server, _db) = build_test_server();
        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/v1/responses")
                    .header(header::CONNECTION, "Upgrade")
                    .header(header::UPGRADE, "websocket")
                    .header(header::SEC_WEBSOCKET_VERSION, "13")
                    .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "responses_websocket_not_supported");
    }

    #[tokio::test]
    async fn v1_responses_converts_to_chat_only_backend() {
        let (upstream_base_url, _upstream_task) = spawn_openai_chat_mock().await;
        let (server, db) = build_test_server();
        db.save_provider(
            "hermes",
            &Provider::with_id(
                "selected".to_string(),
                "Selected".to_string(),
                json!({
                    "base_url": upstream_base_url,
                    "api_key": "sk-selected",
                    "models": ["visible-model"]
                }),
                None,
            ),
        )
        .expect("save provider");
        let generated = external_openai_api::regenerate_api_key(&db).expect("generate key");
        external_openai_api::update_profile(
            &db,
            ExternalOpenAiApiProfileUpdate {
                enabled: true,
                backend_type: ExternalOpenAiApiBackendType::Provider,
                app_type: Some("hermes".to_string()),
                provider_id: Some("selected".to_string()),
                route_id: None,
                default_model: Some("visible-model".to_string()),
                listen_address: None,
                listen_port: None,
            },
        )
        .expect("enable profile");

        let response = server
            .build_router()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/responses")
                    .header(
                        header::AUTHORIZATION,
                        format!("Bearer {}", generated.api_key),
                    )
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "model": "visible-model",
                            "input": "ping"
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["object"], "response");
        assert_eq!(body["output"][0]["type"], "message");
        assert_eq!(body["output"][0]["content"][0]["text"], "pong");
    }

    /// 启动一个只服务 OpenAI Chat Completions 的本地 mock upstream。
    async fn spawn_openai_chat_mock() -> (String, tokio::task::JoinHandle<()>) {
        spawn_openai_chat_mock_with_capture(Arc::new(Mutex::new(None))).await
    }

    /// 启动一个会保存最近一次请求体的 OpenAI Chat mock，用于断言代理转发前后文本不变。
    async fn spawn_openai_chat_mock_with_capture(
        captured_body: Arc<Mutex<Option<Value>>>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |Json(body): Json<Value>| {
                let captured_body = captured_body.clone();
                async move {
                    *captured_body.lock().expect("capture upstream body") = Some(body.clone());
                    if body.get("stream").and_then(|value| value.as_bool()) == Some(true) {
                        return (
                            [(header::CONTENT_TYPE, "text/event-stream")],
                            "data: {\"id\":\"chatcmpl_mock\",\"object\":\"chat.completion.chunk\",\"created\":0,\"model\":\"visible-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"pong\"},\"finish_reason\":null}]}\n\n\
                             data: [DONE]\n\n",
                        )
                            .into_response();
                    }
                    Json(json!({
                        "id": "chatcmpl_mock",
                        "object": "chat.completion",
                        "created": 0,
                        "model": "visible-model",
                        "choices": [{
                            "index": 0,
                            "message": { "role": "assistant", "content": "pong" },
                            "finish_reason": "stop"
                        }],
                        "usage": {
                            "prompt_tokens": 1,
                            "completion_tokens": 1,
                            "total_tokens": 2
                        }
                    }))
                    .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock upstream");
        let addr = listener.local_addr().expect("mock upstream addr");
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("mock upstream serve");
        });
        (format!("http://{addr}/v1"), task)
    }
}
