//! Codex Responses WebSocket official upstream relay.
//!
//! Codex built-in `openai` providers prefer `/responses` over WebSocket and only
//! fall back to HTTP when the server reports HTTP 426.  The local proxy therefore
//! needs to either relay the official ChatGPT WebSocket path, or return the same
//! 426 semantics for routes that must continue through the existing HTTP
//! Responses bridge.

use super::{
    providers::{
        codex_oauth_auth::CodexOAuthManager, codex_provider_uses_chat_completions, get_adapter,
        resolve_codex_model_routed_providers, AuthInfo, AuthStrategy,
    },
    server::ProxyState,
    ProxyError,
};
use crate::app_config::AppType;
use crate::commands::CodexOAuthState;
use crate::provider::Provider;
use axum::extract::ws::{Message as AxumWsMessage, WebSocket};
use axum::http::HeaderMap;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http as ws_http,
        protocol::{frame::coding::CloseCode, CloseFrame, Message as TungsteniteMessage},
    },
};
use uuid::Uuid;

const CODEX_RESPONSES_ENDPOINT: &str = "/v1/responses";
const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

/// 处理 Codex Responses WebSocket 连接。
///
/// 首帧必须是官方客户端发出的 `response.create`。函数会用该帧中的模型名走现有
/// Codex router，只有真实上游是 ChatGPT Codex 后端时才建立 `wss://` 中继；否则给
/// 客户端发送协议内 426，让官方客户端按自身逻辑回退到 HTTP Responses。
pub async fn relay_responses_websocket(
    state: ProxyState,
    client_headers: HeaderMap,
    mut client_socket: WebSocket,
) {
    let trace = Uuid::new_v4().to_string();
    log_ws_event(
        &trace,
        "accepted",
        &[
            ("client_header_count", client_headers.len().to_string()),
            (
                "client_headers",
                header_name_list(&client_headers).join(","),
            ),
        ],
    );

    let first_message = match read_first_client_text(&mut client_socket).await {
        Ok(message) => message,
        Err(err) => {
            log_ws_event(
                &trace,
                "client_first_frame_error",
                &[("error", err.clone())],
            );
            log::info!("[CodexWS:{trace}] first frame unavailable: {err}");
            close_client_with_reason(
                client_socket,
                CloseCode::Protocol,
                "missing response.create",
            )
            .await;
            return;
        }
    };

    let first_payload: Value = match serde_json::from_str(&first_message) {
        Ok(value) => value,
        Err(err) => {
            log_ws_event(
                &trace,
                "client_first_frame_invalid_json",
                &[("error", err.to_string())],
            );
            log::info!("[CodexWS:{trace}] invalid first JSON frame: {err}");
            close_client_with_reason(
                client_socket,
                CloseCode::Protocol,
                "invalid response.create",
            )
            .await;
            return;
        }
    };
    let request_model = first_payload
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("<missing>")
        .to_string();
    let request_type = first_payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("<missing>")
        .to_string();
    log_ws_event(
        &trace,
        "client_first_frame",
        &[
            ("type", request_type.clone()),
            ("model", request_model.clone()),
            ("bytes", first_message.len().to_string()),
        ],
    );

    let provider = match resolve_official_ws_provider(&state, &first_payload).await {
        Ok(provider) => {
            log_ws_event(
                &trace,
                "route_resolved",
                &[
                    ("model", request_model.clone()),
                    ("provider", provider.id.clone()),
                    ("provider_name", provider.name.clone()),
                ],
            );
            provider
        }
        Err(err) => {
            log_ws_event(
                &trace,
                "route_fallback_http",
                &[("model", request_model.clone()), ("error", err.to_string())],
            );
            log::info!("[CodexWS:{trace}] route cannot use official websocket: {err}");
            send_websocket_http_fallback(&trace, &mut client_socket).await;
            return;
        }
    };

    let upstream_request = match build_upstream_request(&state, &provider, &client_headers).await {
        Ok(request) => request,
        Err(err) => {
            log_ws_event(
                &trace,
                "upstream_request_build_error",
                &[("model", request_model.clone()), ("error", err.to_string())],
            );
            log::warn!("[CodexWS:{trace}] upstream request build failed: {err}");
            send_websocket_http_fallback(&trace, &mut client_socket).await;
            return;
        }
    };
    let upstream_url = upstream_request.uri().to_string();
    let upstream_header_names = header_name_list(upstream_request.headers()).join(",");
    log_ws_event(
        &trace,
        "upstream_connect_start",
        &[
            ("model", request_model.clone()),
            ("url", upstream_url.clone()),
            ("header_count", upstream_request.headers().len().to_string()),
            ("headers", upstream_header_names),
        ],
    );

    let (upstream_socket, response) = match connect_async(upstream_request).await {
        Ok(pair) => pair,
        Err(err) => {
            log_ws_event(
                &trace,
                "upstream_connect_error",
                &[
                    ("model", request_model.clone()),
                    ("url", upstream_url),
                    ("error", err.to_string()),
                ],
            );
            log::warn!("[CodexWS:{trace}] upstream websocket connect failed: {err}");
            send_websocket_http_fallback(&trace, &mut client_socket).await;
            return;
        }
    };
    log_ws_event(
        &trace,
        "upstream_connect_ok",
        &[
            ("model", request_model.clone()),
            ("status", response.status().as_u16().to_string()),
            (
                "response_headers",
                header_name_list(response.headers()).join(","),
            ),
        ],
    );
    log::info!(
        "[CodexWS:{trace}] upstream websocket connected status={} model={}",
        response.status(),
        request_model
    );

    let (mut upstream_sink, mut upstream_stream) = upstream_socket.split();
    log_ws_event(
        &trace,
        "upstream_first_send_start",
        &[
            ("model", request_model.clone()),
            ("bytes", first_message.len().to_string()),
        ],
    );
    if let Err(err) = upstream_sink
        .send(TungsteniteMessage::Text(first_message.into()))
        .await
    {
        let close_probe = probe_upstream_message(&mut upstream_stream).await;
        log_ws_event(
            &trace,
            "upstream_first_send_error",
            &[
                ("model", request_model.clone()),
                ("error", err.to_string()),
                ("upstream_probe", close_probe),
            ],
        );
        log::warn!("[CodexWS:{trace}] failed to send first frame upstream: {err}");
        send_websocket_http_fallback(&trace, &mut client_socket).await;
        return;
    }
    log_ws_event(
        &trace,
        "upstream_first_send_ok",
        &[("model", request_model.clone())],
    );

    let (mut client_sink, mut client_stream) = client_socket.split();
    let client_to_upstream = async {
        let mut frames = 0usize;
        let mut bytes = 0usize;
        while let Some(message) = client_stream.next().await {
            let message = message.map_err(|err| err.to_string())?;
            frames += 1;
            bytes += axum_message_payload_len(&message);
            if let AxumWsMessage::Close(frame) = &message {
                log_ws_event(&trace, "client_close", &close_frame_fields(frame.as_ref()));
            }
            if let Some(upstream_message) = axum_to_tungstenite_message(message) {
                upstream_sink
                    .send(upstream_message)
                    .await
                    .map_err(|err| err.to_string())?;
            }
        }
        Ok::<RelaySummary, String>(RelaySummary { frames, bytes })
    };

    let upstream_to_client = async {
        let mut frames = 0usize;
        let mut bytes = 0usize;
        let mut first_upstream_frame_summary = None::<String>;
        while let Some(message) = upstream_stream.next().await {
            let message = message.map_err(|err| err.to_string())?;
            frames += 1;
            bytes += tungstenite_message_payload_len(&message);
            if first_upstream_frame_summary.is_none() {
                first_upstream_frame_summary = Some(summarize_tungstenite_message(&message));
                log_ws_event(
                    &trace,
                    "upstream_first_frame",
                    &[(
                        "summary",
                        first_upstream_frame_summary
                            .clone()
                            .unwrap_or_else(|| "<missing>".to_string()),
                    )],
                );
            }
            if let TungsteniteMessage::Close(frame) = &message {
                let mut fields = close_frame_fields(frame.as_ref());
                fields.push(("before_first_upstream_frame", (frames == 1).to_string()));
                log_ws_event(&trace, "upstream_close", &fields);
                if frames == 1 {
                    log_ws_event(&trace, "upstream_close_before_data_fallback", &fields);
                    client_sink
                        .send(AxumWsMessage::Text(websocket_http_fallback_payload()))
                        .await
                        .map_err(|err| err.to_string())?;
                    client_sink.close().await.map_err(|err| err.to_string())?;
                    return Ok::<RelaySummary, String>(RelaySummary { frames, bytes });
                }
            }
            if let Some(client_message) = tungstenite_to_axum_message(message) {
                client_sink
                    .send(client_message)
                    .await
                    .map_err(|err| err.to_string())?;
            }
        }
        if frames == 0 {
            log_ws_event(&trace, "upstream_ended_without_frames", &[]);
            client_sink
                .send(AxumWsMessage::Text(websocket_http_fallback_payload()))
                .await
                .map_err(|err| err.to_string())?;
            client_sink.close().await.map_err(|err| err.to_string())?;
        }
        Ok::<RelaySummary, String>(RelaySummary { frames, bytes })
    };

    tokio::select! {
        result = client_to_upstream => {
            if let Err(err) = result {
                log_ws_event(&trace, "relay_client_to_upstream_error", &[("winner", "client_to_upstream".to_string()), ("error", err.clone())]);
                log::info!("[CodexWS:{trace}] client->upstream relay ended: {err}");
            } else {
                let summary = result.unwrap();
                log_ws_event(&trace, "relay_client_to_upstream_done", &[
                    ("winner", "client_to_upstream".to_string()),
                    ("frames", summary.frames.to_string()),
                    ("bytes", summary.bytes.to_string()),
                ]);
            }
        }
        result = upstream_to_client => {
            if let Err(err) = result {
                log_ws_event(&trace, "relay_upstream_to_client_error", &[("winner", "upstream_to_client".to_string()), ("error", err.clone())]);
                log::info!("[CodexWS:{trace}] upstream->client relay ended: {err}");
            } else {
                let summary = result.unwrap();
                log_ws_event(&trace, "relay_upstream_to_client_done", &[
                    ("winner", "upstream_to_client".to_string()),
                    ("frames", summary.frames.to_string()),
                    ("bytes", summary.bytes.to_string()),
                ]);
            }
        }
    }
}

/// 读取官方客户端的首个文本帧，跳过 ping/pong，避免误判预热连接。
async fn read_first_client_text(client_socket: &mut WebSocket) -> Result<String, String> {
    while let Some(message) = client_socket.recv().await {
        match message.map_err(|err| err.to_string())? {
            AxumWsMessage::Text(text) => return Ok(text),
            AxumWsMessage::Binary(bytes) => {
                return String::from_utf8(bytes.to_vec()).map_err(|err| err.to_string());
            }
            AxumWsMessage::Ping(_) | AxumWsMessage::Pong(_) => {}
            AxumWsMessage::Close(_) => return Err("client closed before first frame".to_string()),
        }
    }
    Err("client stream ended before first frame".to_string())
}

/// 根据首帧模型解析 Codex route，并确保目标是真正的 ChatGPT Codex official upstream。
async fn resolve_official_ws_provider(
    state: &ProxyState,
    first_payload: &Value,
) -> Result<Provider, ProxyError> {
    let providers = state
        .provider_router
        .select_providers("codex")
        .await
        .map_err(|err| ProxyError::DatabaseError(err.to_string()))?;

    for provider in providers {
        let mut candidates = resolve_codex_model_routed_providers(&provider, first_payload);
        if candidates.is_empty() {
            candidates.push(provider);
        }

        return select_official_ws_candidate(candidates);
    }

    Err(ProxyError::ConfigError(
        "current Codex route is not ChatGPT official websocket upstream".to_string(),
    ))
}

/// 选择本次 WebSocket 请求真正允许直连的 official upstream。
///
/// 这里只检查第一条 effective route，不能继续扫描 fallback route；否则非 official/chat
/// 模型会被后续 official fallback 误送进 ChatGPT WebSocket，绕过 HTTP bridge。
fn select_official_ws_candidate(candidates: Vec<Provider>) -> Result<Provider, ProxyError> {
    let Some(candidate) = candidates.into_iter().next() else {
        return Err(ProxyError::ConfigError(
            "current Codex route has no websocket candidate".to_string(),
        ));
    };
    if codex_provider_uses_chat_completions(&candidate) {
        return Err(ProxyError::ConfigError(format!(
            "selected Codex route {} requires HTTP Responses fallback",
            candidate.id
        )));
    }

    let adapter = get_adapter(&AppType::Codex);
    let base_url = adapter.extract_base_url(&candidate)?;
    if base_url.trim_end_matches('/') == CHATGPT_CODEX_BASE_URL {
        return Ok(candidate);
    }

    Err(ProxyError::ConfigError(format!(
        "selected Codex route {} is not ChatGPT official websocket upstream",
        candidate.id
    )))
}

/// 构建发往 ChatGPT Codex official backend 的 WebSocket 握手请求。
///
/// 这里复用 provider adapter 的 base_url/auth 语义，同时透传官方客户端的会话类头
/// 和 turn-state 头，避免本地代理改变官方请求身份和会话粘性。
async fn build_upstream_request(
    state: &ProxyState,
    provider: &Provider,
    client_headers: &HeaderMap,
) -> Result<ws_http::Request<()>, ProxyError> {
    let adapter = get_adapter(&AppType::Codex);
    let base_url = adapter.extract_base_url(provider)?;
    let http_url = adapter.build_url(&base_url, CODEX_RESPONSES_ENDPOINT);
    let ws_url = http_url
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            http_url
                .strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .ok_or_else(|| ProxyError::ConfigError(format!("invalid websocket url: {http_url}")))?;

    let mut request = ws_url
        .into_client_request()
        .map_err(|err| ProxyError::ConfigError(err.to_string()))?;

    {
        let headers = request.headers_mut();
        copy_official_client_headers(headers, client_headers)?;
        insert_required_header(headers, "origin", "https://chatgpt.com")?;

        for (name, value) in codex_auth_headers(state, provider).await? {
            if name.as_str().eq_ignore_ascii_case("originator") {
                continue;
            }
            insert_ws_header_value(headers, name.as_str(), &value)?;
        }
    }

    Ok(request)
}

/// 生成 Codex OAuth 鉴权头；托管账号 provider 会在这里取真实 access token。
async fn codex_auth_headers(
    state: &ProxyState,
    provider: &Provider,
) -> Result<Vec<(http::HeaderName, http::HeaderValue)>, ProxyError> {
    let adapter = get_adapter(&AppType::Codex);
    let mut auth = adapter
        .extract_auth(provider)
        .ok_or_else(|| ProxyError::AuthError("Codex provider missing auth".to_string()))?;

    if auth.strategy == AuthStrategy::CodexOAuth {
        let Some(app_handle) = state.app_handle.as_ref() else {
            return Err(ProxyError::AuthError(
                "Codex OAuth requires app handle".to_string(),
            ));
        };
        let codex_state = app_handle.state::<CodexOAuthState>();
        let codex_auth: tokio::sync::RwLockReadGuard<'_, CodexOAuthManager> =
            codex_state.0.read().await;
        let token = if let Some(account_id) = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.managed_account_id_for("codex_oauth"))
        {
            codex_auth.get_valid_token_for_account(&account_id).await
        } else {
            codex_auth.get_valid_token().await
        }
        .map_err(|err| ProxyError::AuthError(err.to_string()))?;
        auth = AuthInfo::new(token, AuthStrategy::CodexOAuth);
    }

    let mut headers = adapter.get_auth_headers(&auth)?;
    if auth.strategy == AuthStrategy::CodexOAuth {
        if let Some(account_id) = provider
            .meta
            .as_ref()
            .and_then(|meta| meta.managed_account_id_for("codex_oauth"))
        {
            let value = http::HeaderValue::from_str(&account_id).map_err(|err| {
                ProxyError::AuthError(format!("invalid chatgpt-account-id header: {err}"))
            })?;
            headers.push((http::HeaderName::from_static("chatgpt-account-id"), value));
        }
    }
    Ok(headers)
}

/// 向客户端发送官方可识别的 WebSocket 内 HTTP 426 错误事件。
async fn send_websocket_http_fallback(trace: &str, client_socket: &mut WebSocket) {
    let payload = websocket_http_fallback_payload();

    match client_socket.send(AxumWsMessage::Text(payload)).await {
        Ok(()) => log_ws_event(trace, "fallback_event_send_ok", &[]),
        Err(err) => log_ws_event(
            trace,
            "fallback_event_send_error",
            &[("error", err.to_string())],
        ),
    }
    match client_socket.close().await {
        Ok(()) => log_ws_event(trace, "fallback_close_ok", &[]),
        Err(err) => log_ws_event(trace, "fallback_close_error", &[("error", err.to_string())]),
    }
}

/// 生成官方客户端可识别的 WebSocket 内 426 fallback 事件正文。
///
/// WS relay 已经完成握手后无法再返回 HTTP 426 状态码，因此用官方客户端已有的
/// error-event 语义触发它回退到 HTTP Responses 路径。
fn websocket_http_fallback_payload() -> String {
    json!({
        "type": "error",
        "status_code": 426,
        "error": {
            "message": "CC Switch route requires HTTP Responses fallback.",
            "type": "cc_switch_websocket_fallback",
            "code": "responses_websocket_not_supported"
        }
    })
    .to_string()
}

/// 用指定 close code 和原因关闭客户端连接。
async fn close_client_with_reason(mut client_socket: WebSocket, code: CloseCode, reason: &str) {
    let _ = client_socket
        .send(AxumWsMessage::Close(Some(axum::extract::ws::CloseFrame {
            code: u16::from(code),
            reason: reason.to_owned().into(),
        })))
        .await;
}

/// 将 Axum 客户端帧转换为 tungstenite 上游帧。
fn axum_to_tungstenite_message(message: AxumWsMessage) -> Option<TungsteniteMessage> {
    match message {
        AxumWsMessage::Text(text) => Some(TungsteniteMessage::Text(text.into())),
        AxumWsMessage::Binary(bytes) => Some(TungsteniteMessage::Binary(bytes.into())),
        AxumWsMessage::Ping(bytes) => Some(TungsteniteMessage::Ping(bytes.into())),
        AxumWsMessage::Pong(bytes) => Some(TungsteniteMessage::Pong(bytes.into())),
        AxumWsMessage::Close(frame) => {
            Some(TungsteniteMessage::Close(frame.map(|frame| CloseFrame {
                code: CloseCode::from(frame.code),
                reason: frame.reason.to_string().into(),
            })))
        }
    }
}

/// 将 tungstenite 上游帧转换为 Axum 客户端帧。
fn tungstenite_to_axum_message(message: TungsteniteMessage) -> Option<AxumWsMessage> {
    match message {
        TungsteniteMessage::Text(text) => Some(AxumWsMessage::Text(text.to_string())),
        TungsteniteMessage::Binary(bytes) => Some(AxumWsMessage::Binary(bytes.to_vec())),
        TungsteniteMessage::Ping(bytes) => Some(AxumWsMessage::Ping(bytes.to_vec())),
        TungsteniteMessage::Pong(bytes) => Some(AxumWsMessage::Pong(bytes.to_vec())),
        TungsteniteMessage::Close(frame) => Some(AxumWsMessage::Close(frame.map(|frame| {
            axum::extract::ws::CloseFrame {
                code: u16::from(frame.code),
                reason: frame.reason.to_string().into(),
            }
        }))),
        TungsteniteMessage::Frame(_) => None,
    }
}

/// 记录 relay 方向结束时的帧数和字节数，避免只看到笼统的 done。
struct RelaySummary {
    frames: usize,
    bytes: usize,
}

/// 统计本地客户端 WebSocket 帧的载荷大小，仅用于诊断元数据。
fn axum_message_payload_len(message: &AxumWsMessage) -> usize {
    match message {
        AxumWsMessage::Text(text) => text.len(),
        AxumWsMessage::Binary(bytes) | AxumWsMessage::Ping(bytes) | AxumWsMessage::Pong(bytes) => {
            bytes.len()
        }
        AxumWsMessage::Close(frame) => frame
            .as_ref()
            .map(|frame| frame.reason.len())
            .unwrap_or_default(),
    }
}

/// 统计上游 WebSocket 帧的载荷大小，仅用于诊断元数据。
fn tungstenite_message_payload_len(message: &TungsteniteMessage) -> usize {
    match message {
        TungsteniteMessage::Text(text) => text.len(),
        TungsteniteMessage::Binary(bytes)
        | TungsteniteMessage::Ping(bytes)
        | TungsteniteMessage::Pong(bytes) => bytes.len(),
        TungsteniteMessage::Close(frame) => frame
            .as_ref()
            .map(|frame| frame.reason.len())
            .unwrap_or_default(),
        TungsteniteMessage::Frame(_) => 0,
    }
}

/// 摘要化上游帧类型，避免把完整响应正文或敏感字段写入日志。
fn summarize_tungstenite_message(message: &TungsteniteMessage) -> String {
    match message {
        TungsteniteMessage::Text(text) => format!("text:{}", summarize_text_payload(text)),
        TungsteniteMessage::Binary(bytes) => format!("binary:{}bytes", bytes.len()),
        TungsteniteMessage::Ping(bytes) => format!("ping:{}bytes", bytes.len()),
        TungsteniteMessage::Pong(bytes) => format!("pong:{}bytes", bytes.len()),
        TungsteniteMessage::Close(frame) => {
            let fields = close_frame_fields(frame.as_ref())
                .into_iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(",");
            format!("close:{fields}")
        }
        TungsteniteMessage::Frame(_) => "frame".to_string(),
    }
}

/// 将 close frame 转成安全字段，只记录 code 和 reason 长度，不落原始 reason。
fn close_frame_fields<C>(frame: Option<&C>) -> Vec<(&'static str, String)>
where
    C: WebSocketCloseFrame,
{
    match frame {
        Some(frame) => vec![
            ("code", frame.close_code().to_string()),
            ("reason_len", frame.close_reason_len().to_string()),
        ],
        None => vec![
            ("code", "<none>".to_string()),
            ("reason_len", "0".to_string()),
        ],
    }
}

/// 屏蔽 Axum 和 tungstenite close frame 的具体类型差异。
trait WebSocketCloseFrame {
    fn close_code(&self) -> u16;
    fn close_reason_len(&self) -> usize;
}

impl WebSocketCloseFrame for axum::extract::ws::CloseFrame<'_> {
    fn close_code(&self) -> u16 {
        self.code
    }

    fn close_reason_len(&self) -> usize {
        self.reason.len()
    }
}

impl WebSocketCloseFrame for CloseFrame {
    fn close_code(&self) -> u16 {
        u16::from(self.code)
    }

    fn close_reason_len(&self) -> usize {
        self.reason.len()
    }
}

/// 复制 Codex 官方客户端已经构造好的握手头，只过滤连接级头和本地占位鉴权。
///
/// 这样可以最大化复用官方 `build_websocket_headers + default_headers` 的输出，包括
/// `openai-beta`、`x-codex-beta-features`、attestation、originator 和真实 user-agent。
fn copy_official_client_headers(
    upstream_headers: &mut ws_http::HeaderMap,
    client_headers: &HeaderMap,
) -> Result<(), ProxyError> {
    for (name, value) in client_headers {
        let name_str = name.as_str();
        if should_skip_client_ws_header(name_str) {
            continue;
        }
        insert_ws_header_value(upstream_headers, name_str, value)?;
    }
    Ok(())
}

/// 判断客户端握手头是否不能透传到上游 WebSocket。
fn should_skip_client_ws_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "upgrade"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-protocol"
            | "sec-websocket-extensions"
            | "authorization"
            | "proxy-authorization"
            | "content-length"
            | "content-type"
    )
}

/// 写入必须由官方 upstream 看到的固定 header；用于覆盖本地代理握手里的占位值。
fn insert_required_header(
    headers: &mut ws_http::HeaderMap,
    name: &'static str,
    value: &'static str,
) -> Result<(), ProxyError> {
    let name = ws_http::HeaderName::from_static(name);
    let value = ws_http::HeaderValue::from_static(value);
    headers.insert(name, value);
    Ok(())
}

/// 将 Axum/http 头值复制到 tungstenite/http 请求头。
fn insert_ws_header_value(
    headers: &mut ws_http::HeaderMap,
    name: &str,
    value: &http::HeaderValue,
) -> Result<(), ProxyError> {
    let name = ws_http::HeaderName::from_bytes(name.as_bytes())
        .map_err(|err| ProxyError::ConfigError(format!("invalid websocket header name: {err}")))?;
    let value = ws_http::HeaderValue::from_bytes(value.as_bytes()).map_err(|err| {
        ProxyError::ConfigError(format!("invalid websocket header value for {name}: {err}"))
    })?;
    headers.insert(name, value);
    Ok(())
}

/// 记录 Codex WS 诊断事件到主日志和 `codex-router.log`，不写入敏感 header 值。
fn log_ws_event(trace: &str, event: &str, fields: &[(&str, String)]) {
    let mut owned_fields = Vec::with_capacity(fields.len() + 1);
    owned_fields.push(("trace", trace.to_string()));
    owned_fields.extend(fields.iter().map(|(key, value)| (*key, value.clone())));
    super::codex_router_log::append_event(&format!("ws_{event}"), &owned_fields);
}

/// 返回 header 名称列表；只用于诊断，不包含任何 header 值。
fn header_name_list(headers: &HeaderMap) -> Vec<String> {
    let mut names = headers
        .keys()
        .map(|name| name.as_str().to_ascii_lowercase())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

/// 首帧发送失败后短暂探测上游是否已经发 close/error，便于判断是拒绝还是网络断开。
async fn probe_upstream_message<S>(upstream_stream: &mut S) -> String
where
    S: futures::Stream<Item = Result<TungsteniteMessage, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
{
    match tokio::time::timeout(Duration::from_millis(500), upstream_stream.next()).await {
        Ok(Some(Ok(TungsteniteMessage::Close(Some(frame))))) => {
            format!("close:{}:{}", u16::from(frame.code), frame.reason)
        }
        Ok(Some(Ok(TungsteniteMessage::Close(None)))) => "close:none".to_string(),
        Ok(Some(Ok(TungsteniteMessage::Text(text)))) => {
            format!("text:{}", summarize_text_payload(&text))
        }
        Ok(Some(Ok(TungsteniteMessage::Binary(bytes)))) => {
            format!("binary:{}bytes", bytes.len())
        }
        Ok(Some(Ok(TungsteniteMessage::Ping(_)))) => "ping".to_string(),
        Ok(Some(Ok(TungsteniteMessage::Pong(_)))) => "pong".to_string(),
        Ok(Some(Ok(TungsteniteMessage::Frame(_)))) => "frame".to_string(),
        Ok(Some(Err(err))) => format!("error:{err}"),
        Ok(None) => "ended".to_string(),
        Err(_) => "timeout".to_string(),
    }
}

/// 摘要文本帧，避免把完整响应或潜在敏感信息写入日志。
fn summarize_text_payload(text: &str) -> String {
    let parsed = serde_json::from_str::<Value>(text).ok();
    if let Some(value) = parsed {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("<no_type>");
        let status = value
            .get("status_code")
            .or_else(|| value.get("status"))
            .map(Value::to_string)
            .unwrap_or_else(|| "<none>".to_string());
        let code = value
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("<none>");
        return format!("json:type={kind},status={status},code={code}");
    }

    format!("non_json:{}chars", text.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验证 ChatGPT official HTTP URL 会转换为官方 WebSocket URL。
    #[test]
    fn test_chatgpt_codex_url_converts_to_wss() {
        let http_url = "https://chatgpt.com/backend-api/codex/responses";
        let ws_url = http_url
            .strip_prefix("https://")
            .map(|rest| format!("wss://{rest}"))
            .unwrap();
        assert_eq!(ws_url, "wss://chatgpt.com/backend-api/codex/responses");
    }

    /// 验证 WebSocket 内 fallback 事件保持 Codex 官方识别的 426 形状。
    #[test]
    fn test_fallback_event_shape_is_official_426() {
        let payload = json!({
            "type": "error",
            "status_code": 426,
            "error": {
                "message": "CC Switch route requires HTTP Responses fallback.",
                "type": "cc_switch_websocket_fallback",
                "code": "responses_websocket_not_supported"
            }
        });
        assert_eq!(payload["type"], "error");
        assert_eq!(payload["status_code"], 426);
    }

    /// 验证上游握手不会复用客户端到本地代理的 WebSocket hop-by-hop 头和占位鉴权。
    #[test]
    fn test_skip_client_ws_hop_by_hop_headers() {
        assert!(should_skip_client_ws_header("Sec-WebSocket-Key"));
        assert!(should_skip_client_ws_header("authorization"));
        assert!(should_skip_client_ws_header("connection"));
        assert!(!should_skip_client_ws_header("openai-beta"));
        assert!(!should_skip_client_ws_header("x-codex-window-id"));
        assert!(!should_skip_client_ws_header("originator"));
        assert!(!should_skip_client_ws_header("user-agent"));
    }

    /// 验证 chat route 位于第一候选时必须走 HTTP fallback，不能扫描后面的 official fallback。
    #[test]
    fn test_ws_candidate_does_not_skip_primary_chat_route_to_official_fallback() {
        let chat_provider = Provider::with_id(
            "route-qwen".to_string(),
            "Qwen route".to_string(),
            json!({
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "wire_api": "chat",
            }),
            None,
        );
        let official_provider = Provider::with_id(
            "route-official".to_string(),
            "Official fallback".to_string(),
            json!({
                "base_url": CHATGPT_CODEX_BASE_URL,
                "wire_api": "responses",
            }),
            None,
        );

        let err = select_official_ws_candidate(vec![chat_provider, official_provider])
            .expect_err("primary chat route must not be skipped to official fallback");
        assert!(err.to_string().contains("requires HTTP Responses fallback"));
    }

    /// 验证 official route 作为第一候选时仍允许透明 WebSocket relay。
    #[test]
    fn test_ws_candidate_accepts_primary_official_route() {
        let official_provider = Provider::with_id(
            "route-official".to_string(),
            "Official primary".to_string(),
            json!({
                "base_url": CHATGPT_CODEX_BASE_URL,
                "wire_api": "responses",
            }),
            None,
        );

        let selected = select_official_ws_candidate(vec![official_provider])
            .expect("primary official route should relay websocket");
        assert_eq!(selected.id, "route-official");
    }
}
