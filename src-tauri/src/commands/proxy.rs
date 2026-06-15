//! 代理服务相关的 Tauri 命令
//!
//! 提供前端调用的 API 接口

use crate::error::AppError;
use crate::provider::Provider;
use crate::proxy::external_openai_api::{
    self, ExternalOpenAiApiProfileUpdate, ExternalOpenAiApiProfileView,
    ExternalOpenAiApiRuntimeStatusView, GeneratedExternalOpenAiApiKey,
};
use crate::proxy::types::*;
use crate::proxy::{CircuitBreakerConfig, CircuitBreakerStats};
use crate::store::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;
use std::time::{Duration, SystemTime};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Codex MultiRouter 单项诊断状态。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexDiagnosticStatus {
    Pass,
    Warn,
    Fail,
    Info,
}

/// Codex MultiRouter 单项诊断结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDiagnosticCheck {
    pub id: String,
    pub label: String,
    pub status: CodexDiagnosticStatus,
    pub detail: String,
    pub evidence: Vec<String>,
}

/// `~/.codex/config.toml` 中与本地路由相关的现场配置摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLiveConfigDiagnostics {
    pub path: String,
    pub exists: bool,
    pub config_modified_at: Option<String>,
    pub parse_error: Option<String>,
    pub model_provider: Option<String>,
    pub active_base_url: Option<String>,
    pub openai_base_url: Option<String>,
    pub provider_base_url: Option<String>,
    pub supports_websockets: Option<bool>,
    pub wire_api: Option<String>,
    pub model_catalog_json: Option<String>,
    pub model_catalog_path: Option<String>,
    pub model_catalog_modified_at: Option<String>,
    pub model_catalog_model_count: Option<usize>,
    pub model_catalog_first_models: Option<Vec<String>>,
    pub spawn_agent_visible_model_limit: usize,
    pub spawn_agent_missing_priority_models: Vec<String>,
    pub uses_builtin_openai_with_local_base: bool,
    pub points_to_local_proxy: bool,
}

/// Codex Desktop/app-server runtime state that can explain stale model picker data.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerProcessDiagnostics {
    pub pid: u32,
    pub name: Option<String>,
    pub executable_path: Option<String>,
    pub command_line: Option<String>,
    pub started_at: Option<String>,
    pub is_app_server: bool,
}

/// Codex Desktop runtime summary used to detect catalog changes after startup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDesktopRuntimeDiagnostics {
    pub running: bool,
    pub app_server_running: bool,
    pub remote_debugging_enabled: bool,
    pub remote_debugging_port: Option<u16>,
    pub model_picker_patchable: bool,
    pub process_count: usize,
    pub app_server_count: usize,
    pub processes: Vec<CodexAppServerProcessDiagnostics>,
    pub newest_app_server_started_at: Option<String>,
    pub may_have_stale_model_catalog: bool,
    pub stale_reason: Option<String>,
    pub detection_error: Option<String>,
}

/// 单条 `codex-router.log` 事件的清洗后展示结构。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRouterLogEvent {
    pub timestamp: String,
    pub event: String,
    pub route_id: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub outer_provider: Option<String>,
    pub effective_provider: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
    pub line: String,
}

/// Codex router 诊断日志的聚合摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRouterLogDiagnostics {
    pub path: String,
    pub exists: bool,
    pub total_scanned: usize,
    pub matched_scanned: usize,
    pub has_recent_request: bool,
    pub latest_request_at: Option<String>,
    pub latest_error: Option<String>,
    pub recent_events: Vec<CodexRouterLogEvent>,
}

pub use crate::codex_desktop::CodexModelPickerUnlockResult;

/// 单条 MultiRouter route 的可读摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRouteSummary {
    pub id: Option<String>,
    pub label: Option<String>,
    pub enabled: bool,
    pub target_provider_id: Option<String>,
    pub target_provider_name: Option<String>,
    pub target_exists: bool,
    pub api_format: Option<String>,
    pub base_url: Option<String>,
    pub models: Vec<String>,
    pub prefixes: Vec<String>,
}

/// MultiRouter provider 内 `codexRouting` 的摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRoutePlanDiagnostics {
    pub provider_id: Option<String>,
    pub provider_name: Option<String>,
    pub exists: bool,
    pub routing_enabled: bool,
    pub route_count: usize,
    pub enabled_route_count: usize,
    pub default_route_id: Option<String>,
    pub route_summaries: Vec<CodexRouteSummary>,
}

/// Codex MultiRouter 一键诊断的完整返回值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMultiRouterDiagnostics {
    pub generated_at: String,
    pub ready: bool,
    pub next_action: String,
    pub blocking_issues: Vec<String>,
    pub warnings: Vec<String>,
    pub checks: Vec<CodexDiagnosticCheck>,
    pub proxy_status: ProxyStatus,
    pub takeover: ProxyTakeoverStatus,
    pub live_config: CodexLiveConfigDiagnostics,
    pub desktop_runtime: CodexDesktopRuntimeDiagnostics,
    pub router_log: CodexRouterLogDiagnostics,
    pub route_plan: CodexRoutePlanDiagnostics,
}

/// 启动代理服务器（仅启动服务，不接管 Live 配置）
#[tauri::command]
pub async fn start_proxy_server(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyServerInfo, String> {
    state.proxy_service.start().await
}

/// 停止代理服务器（仅停止服务，不恢复/清理 Live 接管状态）
#[tauri::command]
pub async fn stop_proxy_server(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let takeover = state.proxy_service.get_takeover_status().await?;
    if takeover.claude
        || takeover.codex
        || takeover.gemini
        || takeover.opencode
        || takeover.openclaw
    {
        return Err(
            "仍有应用处于代理接管状态，请先在设置中关闭对应应用接管后再停止本地路由。".to_string(),
        );
    }

    state.proxy_service.stop().await
}

/// 停止代理服务器（恢复 Live 配置）
#[tauri::command]
pub async fn stop_proxy_with_restore(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.proxy_service.stop_with_restore().await
}

/// 获取各应用接管状态
#[tauri::command]
pub async fn get_proxy_takeover_status(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyTakeoverStatus, String> {
    state.proxy_service.get_takeover_status().await
}

/// 为指定应用开启/关闭接管
#[tauri::command]
pub async fn set_proxy_takeover_for_app(
    state: tauri::State<'_, AppState>,
    app_type: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .proxy_service
        .set_takeover_for_app(&app_type, enabled)
        .await
}

/// 获取代理服务器状态
#[tauri::command]
pub async fn get_proxy_status(state: tauri::State<'_, AppState>) -> Result<ProxyStatus, String> {
    state.proxy_service.get_status().await
}

/// 运行 Codex MultiRouter 一键诊断。
///
/// 该命令只读取本机配置、探测本地代理端口和读取本地 router 日志；不会向真实上游发送
/// `/v1/responses` POST，也不会改写 Codex/CCSwitch 配置。
#[tauri::command]
pub async fn diagnose_codex_multirouter(
    state: tauri::State<'_, AppState>,
    provider_id: Option<String>,
) -> Result<CodexMultiRouterDiagnostics, String> {
    let proxy_status = state.proxy_service.get_status().await?;
    let proxy_config = state.proxy_service.get_config().await?;
    let takeover = state.proxy_service.get_takeover_status().await?;
    let live_taken_over = state
        .proxy_service
        .detect_takeover_in_live_config_for_app(&crate::app_config::AppType::Codex);

    let probe_host = codex_diagnostic_connect_host(if proxy_status.address.trim().is_empty() {
        &proxy_config.listen_address
    } else {
        &proxy_status.address
    });
    let probe_port = if proxy_status.port > 0 {
        proxy_status.port
    } else {
        proxy_config.listen_port
    };
    let (socket_ok, socket_detail) = codex_probe_tcp(&probe_host, probe_port).await;
    let (websocket_status, websocket_detail) =
        codex_probe_websocket_fallback(&probe_host, probe_port).await;

    let live_config = codex_live_config_diagnostics(probe_port);
    let route_plan = codex_route_plan_diagnostics(&state, provider_id.as_deref())?;
    let router_log = codex_router_log_diagnostics(route_plan.provider_id.as_deref());
    let desktop_runtime = codex_desktop_runtime_diagnostics(&live_config);

    let mut checks = Vec::new();
    checks.push(codex_check(
        "proxy_running",
        "本地代理进程",
        if proxy_status.running {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Fail
        },
        if proxy_status.running {
            "代理服务已运行。"
        } else {
            "代理服务未运行；Codex 不可能进入 MultiRouter。"
        },
        vec![format!(
            "status={}:{} running={}",
            proxy_status.address, proxy_status.port, proxy_status.running
        )],
    ));
    checks.push(codex_check(
        "socket_connect",
        "本地端口可达",
        if socket_ok {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Fail
        },
        socket_detail,
        vec![format!("{probe_host}:{probe_port}")],
    ));
    checks.push(codex_check(
        "websocket_fallback",
        "Responses WebSocket 回退",
        websocket_status,
        websocket_detail,
        vec!["GET /v1/responses + Upgrade: websocket".to_string()],
    ));
    checks.push(codex_check(
        "codex_takeover",
        "Codex live 接管",
        if takeover.codex && live_taken_over {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Fail
        },
        if takeover.codex && live_taken_over {
            "数据库接管状态和 live config 现场状态一致。"
        } else if takeover.codex && !live_taken_over {
            "数据库显示已接管，但 live config 现场没有指向本地 MultiRouter。"
        } else {
            "Codex 当前没有被 CC Switch MultiRouter 接管。"
        },
        vec![
            format!("takeover.codex={}", takeover.codex),
            format!("live_detected={live_taken_over}"),
        ],
    ));
    checks.push(codex_check(
        "live_model_provider",
        "Codex provider 写法",
        codex_live_model_provider_status(&live_config),
        codex_live_model_provider_detail(&live_config),
        vec![
            format!("model_provider={:?}", live_config.model_provider),
            format!(
                "provider_bucket={}",
                codex_live_model_provider_bucket(&live_config)
            ),
            format!("openai_base_url={:?}", live_config.openai_base_url),
        ],
    ));
    checks.push(codex_check(
        "live_base_url",
        "Codex base_url",
        if live_config.points_to_local_proxy {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Fail
        },
        if live_config.points_to_local_proxy {
            "active base_url 指向当前本地代理端口。"
        } else {
            "active base_url 没有指向当前本地代理端口；请求不会进入 MultiRouter。"
        },
        vec![format!("active_base_url={:?}", live_config.active_base_url)],
    ));
    checks.push(codex_check(
        "live_websocket_disabled",
        "Codex WebSocket 策略",
        if live_config.supports_websockets == Some(false) {
            CodexDiagnosticStatus::Pass
        } else if live_config.supports_websockets == Some(true) {
            CodexDiagnosticStatus::Fail
        } else {
            CodexDiagnosticStatus::Warn
        },
        if live_config.supports_websockets == Some(false) {
            "live config 已禁用 Responses WebSocket，Codex 应直接走 HTTP Responses。"
        } else if live_config.supports_websockets == Some(true) {
            "live config 仍允许 Responses WebSocket，可能再次出现 WS 断开类错误。"
        } else {
            "live config 未显式声明 supports_websockets=false；建议重新接管写入 codex_model_router_v2 provider。"
        },
        vec![format!(
            "supports_websockets={:?}",
            live_config.supports_websockets
        )],
    ));
    checks.push(codex_check(
        "route_plan",
        "MultiRouter 规则",
        if route_plan.exists && route_plan.routing_enabled && route_plan.enabled_route_count > 0 {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Fail
        },
        if route_plan.exists && route_plan.routing_enabled && route_plan.enabled_route_count > 0 {
            "已找到启用的 MultiRouter provider 和匹配规则。"
        } else if !route_plan.exists {
            "当前页面选择的 MultiRouter provider 在数据库中不存在。"
        } else if !route_plan.routing_enabled {
            "MultiRouter 入口已关闭。"
        } else {
            "MultiRouter 没有启用的 route。"
        },
        vec![
            format!("provider_id={:?}", route_plan.provider_id),
            format!(
                "enabled_routes={}/{}",
                route_plan.enabled_route_count, route_plan.route_count
            ),
        ],
    ));
    checks.push(codex_check(
        "recent_router_events",
        "近期路由日志",
        if router_log.has_recent_request {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Warn
        },
        if router_log.has_recent_request {
            "已看到近期请求进入 Codex router 转发链路。"
        } else {
            "未看到近期请求进入 Codex router；如果你刚刚在 Codex 发过请求，优先检查 live config 是否被接管。"
        },
        vec![
            format!("log_exists={}", router_log.exists),
            format!("events_scanned={}", router_log.total_scanned),
            format!("matched_events={}", router_log.matched_scanned),
        ],
    ));
    checks.push(codex_check(
        "codex_desktop_runtime",
        "Codex Desktop runtime",
        if desktop_runtime.may_have_stale_model_catalog {
            CodexDiagnosticStatus::Warn
        } else {
            CodexDiagnosticStatus::Info
        },
        desktop_runtime.stale_reason.clone().unwrap_or_else(|| {
            if desktop_runtime.app_server_running {
                "Codex app-server is running; compare startup time with config/catalog mtimes when the picker looks stale.".to_string()
            } else if desktop_runtime.running {
                "Codex Desktop process is running, but no app-server command line was detected.".to_string()
            } else {
                "No running Codex Desktop/app-server process was detected.".to_string()
            }
        }),
        vec![
            format!(
                "processes={} app_servers={}",
                desktop_runtime.process_count, desktop_runtime.app_server_count
            ),
            format!(
                "newest_app_server_started_at={:?}",
                desktop_runtime.newest_app_server_started_at
            ),
            format!(
                "catalog_modified_at={:?}",
                live_config.model_catalog_modified_at
            ),
        ],
    ));
    checks.push(codex_check(
        "codex_model_picker_whitelist",
        "Codex Desktop 模型菜单白名单",
        if desktop_runtime.remote_debugging_enabled {
            CodexDiagnosticStatus::Pass
        } else if desktop_runtime.running {
            CodexDiagnosticStatus::Warn
        } else {
            CodexDiagnosticStatus::Info
        },
        if desktop_runtime.remote_debugging_enabled {
            "Codex Desktop 已带 CDP 端口启动，CCSwitchMulti 可以向 renderer 注入 Statsig 107580212 模型白名单补丁。".to_string()
        } else if desktop_runtime.running {
            "Codex Desktop 正在以普通方式运行；即使 config/catalog/cache 有完整模型，renderer 仍可能被 Statsig 107580212 的 available_models 白名单压回 3 个官方模型。请完全退出 Codex 后用“解锁模型菜单”启动。".to_string()
        } else {
            "Codex Desktop 未运行；点击“解锁模型菜单”会用 remote debugging 参数启动 Codex 并注入模型候选补丁。".to_string()
        },
        vec![
            format!(
                "remote_debugging_enabled={}",
                desktop_runtime.remote_debugging_enabled
            ),
            format!("remote_debugging_port={:?}", desktop_runtime.remote_debugging_port),
            format!(
                "model_catalog_models={:?}",
                live_config.model_catalog_model_count
            ),
            "renderer_filter=Statsig 107580212 available_models/use_hidden_models".to_string(),
        ],
    ));
    checks.push(codex_check(
        "codex_spawn_agent_model_overrides",
        "Codex spawn_agent model overrides",
        if live_config.spawn_agent_missing_priority_models.is_empty() {
            CodexDiagnosticStatus::Pass
        } else {
            CodexDiagnosticStatus::Warn
        },
        if live_config.spawn_agent_missing_priority_models.is_empty() {
            "Priority routed models are inside the first five picker-visible models used by Codex spawn_agent tool descriptions.".to_string()
        } else {
            format!(
                "Codex 0.137.0 only describes the first {} picker-visible models in spawn_agent. Regenerate the CCSwitchMulti catalog so these models move into that window: {}.",
                live_config.spawn_agent_visible_model_limit,
                live_config.spawn_agent_missing_priority_models.join(", ")
            )
        },
        vec![
            format!(
                "spawn_agent_visible_model_limit={}",
                live_config.spawn_agent_visible_model_limit
            ),
            format!(
                "catalog_first_models={:?}",
                live_config.model_catalog_first_models
            ),
            format!(
                "missing_priority_models={:?}",
                live_config.spawn_agent_missing_priority_models
            ),
        ],
    ));
    checks.push(codex_check(
        "recent_router_error",
        "近期路由错误",
        if router_log.latest_error.is_some() {
            CodexDiagnosticStatus::Fail
        } else {
            CodexDiagnosticStatus::Pass
        },
        router_log
            .latest_error
            .clone()
            .unwrap_or_else(|| "未发现近期 router 错误事件。".to_string()),
        vec![],
    ));

    let blocking_issues = checks
        .iter()
        .filter(|check| check.status == CodexDiagnosticStatus::Fail)
        .map(|check| format!("{}：{}", check.label, check.detail))
        .collect::<Vec<_>>();
    let warnings = checks
        .iter()
        .filter(|check| check.status == CodexDiagnosticStatus::Warn)
        .map(|check| format!("{}：{}", check.label, check.detail))
        .collect::<Vec<_>>();
    let ready = blocking_issues.is_empty();
    let next_action = codex_next_action(&checks, &router_log);

    Ok(CodexMultiRouterDiagnostics {
        generated_at: chrono::Local::now().to_rfc3339(),
        ready,
        next_action,
        blocking_issues,
        warnings,
        checks,
        proxy_status,
        takeover,
        live_config,
        desktop_runtime,
        router_log,
        route_plan,
    })
}

/// 用 Codex++ 同类的 CDP 注入方式，把 CCSwitchMulti catalog 写进 Desktop renderer 白名单。
///
/// 该命令不会修改 auth.json，也不会改变 MultiRouter 路由；它只在 Codex Desktop
/// renderer 内修正模型候选列表过滤。若 Codex 已经以普通方式启动，需要先完全退出
/// Codex，再由该命令启动带 remote debugging 参数的新实例。
#[tauri::command]
pub async fn unlock_codex_model_picker() -> Result<CodexModelPickerUnlockResult, String> {
    crate::codex_desktop::unlock_codex_model_picker().await
}

/// 显式把 Codex 历史 provider 桶同步到 MultiRouter 的 `custom` 运行桶。
///
/// 该命令会备份并重写本机 Codex session/jsonl 与 state sqlite；前端必须由用户主动触发，
/// 不能在启动或诊断时自动执行。
#[tauri::command]
pub async fn sync_codex_history_to_multirouter(
    state: tauri::State<'_, AppState>,
) -> Result<crate::codex_history_migration::CodexHistoryProviderBucketMigrationOutcome, String> {
    crate::codex_history_migration::sync_codex_history_provider_bucket_to_multirouter(
        state.db.as_ref(),
    )
    .map_err(|error| error.to_string())
}

/// 修复当前 Codex Desktop 历史侧边栏可见性；调用方应先 dry-run，再由用户确认 apply。
#[tauri::command]
pub async fn repair_codex_history_visibility(
    state: tauri::State<'_, AppState>,
    options: Option<crate::codex_history_migration::CodexHistoryVisibilityRepairOptions>,
) -> Result<crate::codex_history_migration::CodexHistoryVisibilityRepairOutcome, String> {
    crate::codex_history_migration::repair_codex_history_visibility_for_multirouter(
        state.db.as_ref(),
        options.unwrap_or_default(),
    )
    .map_err(|error| error.to_string())
}

/// 列出当前 Codex active SQLite 中的历史会话摘要，供前端勾选定向修复。
#[tauri::command]
pub async fn list_codex_history_sessions(
    options: Option<crate::codex_history_migration::CodexHistorySessionListOptions>,
) -> Result<crate::codex_history_migration::CodexHistorySessionListOutcome, String> {
    crate::codex_history_migration::list_codex_history_sessions(options.unwrap_or_default())
        .map_err(|error| error.to_string())
}

/// 构造诊断检查项，统一字符串转换和证据字段。
fn codex_check(
    id: &str,
    label: &str,
    status: CodexDiagnosticStatus,
    detail: impl Into<String>,
    evidence: Vec<String>,
) -> CodexDiagnosticCheck {
    CodexDiagnosticCheck {
        id: id.to_string(),
        label: label.to_string(),
        status,
        detail: detail.into(),
        evidence,
    }
}

/// 判断 live config 是否使用当前稳定的 Codex MultiRouter provider 桶。
fn codex_live_model_provider_is_stable_router(live_config: &CodexLiveConfigDiagnostics) -> bool {
    live_config.model_provider.as_deref()
        == Some(crate::codex_config::CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID)
}

/// 判断 live config 是否仍在使用旧版 MultiRouter provider 桶。
fn codex_live_model_provider_is_legacy_router(live_config: &CodexLiveConfigDiagnostics) -> bool {
    live_config.model_provider.as_deref() == Some("cc_switch_codex_router")
}

/// MultiRouter provider 桶诊断：稳定桶通过，旧桶或 custom 给出警告，内置 openai 本地化失败。
fn codex_live_model_provider_status(
    live_config: &CodexLiveConfigDiagnostics,
) -> CodexDiagnosticStatus {
    if live_config.uses_builtin_openai_with_local_base {
        CodexDiagnosticStatus::Fail
    } else if codex_live_model_provider_is_stable_router(live_config) {
        CodexDiagnosticStatus::Pass
    } else {
        CodexDiagnosticStatus::Warn
    }
}

/// 生成 provider 桶诊断说明，避免把稳定 router 桶误写成 custom。
fn codex_live_model_provider_detail(live_config: &CodexLiveConfigDiagnostics) -> &'static str {
    if live_config.uses_builtin_openai_with_local_base {
        "live config 仍用内置 openai provider 指向本地地址，这会触发 Codex 官方 WebSocket/OpenAI 语义。"
    } else if codex_live_model_provider_is_stable_router(live_config) {
        "live config 使用稳定的 codex_model_router_v2 MultiRouter provider 桶。"
    } else if codex_live_model_provider_is_legacy_router(live_config) {
        "live config 使用旧的 cc_switch_codex_router 桶；建议用当前构建重新接管以回到 codex_model_router_v2。"
    } else if live_config.model_provider.as_deref() == Some("custom") {
        "live config 使用 custom 桶；这可避免内置 OpenAI WebSocket，但不符合当前 MultiRouter 历史桶约定。"
    } else {
        "live config 当前不是 CC Switch MultiRouter provider 桶。"
    }
}

/// 给诊断证据提供稳定的 provider 桶分类，方便对比运行 exe 与当前 HEAD。
fn codex_live_model_provider_bucket(live_config: &CodexLiveConfigDiagnostics) -> &'static str {
    if live_config.uses_builtin_openai_with_local_base {
        "builtin_openai_local_base"
    } else if codex_live_model_provider_is_stable_router(live_config) {
        "stable_router"
    } else if codex_live_model_provider_is_legacy_router(live_config) {
        "legacy_router"
    } else if live_config.model_provider.as_deref() == Some("custom") {
        "custom"
    } else {
        "other"
    }
}

/// 根据监听地址生成本机可连接地址；`0.0.0.0` 只能监听，不能作为客户端目标。
fn codex_diagnostic_connect_host(listen_address: &str) -> String {
    match listen_address.trim() {
        "" | "0.0.0.0" => "127.0.0.1".to_string(),
        "::" => "::1".to_string(),
        value => value.trim_matches(['[', ']']).to_string(),
    }
}

/// 将 host 转成可拼接进 HTTP URL 的形式，IPv6 地址需要方括号。
fn codex_diagnostic_url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// 探测本地代理 TCP 端口是否可连接。
async fn codex_probe_tcp(host: &str, port: u16) -> (bool, String) {
    match timeout(Duration::from_secs(2), TcpStream::connect((host, port))).await {
        Ok(Ok(_stream)) => (true, "TCP 连接成功。".to_string()),
        Ok(Err(err)) => (false, format!("TCP 连接失败：{err}")),
        Err(_) => (false, "TCP 连接超时。".to_string()),
    }
}

/// 探测本地代理对 Responses WebSocket 是否返回 426 回退。
async fn codex_probe_websocket_fallback(host: &str, port: u16) -> (CodexDiagnosticStatus, String) {
    let url = format!(
        "http://{}:{}/v1/responses",
        codex_diagnostic_url_host(host),
        port
    );
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            return (
                CodexDiagnosticStatus::Warn,
                format!("创建本地探针客户端失败：{err}"),
            )
        }
    };
    let response = client
        .get(url)
        .header(reqwest::header::CONNECTION, "Upgrade")
        .header(reqwest::header::UPGRADE, "websocket")
        .header("OpenAI-Beta", "responses_websockets=2026-02-06")
        .send()
        .await;

    match response {
        Ok(response) if response.status().as_u16() == 426 => (
            CodexDiagnosticStatus::Pass,
            "本地代理对 Responses WebSocket 返回 426，HTTP 回退路径正常。".to_string(),
        ),
        Ok(response) => (
            CodexDiagnosticStatus::Warn,
            format!(
                "本地代理 WebSocket 探针返回 HTTP {}，预期是 426。",
                response.status().as_u16()
            ),
        ),
        Err(err) => (
            CodexDiagnosticStatus::Fail,
            format!("本地代理 WebSocket 探针失败：{err}"),
        ),
    }
}

/// 读取并解析 Codex live config 中 MultiRouter 必需字段。
fn codex_live_config_diagnostics(proxy_port: u16) -> CodexLiveConfigDiagnostics {
    let path = crate::codex_config::get_codex_config_path();
    let path_text = path.display().to_string();
    let exists = path.exists();
    let config_modified_at = file_modified_at(&path);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) => {
            return CodexLiveConfigDiagnostics {
                path: path_text,
                exists,
                config_modified_at,
                parse_error: Some(format!("读取失败：{err}")),
                model_provider: None,
                active_base_url: None,
                openai_base_url: None,
                provider_base_url: None,
                supports_websockets: None,
                wire_api: None,
                model_catalog_json: None,
                model_catalog_path: None,
                model_catalog_modified_at: None,
                model_catalog_model_count: None,
                model_catalog_first_models: None,
                spawn_agent_visible_model_limit: CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
                spawn_agent_missing_priority_models: Vec::new(),
                uses_builtin_openai_with_local_base: false,
                points_to_local_proxy: false,
            };
        }
    };

    let parsed = match text.parse::<toml::Value>() {
        Ok(parsed) => parsed,
        Err(err) => {
            return CodexLiveConfigDiagnostics {
                path: path_text,
                exists,
                parse_error: Some(format!("TOML 解析失败：{err}")),
                config_modified_at,
                model_provider: None,
                active_base_url: crate::codex_config::extract_codex_base_url(&text),
                openai_base_url: None,
                provider_base_url: None,
                supports_websockets: None,
                wire_api: None,
                model_catalog_json: None,
                model_catalog_path: None,
                model_catalog_modified_at: None,
                model_catalog_model_count: None,
                model_catalog_first_models: None,
                spawn_agent_visible_model_limit: CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
                spawn_agent_missing_priority_models: Vec::new(),
                uses_builtin_openai_with_local_base: false,
                points_to_local_proxy: false,
            };
        }
    };

    let model_provider = parsed
        .get("model_provider")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let openai_base_url = parsed
        .get("openai_base_url")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let active_provider_table = model_provider.as_deref().and_then(|provider| {
        parsed
            .get("model_providers")
            .and_then(|providers| providers.get(provider))
    });
    let provider_base_url = active_provider_table
        .and_then(|provider| provider.get("base_url"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let active_base_url = provider_base_url
        .clone()
        .or_else(|| match model_provider.as_deref() {
            None | Some("openai") => openai_base_url.clone(),
            _ => None,
        })
        .or_else(|| crate::codex_config::extract_codex_base_url(&text));
    let supports_websockets = active_provider_table
        .and_then(|provider| provider.get("supports_websockets"))
        .and_then(|value| value.as_bool());
    let wire_api = active_provider_table
        .and_then(|provider| provider.get("wire_api"))
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    // Codex 官方只读取顶层 `model_catalog_json`。旧诊断只看 active provider 表，
    // 会把已经正确写入的 catalog 指针误判为缺失，导致状态页误导排查方向。
    let model_catalog_json = parsed
        .get("model_catalog_json")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .or_else(|| {
            active_provider_table
                .and_then(|provider| provider.get("model_catalog_json"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string)
        });
    let model_catalog_path = model_catalog_json
        .as_deref()
        .map(|catalog| resolve_codex_catalog_path(&path, catalog));
    let model_catalog_modified_at = model_catalog_path.as_deref().and_then(file_modified_at);
    let model_catalog_models = model_catalog_path
        .as_deref()
        .and_then(read_codex_catalog_model_slugs);
    let model_catalog_model_count = model_catalog_models.as_ref().map(Vec::len);
    let model_catalog_first_models = model_catalog_models.as_ref().map(|models| {
        models
            .iter()
            .take(CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT)
            .cloned()
            .collect::<Vec<_>>()
    });
    let spawn_agent_missing_priority_models =
        missing_spawn_agent_priority_models(model_catalog_models.as_deref());
    let uses_builtin_openai_with_local_base = model_provider
        .as_deref()
        .is_none_or(|provider| provider.eq_ignore_ascii_case("openai"))
        && openai_base_url
            .as_deref()
            .is_some_and(|url| codex_url_points_to_local_proxy(url, proxy_port));
    let points_to_local_proxy = active_base_url
        .as_deref()
        .is_some_and(|url| codex_url_points_to_local_proxy(url, proxy_port));

    CodexLiveConfigDiagnostics {
        path: path_text,
        exists,
        config_modified_at,
        parse_error: None,
        model_provider,
        active_base_url,
        openai_base_url,
        provider_base_url,
        supports_websockets,
        wire_api,
        model_catalog_json,
        model_catalog_path: model_catalog_path.map(|path| path.display().to_string()),
        model_catalog_modified_at,
        model_catalog_model_count,
        model_catalog_first_models,
        spawn_agent_visible_model_limit: CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
        spawn_agent_missing_priority_models,
        uses_builtin_openai_with_local_base,
        points_to_local_proxy,
    }
}

/// 读取文件修改时间并格式化为诊断面板可显示的时间戳。
fn file_modified_at(path: &Path) -> Option<String> {
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(system_time_to_rfc3339)
}

/// 将 SystemTime 转成 RFC3339，便于前端展示和人工比对。
fn system_time_to_rfc3339(time: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Local> = time.into();
    datetime.to_rfc3339()
}

/// 按 Codex 规则把相对 model_catalog_json 解析到 config 所在目录。
fn resolve_codex_catalog_path(config_path: &Path, catalog: &str) -> PathBuf {
    let catalog_path = PathBuf::from(catalog);
    if catalog_path.is_absolute() {
        catalog_path
    } else {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new(""))
            .join(catalog_path)
    }
}

const CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT: usize = 5;
const CODEX_SPAWN_AGENT_PRIORITY_MODELS: &[&str] =
    &["qwen3.6", "deepseek-v4-flash", "deepseek-v4-pro"];

/// 读取生成 catalog 的模型顺序；Codex spawn_agent 工具说明会按该顺序截取前 5 个。
fn read_codex_catalog_model_slugs(path: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&text).ok()?;
    value
        .get("models")
        .and_then(|models| models.as_array())
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("slug").and_then(|slug| slug.as_str()))
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
}

/// 找出已经写入 catalog、但会被 Codex spawn_agent 前 5 展示限制截掉的重点路由模型。
fn missing_spawn_agent_priority_models(models: Option<&[String]>) -> Vec<String> {
    let Some(models) = models else {
        return Vec::new();
    };
    let visible_models = models
        .iter()
        .take(CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT)
        .map(String::as_str)
        .collect::<Vec<_>>();

    CODEX_SPAWN_AGENT_PRIORITY_MODELS
        .iter()
        .filter(|model| {
            models.iter().any(|candidate| candidate == **model)
                && !visible_models.iter().any(|candidate| candidate == *model)
        })
        .map(|model| (*model).to_string())
        .collect()
}

/// 查询 Codex Desktop/app-server 运行态，并与 catalog 写入时间做保守对比。
fn codex_desktop_runtime_diagnostics(
    live_config: &CodexLiveConfigDiagnostics,
) -> CodexDesktopRuntimeDiagnostics {
    let (processes, detection_error) = query_codex_processes();
    let app_server_count = processes
        .iter()
        .filter(|process| process.is_app_server)
        .count();
    let remote_debugging_port = processes
        .iter()
        .filter_map(|process| {
            remote_debugging_port_from_command_line(process.command_line.as_deref()?)
        })
        .next();
    let remote_debugging_enabled = remote_debugging_port.is_some();
    let newest_app_server_started_at = processes
        .iter()
        .filter(|process| process.is_app_server)
        .filter_map(|process| process.started_at.as_deref())
        .filter_map(parse_rfc3339_to_local)
        .max()
        .map(|started_at| started_at.to_rfc3339());

    let catalog_or_config_modified_at = [
        live_config.config_modified_at.as_deref(),
        live_config.model_catalog_modified_at.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(parse_rfc3339_to_local)
    .max();
    let app_server_started_at = newest_app_server_started_at
        .as_deref()
        .and_then(parse_rfc3339_to_local);
    let may_have_stale_model_catalog = app_server_started_at
        .zip(catalog_or_config_modified_at)
        .is_some_and(|(started_at, modified_at)| started_at < modified_at);
    let stale_reason = if may_have_stale_model_catalog {
        Some(
            "Codex app-server started before the latest config/catalog write, so its in-memory model manager may still expose the old picker list.".to_string(),
        )
    } else {
        None
    };

    CodexDesktopRuntimeDiagnostics {
        running: !processes.is_empty(),
        app_server_running: app_server_count > 0,
        remote_debugging_enabled,
        remote_debugging_port,
        model_picker_patchable: processes.is_empty() || remote_debugging_enabled,
        process_count: processes.len(),
        app_server_count,
        processes,
        newest_app_server_started_at,
        may_have_stale_model_catalog,
        stale_reason,
        detection_error,
    }
}

/// 从 Codex/Electron 命令行中提取 CDP 端口，用于判断 renderer 白名单能否被注入。
fn remote_debugging_port_from_command_line(command_line: &str) -> Option<u16> {
    command_line
        .split_whitespace()
        .find_map(|part| part.strip_prefix("--remote-debugging-port="))
        .and_then(|value| value.parse::<u16>().ok())
}

/// 解析诊断时间戳，用于判断 app-server 是否早于配置或 catalog 写入。
fn parse_rfc3339_to_local(text: &str) -> Option<chrono::DateTime<chrono::Local>> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|datetime| datetime.with_timezone(&chrono::Local))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawWindowsCodexProcess {
    process_id: Option<u32>,
    name: Option<String>,
    executable_path: Option<String>,
    command_line: Option<String>,
    started_at: Option<String>,
}

/// 通过 Windows CIM 读取 Codex 进程；非 Windows 构建返回空快照。
fn query_codex_processes() -> (Vec<CodexAppServerProcessDiagnostics>, Option<String>) {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'codex.exe'" |
  Select-Object ProcessId,Name,ExecutablePath,CommandLine,@{Name='StartedAt';Expression={$_.CreationDate.ToLocalTime().ToString('o')}} |
  ConvertTo-Json -Compress
"#;
        let output = match Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
        {
            Ok(output) => output,
            Err(err) => return (Vec::new(), Some(format!("PowerShell failed: {err}"))),
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return (
                Vec::new(),
                Some(if stderr.is_empty() {
                    format!("PowerShell exited with {}", output.status)
                } else {
                    stderr
                }),
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            return (Vec::new(), None);
        }
        let raw_value = match serde_json::from_str::<Value>(&stdout) {
            Ok(value) => value,
            Err(err) => {
                return (
                    Vec::new(),
                    Some(format!(
                        "Process JSON parse failed: {err}; payload={stdout}"
                    )),
                )
            }
        };
        let raw_processes = if raw_value.is_array() {
            serde_json::from_value::<Vec<RawWindowsCodexProcess>>(raw_value)
        } else {
            serde_json::from_value::<RawWindowsCodexProcess>(raw_value).map(|item| vec![item])
        };
        match raw_processes {
            Ok(processes) => (
                processes
                    .into_iter()
                    .map(|process| {
                        let command_line = process.command_line;
                        let is_app_server = command_line
                            .as_deref()
                            .is_some_and(|line| line.contains("app-server"));
                        CodexAppServerProcessDiagnostics {
                            pid: process.process_id.unwrap_or_default(),
                            name: process.name,
                            executable_path: process.executable_path,
                            command_line,
                            started_at: process.started_at,
                            is_app_server,
                        }
                    })
                    .collect(),
                None,
            ),
            Err(err) => (
                Vec::new(),
                Some(format!(
                    "Process JSON shape parse failed: {err}; payload={stdout}"
                )),
            ),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        (Vec::new(), None)
    }
}

/// 判断 URL 是否指向当前本地代理端口。
fn codex_url_points_to_local_proxy(url: &str, proxy_port: u16) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let is_local_host = matches!(host, "127.0.0.1" | "localhost" | "::1");
    is_local_host && parsed.port_or_known_default() == Some(proxy_port)
}

/// 读取当前页面选择的 MultiRouter provider，并汇总 `codexRouting` 规则。
fn codex_route_plan_diagnostics(
    state: &AppState,
    provider_id: Option<&str>,
) -> Result<CodexRoutePlanDiagnostics, String> {
    let selected_provider_id = provider_id
        .map(ToString::to_string)
        .or_else(|| state.db.get_current_provider("codex").ok().flatten());
    let provider = selected_provider_id
        .as_deref()
        .map(|id| {
            state
                .db
                .get_provider_by_id(id, "codex")
                .map_err(|err| format!("读取 Codex provider 失败：{err}"))
        })
        .transpose()?
        .flatten();

    let Some(provider) = provider else {
        return Ok(CodexRoutePlanDiagnostics {
            provider_id: selected_provider_id,
            provider_name: None,
            exists: false,
            routing_enabled: false,
            route_count: 0,
            enabled_route_count: 0,
            default_route_id: None,
            route_summaries: Vec::new(),
        });
    };

    let routing = provider.settings_config.get("codexRouting");
    let routing_enabled = routing
        .and_then(|value| value.get("enabled"))
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let routes = routing
        .and_then(|value| value.get("routes"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let default_route_id = routing
        .and_then(|value| {
            value
                .get("defaultRouteId")
                .or_else(|| value.get("default_route_id"))
        })
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let route_summaries = routes
        .iter()
        .map(|route| codex_route_summary(state, route))
        .collect::<Vec<_>>();
    let enabled_route_count = route_summaries.iter().filter(|route| route.enabled).count();

    Ok(CodexRoutePlanDiagnostics {
        provider_id: Some(provider.id),
        provider_name: Some(provider.name),
        exists: true,
        routing_enabled,
        route_count: route_summaries.len(),
        enabled_route_count,
        default_route_id,
        route_summaries,
    })
}

/// 将一条 route JSON 摘要成前端状态页可展示的信息。
fn codex_route_summary(state: &AppState, route: &Value) -> CodexRouteSummary {
    let target_provider_id = codex_route_target_provider_id(route);
    let target_provider = target_provider_id
        .as_deref()
        .and_then(|id| state.db.get_provider_by_id(id, "codex").ok().flatten());
    let upstream = route.get("upstream").unwrap_or(route);
    let api_format = target_provider
        .as_ref()
        .and_then(provider_api_format)
        .or_else(|| codex_first_json_string(upstream, &["wire_api", "wireApi", "apiFormat"]))
        .or_else(|| codex_first_json_string(route, &["wire_api", "wireApi", "apiFormat"]));
    let base_url = target_provider
        .as_ref()
        .and_then(provider_base_url)
        .or_else(|| {
            codex_first_json_string(upstream, &["baseUrl", "baseURL", "base_url"])
                .or_else(|| codex_first_json_string(route, &["baseUrl", "baseURL", "base_url"]))
        });
    let match_config = route.get("match").unwrap_or(route);

    CodexRouteSummary {
        id: codex_first_json_string(route, &["id"]),
        label: codex_first_json_string(route, &["label", "name"]),
        enabled: route
            .get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(true),
        target_provider_name: target_provider
            .as_ref()
            .map(|provider| provider.name.clone()),
        target_exists: target_provider.is_some(),
        target_provider_id,
        api_format,
        base_url,
        models: codex_json_string_array(match_config, "models"),
        prefixes: codex_json_string_array(match_config, "prefixes"),
    }
}

/// 读取 route 引用的真实目标 provider id，兼容历史字段名。
fn codex_route_target_provider_id(route: &Value) -> Option<String> {
    let upstream = route.get("upstream").unwrap_or(route);
    codex_first_json_string(
        upstream,
        &[
            "targetProviderId",
            "target_provider_id",
            "providerId",
            "provider_id",
            "upstreamProviderId",
            "upstream_provider_id",
            "provider",
        ],
    )
    .or_else(|| {
        codex_first_json_string(
            route,
            &[
                "targetProviderId",
                "target_provider_id",
                "providerId",
                "provider_id",
                "upstreamProviderId",
                "upstream_provider_id",
                "provider",
            ],
        )
    })
}

/// 从 provider 配置中提取可读 base_url。
fn provider_base_url(provider: &Provider) -> Option<String> {
    codex_first_json_string(
        &provider.settings_config,
        &["base_url", "baseUrl", "baseURL"],
    )
    .or_else(|| {
        provider
            .settings_config
            .get("config")
            .and_then(|value| value.as_str())
            .and_then(crate::codex_config::extract_codex_base_url)
    })
}

/// 从 provider 配置和 meta 中提取 API 格式。
fn provider_api_format(provider: &Provider) -> Option<String> {
    provider
        .meta
        .as_ref()
        .and_then(|meta| meta.api_format.clone())
        .or_else(|| {
            codex_first_json_string(
                &provider.settings_config,
                &["apiFormat", "api_format", "wireApi", "wire_api"],
            )
        })
}

/// 读取第一个非空字符串字段。
fn codex_first_json_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

/// 读取字符串数组字段，并过滤空值。
fn codex_json_string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

/// 读取 Codex router 本地诊断日志，并提取最近事件和错误。
fn codex_router_log_diagnostics(provider_id: Option<&str>) -> CodexRouterLogDiagnostics {
    let path = crate::config::get_app_config_dir()
        .join("logs")
        .join("codex-router.log");
    let path_text = path.display().to_string();
    let exists = path.exists();
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => {
            return CodexRouterLogDiagnostics {
                path: path_text,
                exists,
                total_scanned: 0,
                matched_scanned: 0,
                has_recent_request: false,
                latest_request_at: None,
                latest_error: None,
                recent_events: Vec::new(),
            };
        }
    };

    codex_router_log_diagnostics_from_text(path_text, exists, &text, provider_id)
}

/// 从 router 日志文本生成诊断摘要，先按当前 MultiRouter provider 过滤再判断“近期请求”。
fn codex_router_log_diagnostics_from_text(
    path_text: String,
    exists: bool,
    text: &str,
    provider_id: Option<&str>,
) -> CodexRouterLogDiagnostics {
    codex_router_log_diagnostics_from_text_at(
        path_text,
        exists,
        text,
        provider_id,
        chrono::Local::now().naive_local(),
    )
}

/// 从 router 日志文本生成诊断摘要；`now` 可注入，便于测试“旧错误不算近期”。
fn codex_router_log_diagnostics_from_text_at(
    path_text: String,
    exists: bool,
    text: &str,
    provider_id: Option<&str>,
    now: chrono::NaiveDateTime,
) -> CodexRouterLogDiagnostics {
    let recent_window = chrono::Duration::minutes(30);
    let mut recent_events = text
        .lines()
        .rev()
        .take(500)
        .filter_map(codex_parse_router_log_line)
        .filter(|event| codex_router_log_event_matches_provider(event, provider_id))
        .collect::<Vec<_>>();
    let total_scanned = text.lines().rev().take(500).count();
    let matched_scanned = recent_events.len();
    let latest_request_at = recent_events
        .iter()
        .find(|event| codex_router_log_is_request_event(event))
        .map(|event| event.timestamp.clone());
    let latest_error = recent_events
        .iter()
        .filter(|event| codex_router_log_event_is_recent(event, now, recent_window))
        .find(|event| event.event.contains("error"))
        .and_then(|event| event.error.clone().or_else(|| Some(event.line.clone())));
    let has_recent_request = recent_events
        .iter()
        .filter(|event| codex_router_log_event_is_recent(event, now, recent_window))
        .any(|event| codex_router_log_is_request_event(event));
    recent_events.truncate(30);

    CodexRouterLogDiagnostics {
        path: path_text,
        exists,
        total_scanned,
        matched_scanned,
        has_recent_request,
        latest_request_at,
        latest_error,
        recent_events,
    }
}

/// 判断日志事件是否属于当前 MultiRouter provider 或它派生出的临时 route provider。
fn codex_router_log_event_matches_provider(
    event: &CodexRouterLogEvent,
    provider_id: Option<&str>,
) -> bool {
    let Some(provider_id) = provider_id
        .map(str::trim)
        .filter(|provider_id| !provider_id.is_empty())
    else {
        return true;
    };
    let route_prefix = format!("{provider_id}::route::");
    [
        event.provider.as_deref(),
        event.outer_provider.as_deref(),
        event.effective_provider.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value == provider_id || value.starts_with(&route_prefix))
}

/// 判断日志事件是否代表一次请求已经进入 router 转发链路。
fn codex_router_log_is_request_event(event: &CodexRouterLogEvent) -> bool {
    matches!(
        event.event.as_str(),
        "route_resolved" | "request_prepared" | "upstream_send" | "upstream_status"
    )
}

/// 只把近窗口内的匹配事件视为“当前链路”的近期事件，避免旧 backup 错误污染结论。
fn codex_router_log_event_is_recent(
    event: &CodexRouterLogEvent,
    now: chrono::NaiveDateTime,
    window: chrono::Duration,
) -> bool {
    let Ok(timestamp) =
        chrono::NaiveDateTime::parse_from_str(&event.timestamp, "%Y-%m-%d %H:%M:%S%.f")
    else {
        return false;
    };
    let age = now.signed_duration_since(timestamp);
    age >= chrono::Duration::zero() && age <= window
}

/// 解析一行 `codex-router.log`，字段均为已清洗的 key=value 片段。
fn codex_parse_router_log_line(line: &str) -> Option<CodexRouterLogEvent> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let (timestamp, payload) = line
        .split_once(" event=")
        .map(|(timestamp, payload)| (timestamp.to_string(), format!("event={payload}")))
        .unwrap_or_else(|| ("<unknown>".to_string(), line.to_string()));
    let fields = payload
        .split_whitespace()
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    let event = fields.get("event")?.clone();
    let error = fields
        .get("error")
        .cloned()
        .or_else(|| fields.get("reason").cloned())
        .or_else(|| fields.get("body_summary").cloned());

    Some(CodexRouterLogEvent {
        timestamp,
        event,
        route_id: fields.get("route_id").cloned(),
        model: fields.get("model").cloned(),
        provider: fields
            .get("provider")
            .cloned()
            .or_else(|| fields.get("effective_provider").cloned()),
        outer_provider: fields.get("outer_provider").cloned(),
        effective_provider: fields.get("effective_provider").cloned(),
        status: fields.get("status").cloned(),
        error,
        line: line.to_string(),
    })
}

#[cfg(test)]
mod codex_router_log_diagnostics_tests {
    use super::*;

    #[test]
    fn filters_router_log_to_selected_multirouter_provider() {
        let text = concat!(
            "2026-06-11 13:48:17.854 event=upstream_error model=gpt-5.4-mini provider=codex-official status=400 body_summary=Input_must_be_a_list\n",
            "2026-06-12 21:55:01.022 event=upstream_status model=visible-model provider=external-openai-api::hermes::selected status=200\n",
            "2026-06-13 00:20:00.000 event=route_resolved model=qwen3.6 outer_provider=codex-openai-router effective_provider=codex-openai-router::route::qwen-local route_id=qwen-local routing_configured=true\n",
            "2026-06-13 00:20:01.000 event=upstream_status model=qwen3.6 provider=codex-openai-router::route::qwen-local outer_provider=codex-openai-router effective_provider=codex-openai-router::route::qwen-local status=200\n",
        );
        let now = chrono::NaiveDateTime::parse_from_str(
            "2026-06-13 00:24:36.000",
            "%Y-%m-%d %H:%M:%S%.f",
        )
        .expect("valid test time");

        let diagnostics = codex_router_log_diagnostics_from_text_at(
            "codex-router.log".to_string(),
            true,
            text,
            Some("codex-openai-router"),
            now,
        );

        assert_eq!(diagnostics.total_scanned, 4);
        assert_eq!(diagnostics.matched_scanned, 2);
        assert!(diagnostics.has_recent_request);
        assert_eq!(
            diagnostics.latest_request_at.as_deref(),
            Some("2026-06-13 00:20:01.000")
        );
        assert_eq!(diagnostics.latest_error, None);
        assert!(diagnostics.recent_events.iter().all(|event| {
            codex_router_log_event_matches_provider(event, Some("codex-openai-router"))
        }));
    }

    #[test]
    fn stale_router_errors_do_not_block_current_diagnostics() {
        let text = concat!(
            "2026-06-13 00:00:00.000 event=route_resolved model=qwen3.6 outer_provider=codex-openai-router effective_provider=codex-openai-router::route::qwen-local route_id=qwen-local routing_configured=true\n",
            "2026-06-13 00:00:01.000 event=upstream_error model=qwen3.6 provider=codex-openai-router::route::qwen-local outer_provider=codex-openai-router effective_provider=codex-openai-router::route::qwen-local status=400 body_summary=old_error\n",
        );
        let now = chrono::NaiveDateTime::parse_from_str(
            "2026-06-13 01:00:00.000",
            "%Y-%m-%d %H:%M:%S%.f",
        )
        .expect("valid test time");

        let diagnostics = codex_router_log_diagnostics_from_text_at(
            "codex-router.log".to_string(),
            true,
            text,
            Some("codex-openai-router"),
            now,
        );

        assert_eq!(diagnostics.matched_scanned, 2);
        assert!(!diagnostics.has_recent_request);
        assert_eq!(
            diagnostics.latest_request_at.as_deref(),
            Some("2026-06-13 00:00:00.000")
        );
        assert_eq!(diagnostics.latest_error, None);
    }

    #[test]
    fn spawn_agent_priority_diagnostics_warn_when_deepseek_is_after_first_five() {
        let models = vec![
            "gpt-5.5".to_string(),
            "gpt-5.4".to_string(),
            "gpt-5.4-mini".to_string(),
            "gpt-5.3-codex-spark".to_string(),
            "qwen3.6".to_string(),
            "deepseek-v4-flash".to_string(),
            "deepseek-v4-pro".to_string(),
        ];

        assert_eq!(
            missing_spawn_agent_priority_models(Some(&models)),
            vec!["deepseek-v4-flash", "deepseek-v4-pro"]
        );
    }

    #[test]
    fn spawn_agent_priority_diagnostics_pass_when_routed_models_are_first_five() {
        let models = vec![
            "gpt-5.5".to_string(),
            "qwen3.6".to_string(),
            "deepseek-v4-flash".to_string(),
            "deepseek-v4-pro".to_string(),
            "gpt-5.3-codex-spark".to_string(),
            "gpt-5.4".to_string(),
            "gpt-5.4-mini".to_string(),
        ];

        assert!(missing_spawn_agent_priority_models(Some(&models)).is_empty());
    }

    #[test]
    fn live_model_provider_diagnostics_classify_stable_and_legacy_router_buckets() {
        let stable = test_live_config_for_provider(Some(
            crate::codex_config::CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID,
        ));
        assert_eq!(
            codex_live_model_provider_status(&stable),
            CodexDiagnosticStatus::Pass
        );
        assert_eq!(codex_live_model_provider_bucket(&stable), "stable_router");

        let legacy = test_live_config_for_provider(Some("cc_switch_codex_router"));
        assert_eq!(
            codex_live_model_provider_status(&legacy),
            CodexDiagnosticStatus::Warn
        );
        assert_eq!(codex_live_model_provider_bucket(&legacy), "legacy_router");

        let custom = test_live_config_for_provider(Some("custom"));
        assert_eq!(
            codex_live_model_provider_status(&custom),
            CodexDiagnosticStatus::Warn
        );
        assert_eq!(codex_live_model_provider_bucket(&custom), "custom");

        let mut builtin_openai = test_live_config_for_provider(Some("openai"));
        builtin_openai.uses_builtin_openai_with_local_base = true;
        assert_eq!(
            codex_live_model_provider_status(&builtin_openai),
            CodexDiagnosticStatus::Fail
        );
        assert_eq!(
            codex_live_model_provider_bucket(&builtin_openai),
            "builtin_openai_local_base"
        );
    }

    fn test_live_config_for_provider(provider: Option<&str>) -> CodexLiveConfigDiagnostics {
        CodexLiveConfigDiagnostics {
            path: "config.toml".to_string(),
            exists: true,
            config_modified_at: None,
            parse_error: None,
            model_provider: provider.map(ToString::to_string),
            active_base_url: Some("http://127.0.0.1:15721/v1".to_string()),
            openai_base_url: None,
            provider_base_url: Some("http://127.0.0.1:15721/v1".to_string()),
            supports_websockets: Some(false),
            wire_api: Some("responses".to_string()),
            model_catalog_json: Some("cc-switch-model-catalog.json".to_string()),
            model_catalog_path: None,
            model_catalog_modified_at: None,
            model_catalog_model_count: Some(7),
            model_catalog_first_models: Some(vec![
                "gpt-5.5".to_string(),
                "qwen3.6".to_string(),
                "deepseek-v4-flash".to_string(),
                "deepseek-v4-pro".to_string(),
                "gpt-5.3-codex-spark".to_string(),
            ]),
            spawn_agent_visible_model_limit: CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
            spawn_agent_missing_priority_models: Vec::new(),
            uses_builtin_openai_with_local_base: false,
            points_to_local_proxy: true,
        }
    }
}

/// 根据失败/告警项生成最短下一步动作。
fn codex_next_action(
    checks: &[CodexDiagnosticCheck],
    router_log: &CodexRouterLogDiagnostics,
) -> String {
    if let Some(check) = checks
        .iter()
        .find(|check| check.status == CodexDiagnosticStatus::Fail)
    {
        return match check.id.as_str() {
            "proxy_running" => "先在 CC Switch 开启本地代理服务。".to_string(),
            "socket_connect" => "本地进程已记录为运行但端口不可达，重启 CC Switch 本地代理。".to_string(),
            "codex_takeover" => "把 Codex 当前 provider 切回 MultiRouter 并重新启用 Codex 接管。"
                .to_string(),
            "live_model_provider" | "live_base_url" | "live_websocket_disabled" => {
                "重新启用 MultiRouter provider，让 CC Switch 写入 codex_model_router_v2 provider + supports_websockets=false。"
                    .to_string()
            }
            "route_plan" => "编辑 MultiRouter provider，启用入口并保留至少一条 route。".to_string(),
            "recent_router_error" => {
                "请求已经进入 MultiRouter，优先展开近期 router 日志定位上游或转换层错误。"
                    .to_string()
            }
            _ => check.detail.clone(),
        };
    }
    if !router_log.has_recent_request {
        return "配置看起来可用；请在 Codex 发起一次请求，再回到这里重新运行 Debug 检查。"
            .to_string();
    }
    "链路检查通过；如 Codex 仍报错，下一步看近期 router 事件里的上游状态和转换错误。".to_string()
}

/// 获取代理配置
#[tauri::command]
pub async fn start_external_openai_api_server(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyServerInfo, String> {
    state.proxy_service.start_external_openai_api().await
}

#[tauri::command]
pub async fn get_external_openai_api_server_status(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyStatus, String> {
    Ok(state.proxy_service.get_external_openai_api_status().await)
}

#[tauri::command]
pub async fn get_proxy_config(state: tauri::State<'_, AppState>) -> Result<ProxyConfig, String> {
    state.proxy_service.get_config().await
}

/// 更新代理配置
#[tauri::command]
pub async fn update_proxy_config(
    state: tauri::State<'_, AppState>,
    config: ProxyConfig,
) -> Result<(), String> {
    state.proxy_service.update_config(&config).await
}

/// 获取 External OpenAI-compatible API profile。
///
/// 该 profile 是旁路 API 的独立配置，不代表 Codex current provider 或 takeover。
#[tauri::command]
pub async fn get_external_openai_api_profile(
    state: tauri::State<'_, AppState>,
) -> Result<ExternalOpenAiApiProfileView, String> {
    let profile = external_openai_api::load_profile(&state.db).map_err(|e| e.to_string())?;
    Ok(external_openai_api::profile_view(&profile))
}

/// 读取 External OpenAI-compatible API 的运行时状态。
///
/// 该命令只做 DB 读取和后端选项解析，供前端展示实际可用 backend/model/issue，
/// 不会切换 provider、写 live config 或打开 takeover。
#[tauri::command]
pub async fn get_external_openai_api_runtime_status(
    state: tauri::State<'_, AppState>,
) -> Result<ExternalOpenAiApiRuntimeStatusView, String> {
    external_openai_api::runtime_status(&state.db).map_err(|e| e.to_string())
}

/// 更新 External OpenAI-compatible API profile。
///
/// 只保存启用状态、默认 router 和默认 model，不接受明文 API key。
#[tauri::command]
pub async fn update_external_openai_api_profile(
    state: tauri::State<'_, AppState>,
    profile: ExternalOpenAiApiProfileUpdate,
) -> Result<ExternalOpenAiApiProfileView, String> {
    external_openai_api::update_profile(&state.db, profile).map_err(|e| e.to_string())
}

/// 重新生成 External OpenAI-compatible API 的本地访问 key。
///
/// 明文 key 只在本次返回值中出现；数据库只保存 hash 和 prefix。
#[tauri::command]
pub async fn regenerate_external_openai_api_key(
    state: tauri::State<'_, AppState>,
) -> Result<GeneratedExternalOpenAiApiKey, String> {
    external_openai_api::regenerate_api_key(&state.db).map_err(|e| e.to_string())
}

// ==================== Global & Per-App Config ====================

/// 获取全局代理配置
///
/// 返回统一的全局配置字段（代理开关、监听地址、端口、日志开关）
#[tauri::command]
pub async fn get_global_proxy_config(
    state: tauri::State<'_, AppState>,
) -> Result<GlobalProxyConfig, String> {
    let db = &state.db;
    db.get_global_proxy_config()
        .await
        .map_err(|e| e.to_string())
}

/// 更新全局代理配置
///
/// 更新统一的全局配置字段，会同时更新三行（claude/codex/gemini）
#[tauri::command]
pub async fn update_global_proxy_config(
    state: tauri::State<'_, AppState>,
    config: GlobalProxyConfig,
) -> Result<(), String> {
    let db = &state.db;
    // 全局开关只控制本地服务是否应运行，不能绕过 per-app takeover 的恢复流程。
    // 如果直接在接管中关掉总开关，Codex/Claude/Gemini 的 live 配置会继续指向
    // 127.0.0.1，但代理服务不再启动，客户端侧表现就是所有模型请求超时。
    if !config.proxy_enabled {
        let takeover_active = db
            .is_live_takeover_active()
            .await
            .map_err(|e| e.to_string())?;
        if takeover_active {
            return Err(
                "仍有应用处于代理接管状态，请先关闭对应应用接管或使用停止并恢复 Live 配置。"
                    .to_string(),
            );
        }
    }

    db.update_global_proxy_config(config)
        .await
        .map_err(|e| e.to_string())
}

/// 获取指定应用的代理配置
///
/// 返回应用级配置（enabled、auto_failover、超时、熔断器等）
#[tauri::command]
pub async fn get_proxy_config_for_app(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<AppProxyConfig, String> {
    let db = &state.db;
    db.get_proxy_config_for_app(&app_type)
        .await
        .map_err(|e| e.to_string())
}

/// 更新指定应用的代理配置
///
/// 更新应用级配置（enabled、auto_failover、超时、熔断器等）
#[tauri::command]
pub async fn update_proxy_config_for_app(
    state: tauri::State<'_, AppState>,
    config: AppProxyConfig,
) -> Result<(), String> {
    let db = &state.db;
    let app_type = config.app_type.clone();
    let circuit_config = CircuitBreakerConfig::from(&config);

    db.update_proxy_config_for_app(config)
        .await
        .map_err(|e| e.to_string())?;

    state
        .proxy_service
        .update_circuit_breaker_config_for_app(&app_type, circuit_config)
        .await
}

async fn get_default_cost_multiplier_internal(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    let db = &state.db;
    db.get_default_cost_multiplier(app_type).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn get_default_cost_multiplier_test_hook(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    get_default_cost_multiplier_internal(state, app_type).await
}

/// 获取默认成本倍率
#[tauri::command]
pub async fn get_default_cost_multiplier(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<String, String> {
    get_default_cost_multiplier_internal(&state, &app_type)
        .await
        .map_err(|e| e.to_string())
}

async fn set_default_cost_multiplier_internal(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    db.set_default_cost_multiplier(app_type, value).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn set_default_cost_multiplier_test_hook(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    set_default_cost_multiplier_internal(state, app_type, value).await
}

/// 设置默认成本倍率
#[tauri::command]
pub async fn set_default_cost_multiplier(
    state: tauri::State<'_, AppState>,
    app_type: String,
    value: String,
) -> Result<(), String> {
    set_default_cost_multiplier_internal(&state, &app_type, &value)
        .await
        .map_err(|e| e.to_string())
}

async fn get_pricing_model_source_internal(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    let db = &state.db;
    db.get_pricing_model_source(app_type).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn get_pricing_model_source_test_hook(
    state: &AppState,
    app_type: &str,
) -> Result<String, AppError> {
    get_pricing_model_source_internal(state, app_type).await
}

/// 获取计费模式来源
#[tauri::command]
pub async fn get_pricing_model_source(
    state: tauri::State<'_, AppState>,
    app_type: String,
) -> Result<String, String> {
    get_pricing_model_source_internal(&state, &app_type)
        .await
        .map_err(|e| e.to_string())
}

async fn set_pricing_model_source_internal(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    let db = &state.db;
    db.set_pricing_model_source(app_type, value).await
}

#[cfg_attr(not(feature = "test-hooks"), doc(hidden))]
pub async fn set_pricing_model_source_test_hook(
    state: &AppState,
    app_type: &str,
    value: &str,
) -> Result<(), AppError> {
    set_pricing_model_source_internal(state, app_type, value).await
}

/// 设置计费模式来源
#[tauri::command]
pub async fn set_pricing_model_source(
    state: tauri::State<'_, AppState>,
    app_type: String,
    value: String,
) -> Result<(), String> {
    set_pricing_model_source_internal(&state, &app_type, &value)
        .await
        .map_err(|e| e.to_string())
}

/// 检查代理服务器是否正在运行
#[tauri::command]
pub async fn is_proxy_running(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.proxy_service.is_running().await)
}

/// 检查是否处于 Live 接管模式
#[tauri::command]
pub async fn is_live_takeover_active(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    state.proxy_service.is_takeover_active().await
}

/// 代理模式下切换供应商（热切换）
#[tauri::command]
pub async fn switch_proxy_provider(
    state: tauri::State<'_, AppState>,
    app_type: String,
    provider_id: String,
) -> Result<(), String> {
    // Block official providers during proxy takeover
    let provider = state
        .db
        .get_provider_by_id(&provider_id, &app_type)
        .map_err(|e| format!("读取供应商失败: {e}"))?
        .ok_or_else(|| format!("供应商不存在: {provider_id}"))?;
    if provider.category.as_deref() == Some("official") {
        return Err(
            "代理接管模式下不能切换到官方供应商 (Cannot switch to official provider during proxy takeover)"
                .to_string(),
        );
    }

    state
        .proxy_service
        .switch_proxy_target(&app_type, &provider_id)
        .await
}

// ==================== 故障转移相关命令 ====================

/// 获取供应商健康状态
#[tauri::command]
pub async fn get_provider_health(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    app_type: String,
) -> Result<ProviderHealth, String> {
    let db = &state.db;
    db.get_provider_health(&provider_id, &app_type)
        .await
        .map_err(|e| e.to_string())
}

/// 重置熔断器
///
/// 重置后会检查是否应该切回队列中优先级更高的供应商：
/// 1. 检查自动故障转移是否开启
/// 2. 如果恢复的供应商在队列中优先级更高（queue_order 更小），则自动切换
#[tauri::command]
pub async fn reset_circuit_breaker(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    provider_id: String,
    app_type: String,
) -> Result<(), String> {
    // 1. 重置数据库健康状态
    let db = &state.db;
    db.update_provider_health(&provider_id, &app_type, true, None)
        .await
        .map_err(|e| e.to_string())?;

    // 2. 如果代理正在运行，重置内存中的熔断器状态
    state
        .proxy_service
        .reset_provider_circuit_breaker(&provider_id, &app_type)
        .await?;

    // 3. 检查是否应该切回优先级更高的供应商（从 proxy_config 表读取）
    // 只有当该应用已被代理接管（enabled=true）且开启了自动故障转移时才执行
    let (app_enabled, auto_failover_enabled) = match db.get_proxy_config_for_app(&app_type).await {
        Ok(config) => (config.enabled, config.auto_failover_enabled),
        Err(e) => {
            log::error!("[{app_type}] Failed to read proxy_config: {e}, defaulting to disabled");
            (false, false)
        }
    };

    if app_enabled && auto_failover_enabled && state.proxy_service.is_running().await {
        // 获取当前供应商 ID
        let current_id = db
            .get_current_provider(&app_type)
            .map_err(|e| e.to_string())?;

        if let Some(current_id) = current_id {
            // 获取故障转移队列
            let queue = db
                .get_failover_queue(&app_type)
                .map_err(|e| e.to_string())?;

            // 找到恢复的供应商和当前供应商在队列中的位置（使用 sort_index）
            let restored_order = queue
                .iter()
                .find(|item| item.provider_id == provider_id)
                .and_then(|item| item.sort_index);

            let current_order = queue
                .iter()
                .find(|item| item.provider_id == current_id)
                .and_then(|item| item.sort_index);

            // 如果恢复的供应商优先级更高（sort_index 更小），则切换
            if let (Some(restored), Some(current)) = (restored_order, current_order) {
                if restored < current {
                    log::info!(
                        "[Recovery] 供应商 {provider_id} 已恢复且优先级更高 (P{restored} vs P{current})，自动切换"
                    );

                    // 获取供应商名称用于日志和事件
                    let provider_name = db
                        .get_all_providers(&app_type)
                        .ok()
                        .and_then(|providers| providers.get(&provider_id).map(|p| p.name.clone()))
                        .unwrap_or_else(|| provider_id.clone());

                    // 创建故障转移切换管理器并执行切换
                    let switch_manager =
                        crate::proxy::failover_switch::FailoverSwitchManager::new(db.clone());
                    if let Err(e) = switch_manager
                        .try_switch(Some(&app_handle), &app_type, &provider_id, &provider_name)
                        .await
                    {
                        log::error!("[Recovery] 自动切换失败: {e}");
                    }
                }
            }
        }
    }

    Ok(())
}

/// 获取熔断器配置
#[tauri::command]
pub async fn get_circuit_breaker_config(
    state: tauri::State<'_, AppState>,
) -> Result<CircuitBreakerConfig, String> {
    let db = &state.db;
    db.get_circuit_breaker_config()
        .await
        .map_err(|e| e.to_string())
}

/// 更新熔断器配置
#[tauri::command]
pub async fn update_circuit_breaker_config(
    state: tauri::State<'_, AppState>,
    config: CircuitBreakerConfig,
) -> Result<(), String> {
    let db = &state.db;

    // 1. 更新数据库配置
    db.update_circuit_breaker_config(&config)
        .await
        .map_err(|e| e.to_string())?;

    // 2. 如果代理正在运行，热更新内存中的熔断器配置
    state
        .proxy_service
        .update_circuit_breaker_configs(config)
        .await?;

    Ok(())
}

/// 获取熔断器统计信息（仅当代理服务器运行时）
#[tauri::command]
pub async fn get_circuit_breaker_stats(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    app_type: String,
) -> Result<Option<CircuitBreakerStats>, String> {
    // 这个功能需要访问运行中的代理服务器的内存状态
    // 目前先返回 None，后续可以通过 ProxyService 暴露接口来实现
    let _ = (state, provider_id, app_type);
    Ok(None)
}
