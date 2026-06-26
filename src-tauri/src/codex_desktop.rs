use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_CODEX_DEBUG_PORT: u16 = 9229;
const CDP_HTTP_TIMEOUT: Duration = Duration::from_secs(2);
const CDP_CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const CDP_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const MODEL_PICKER_PATCH_KEY: &str = "__ccSwitchCodexModelPickerUnlockV3";

/// Codex Desktop 模型菜单解锁命令的执行结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelPickerUnlockResult {
    pub attempted_ports: Vec<u16>,
    pub debug_port: Option<u16>,
    pub target_id: Option<String>,
    pub target_title: Option<String>,
    pub target_url: Option<String>,
    pub model_count: usize,
    pub model_names: Vec<String>,
    pub injected: bool,
    pub launched: bool,
    pub codex_executable: Option<String>,
    pub message: String,
}

/// 注入脚本需要的模型目录投影，避免把整个 catalog 私有字段泄漏到 renderer。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexModelCatalogProjection {
    default_model: Option<String>,
    model_names: Vec<String>,
    models: Vec<Value>,
}

/// Chrome DevTools Protocol `/json` 返回的页面 target 摘要。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct CdpTarget {
    id: String,
    #[serde(rename = "type")]
    target_type: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    web_socket_debugger_url: Option<String>,
}

/// 尝试解锁当前或新启动的 Codex Desktop 模型菜单。
///
/// 副作用：
/// - 若发现已开放 CDP 的 Codex renderer，会注入本地脚本；
/// - 若未发现 CDP 且 Codex 未运行，会以 remote debugging 参数启动 Codex。
pub async fn unlock_codex_model_picker() -> Result<CodexModelPickerUnlockResult, String> {
    let catalog = load_cc_switch_model_catalog_projection()?;
    let attempted_ports = candidate_debug_ports(DEFAULT_CODEX_DEBUG_PORT);

    if let Some(result) = try_inject_on_candidate_ports(&catalog, &attempted_ports).await {
        return Ok(result);
    }

    let running_main = detect_running_codex_main_process();
    if running_main.is_some() {
        return Ok(CodexModelPickerUnlockResult {
            attempted_ports,
            debug_port: None,
            target_id: None,
            target_title: None,
            target_url: None,
            model_count: catalog.model_names.len(),
            model_names: catalog.model_names,
            injected: false,
            launched: false,
            codex_executable: running_main.map(|path| path.display().to_string()),
            message: "Codex Desktop is already running without an injectable CDP port. Fully quit Codex, then launch it from CCSwitchMulti so the model picker patch can be installed.".to_string(),
        });
    }

    let executable = resolve_codex_executable()
        .ok_or_else(|| "Codex Desktop executable was not found".to_string())?;
    launch_codex_with_debug_port(&executable, DEFAULT_CODEX_DEBUG_PORT)?;

    let mut last_result = None;
    for _ in 0..30 {
        if let Some(result) =
            try_inject_on_candidate_ports(&catalog, &[DEFAULT_CODEX_DEBUG_PORT]).await
        {
            return Ok(CodexModelPickerUnlockResult {
                launched: true,
                codex_executable: Some(executable.display().to_string()),
                ..result
            });
        }
        last_result = Some(CodexModelPickerUnlockResult {
            attempted_ports: vec![DEFAULT_CODEX_DEBUG_PORT],
            debug_port: Some(DEFAULT_CODEX_DEBUG_PORT),
            target_id: None,
            target_title: None,
            target_url: None,
            model_count: catalog.model_names.len(),
            model_names: catalog.model_names.clone(),
            injected: false,
            launched: true,
            codex_executable: Some(executable.display().to_string()),
            message: "Codex was launched with remote debugging; waiting for the renderer target."
                .to_string(),
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(last_result.unwrap_or(CodexModelPickerUnlockResult {
        attempted_ports: vec![DEFAULT_CODEX_DEBUG_PORT],
        debug_port: Some(DEFAULT_CODEX_DEBUG_PORT),
        target_id: None,
        target_title: None,
        target_url: None,
        model_count: catalog.model_names.len(),
        model_names: catalog.model_names,
        injected: false,
        launched: true,
        codex_executable: Some(executable.display().to_string()),
        message: "Codex was launched, but no injectable renderer target appeared before timeout."
            .to_string(),
    }))
}

/// 从 cc-switch 生成的 catalog 中读取模型名和 renderer 需要的最小描述。
fn load_cc_switch_model_catalog_projection() -> Result<CodexModelCatalogProjection, String> {
    let catalog_path = crate::codex_config::get_codex_model_catalog_path();
    let catalog = crate::config::read_json_file(&catalog_path)
        .map_err(|error| format!("Failed to read {}: {error}", catalog_path.display()))?;
    let default_model = read_current_codex_default_model();
    let (model_names, models) = codex_model_entries_from_catalog_value(&catalog);
    if model_names.is_empty() {
        return Err(format!(
            "No models were found in {}",
            catalog_path.display()
        ));
    }
    Ok(CodexModelCatalogProjection {
        default_model: default_model.or_else(|| model_names.first().cloned()),
        model_names,
        models,
    })
}

/// 提取 catalog 内所有 Codex Desktop 可识别的模型条目。
fn codex_model_entries_from_catalog_value(catalog: &Value) -> (Vec<String>, Vec<Value>) {
    let Some(entries) = catalog
        .get("models")
        .and_then(Value::as_array)
        .or_else(|| catalog.as_array())
    else {
        return (Vec::new(), Vec::new());
    };

    let mut seen = BTreeSet::new();
    let mut names = Vec::new();
    let mut projected = Vec::new();

    for entry in entries {
        let Some(model_name) = codex_model_name(entry) else {
            continue;
        };
        if !seen.insert(model_name.clone()) {
            continue;
        }
        names.push(model_name.clone());
        projected.push(project_codex_model_descriptor(entry, &model_name));
    }

    (names, projected)
}

/// 从单个 catalog 条目中提取稳定模型名，兼容官方/旧版字段别名。
fn codex_model_name(entry: &Value) -> Option<String> {
    ["model", "slug", "id", "name"].into_iter().find_map(|key| {
        entry
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    })
}

/// 将 catalog 条目补齐成 renderer 可直接消费的模型描述。
fn project_codex_model_descriptor(entry: &Value, model_name: &str) -> Value {
    let mut object = entry.as_object().cloned().unwrap_or_default();
    for key in ["model", "slug", "id", "name"] {
        object.insert(key.to_string(), Value::String(model_name.to_string()));
    }
    if !object.contains_key("displayName") {
        let display = object
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or(model_name);
        object.insert(
            "displayName".to_string(),
            Value::String(display.to_string()),
        );
    }
    if !object.contains_key("display_name") {
        let display = object
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(model_name);
        object.insert(
            "display_name".to_string(),
            Value::String(display.to_string()),
        );
    }
    object.insert("hidden".to_string(), Value::Bool(false));
    object
        .entry("defaultReasoningEffort".to_string())
        .or_insert_with(|| Value::String("medium".to_string()));
    Value::Object(object)
}

/// 读取当前 Codex 默认模型，用于 renderer 动态配置的 default_model。
fn read_current_codex_default_model() -> Option<String> {
    let text = crate::codex_config::read_codex_config_text().ok()?;
    let parsed = text.parse::<toml::Value>().ok()?;
    parsed
        .get("model")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

/// 在候选 CDP 端口中寻找 Codex renderer 并安装模型白名单补丁。
async fn try_inject_on_candidate_ports(
    catalog: &CodexModelCatalogProjection,
    ports: &[u16],
) -> Option<CodexModelPickerUnlockResult> {
    for port in ports {
        let targets = match list_cdp_targets(*port).await {
            Ok(targets) => targets,
            Err(_) => continue,
        };
        let targets = match pick_codex_page_targets(&targets, *port) {
            Ok(targets) => targets,
            Err(_) => continue,
        };
        let script = build_model_picker_unlock_script(catalog);
        let mut injected_target = None;
        for target in targets {
            let Some(websocket_url) = target.web_socket_debugger_url.as_deref() else {
                continue;
            };
            if install_script(websocket_url, &script).await.is_ok() {
                injected_target.get_or_insert(target);
            }
        }
        let Some(target) = injected_target else {
            continue;
        };
        return Some(CodexModelPickerUnlockResult {
            attempted_ports: ports.to_vec(),
            debug_port: Some(*port),
            target_id: Some(target.id),
            target_title: Some(target.title),
            target_url: Some(target.url),
            model_count: catalog.model_names.len(),
            model_names: catalog.model_names.clone(),
            injected: true,
            launched: false,
            codex_executable: detect_running_codex_main_process()
                .map(|path| path.display().to_string()),
            message: "Codex Desktop model picker whitelist patch was injected.".to_string(),
        });
    }
    None
}

/// 生成去重后的 CDP 端口探测列表。
fn candidate_debug_ports(preferred: u16) -> Vec<u16> {
    let mut ports = vec![preferred, DEFAULT_CODEX_DEBUG_PORT, 9222, 9223, 9230, 9231];
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// 查询 CDP 页面 target。
async fn list_cdp_targets(debug_port: u16) -> Result<Vec<CdpTarget>, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(CDP_HTTP_TIMEOUT)
        .build()
        .map_err(|error| format!("failed to build CDP client: {error}"))?;
    let urls = [
        format!("http://127.0.0.1:{debug_port}/json"),
        format!("http://[::1]:{debug_port}/json"),
    ];
    let mut errors = Vec::new();
    for url in urls {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.json::<Vec<CdpTarget>>().await {
                    Ok(targets) => return Ok(targets),
                    Err(error) => errors.push(format!("{url}: invalid target JSON: {error}")),
                },
                Err(error) => errors.push(format!("{url}: {error}")),
            },
            Err(error) => errors.push(format!("{url}: {error}")),
        }
    }
    Err(errors.join("; "))
}

/// 选择最可能属于 Codex Desktop 的 renderer 页面。
///
/// 共享调试端口如 9222 可能属于 Chrome 或其它 Electron 应用，必须看到 Codex
/// 标识才注入；CCSwitchMulti 自己启动的默认 9229 允许在标题还没初始化时退回
/// 到第一个 page target。
fn pick_codex_page_targets(
    targets: &[CdpTarget],
    debug_port: u16,
) -> Result<Vec<CdpTarget>, String> {
    let pages = targets.iter().filter(|target| {
        target.target_type == "page"
            && target
                .web_socket_debugger_url
                .as_deref()
                .is_some_and(|url| !url.is_empty())
    });
    let mut all_pages = Vec::new();
    let mut codex_pages = Vec::new();
    for target in pages {
        all_pages.push(target.clone());
        if target_matches_codex_desktop(target) {
            codex_pages.push(target.clone());
        }
    }
    if !codex_pages.is_empty() {
        return Ok(codex_pages);
    }
    if debug_port == DEFAULT_CODEX_DEBUG_PORT && !all_pages.is_empty() {
        return Ok(all_pages);
    }
    Err("No Codex Desktop page target was found on shared CDP port".to_string())
}

/// 判断 CDP target 的标题或 URL 是否明确指向 Codex Desktop。
fn target_matches_codex_desktop(target: &CdpTarget) -> bool {
    let haystack = format!("{} {}", target.title, target.url).to_ascii_lowercase();
    haystack.contains("codex") || haystack.contains("app://")
}

/// 使用 CDP 同时安装新文档脚本并立即 patch 当前页面。
async fn install_script(websocket_url: &str, script: &str) -> Result<(), String> {
    let (socket, _) = tokio::time::timeout(CDP_CONNECT_TIMEOUT, connect_async(websocket_url))
        .await
        .map_err(|_| "timed out connecting CDP websocket".to_string())?
        .map_err(|error| format!("failed to connect CDP websocket: {error}"))?;
    let mut session = CdpSession::new(socket);
    session.send_command(1, "Runtime.enable", json!({})).await?;
    session.send_command(2, "Page.enable", json!({})).await?;
    session
        .send_command(
            3,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )
        .await?;
    session
        .send_command(
            4,
            "Runtime.evaluate",
            json!({
                "expression": script,
                "awaitPromise": true,
                "allowUnsafeEvalBlockedByCSP": true
            }),
        )
        .await?;
    Ok(())
}

/// 轻量 CDP websocket 会话，只处理 request/response。
struct CdpSession<S> {
    socket: S,
    responses: HashMap<u64, Value>,
}

impl<S> CdpSession<S>
where
    S: SinkExt<Message>
        + StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + Unpin,
    <S as futures::Sink<Message>>::Error: std::fmt::Display,
{
    fn new(socket: S) -> Self {
        Self {
            socket,
            responses: HashMap::new(),
        }
    }

    /// 发送 CDP 命令并等待对应 id 的响应。
    async fn send_command(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.socket
            .send(Message::Text(
                json!({ "id": id, "method": method, "params": params }).to_string(),
            ))
            .await
            .map_err(|error| format!("failed to send CDP command {method}: {error}"))?;
        tokio::time::timeout(CDP_COMMAND_TIMEOUT, self.wait_for_id(id, method))
            .await
            .map_err(|_| format!("timed out waiting for CDP command {method}"))?
    }

    /// 跳过无关 CDP 事件，直到拿到当前命令响应。
    async fn wait_for_id(&mut self, id: u64, method: &str) -> Result<Value, String> {
        loop {
            if let Some(response) = self.responses.remove(&id) {
                return cdp_command_result(response, method);
            }
            let Some(message) = self.socket.next().await else {
                return Err(format!("CDP websocket closed before {method} response"));
            };
            let message =
                message.map_err(|error| format!("failed to read CDP message: {error}"))?;
            let Message::Text(text) = message else {
                continue;
            };
            let value: Value = serde_json::from_str(&text)
                .map_err(|error| format!("failed to parse CDP message: {error}"))?;
            if let Some(response_id) = value.get("id").and_then(Value::as_u64) {
                if response_id == id {
                    return cdp_command_result(value, method);
                }
                self.responses.insert(response_id, value);
            }
        }
    }
}

/// 将 CDP error 响应转成普通错误。
fn cdp_command_result(response: Value, method: &str) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        Err(format!("CDP command {method} failed: {error}"))
    } else {
        Ok(response)
    }
}

/// 构造 renderer 注入脚本：修 Statsig 白名单、app-server model/list 和 React 缓存。
fn build_model_picker_unlock_script(catalog: &CodexModelCatalogProjection) -> String {
    let payload = serde_json::to_string(catalog).unwrap_or_else(|_| "{}".to_string());
    format!(
        r#"
(async () => {{
  const payload = {payload};
  const patchKey = "{MODEL_PICKER_PATCH_KEY}";
  const state = window[patchKey] || {{}};
  state.payload = payload;
  state.requestIds = state.requestIds || new Set();
  state.modulePromises = state.modulePromises || new Map();
  state.failures = state.failures || [];
  window[patchKey] = state;

  const reasoningEfforts = () => ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({{ reasoningEffort, description: `${{reasoningEffort}} effort` }}));
  const modelNames = () => Array.from(new Set([payload.defaultModel, ...(payload.modelNames || [])].filter((name) => typeof name === "string" && name.trim()).map((name) => name.trim())));
  const descriptorFor = (name) => {{
    const existing = (payload.models || []).find((model) => model && model.model === name);
    return {{
      model: name,
      id: name,
      slug: name,
      name,
      displayName: name,
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: reasoningEfforts(),
      ...(existing || {{}}),
      hidden: false,
    }};
  }};
  const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const modelArray = (value, allowEmpty = false) => Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((item) => item && typeof item === "object" && typeof item.model === "string");
  const patchModelNameArray = (models) => {{
    if (!stringArray(models)) return false;
    let changed = false;
    for (const name of modelNames()) {{
      if (!models.includes(name)) {{
        models.push(name);
        changed = true;
      }}
    }}
    return changed;
  }};
  const patchModelArray = (models, allowEmpty = false) => {{
    if (!modelArray(models, allowEmpty)) return false;
    const names = modelNames();
    const existing = new Map(models.map((model) => [model.model, model]));
    let changed = false;
    for (const model of models) {{
      if (names.includes(model.model) && model.hidden !== false) {{
        model.hidden = false;
        changed = true;
      }}
    }}
    for (const name of names) {{
      if (!existing.has(name)) {{
        models.push(descriptorFor(name));
        changed = true;
      }}
    }}
    return changed;
  }};
  const removeHiddenNames = (container, key) => {{
    if (!Array.isArray(container?.[key])) return false;
    const names = new Set(modelNames());
    const before = container[key].length;
    container[key] = container[key].filter((name) => !names.has(name));
    return before !== container[key].length;
  }};
  const patchNameSet = (setLike) => {{
    if (!(setLike instanceof Set)) return false;
    let changed = false;
    for (const name of modelNames()) {{
      if (!setLike.has(name)) {{
        setLike.add(name);
        changed = true;
      }}
    }}
    return changed;
  }};
  const patchModelContainer = (value) => {{
    if (!value || typeof value !== "object") return false;
    let changed = false;
    const looksLikeModelGate = "availableModels" in value || "available_models" in value || "useHiddenModels" in value || "use_hidden_models" in value || "defaultModel" in value || "default_model" in value;
    if (patchModelArray(value.models, "defaultModel" in value || "availableModels" in value || "available_models" in value)) changed = true;
    if (patchModelNameArray(value.models)) changed = true;
    if (patchModelArray(value.data)) changed = true;
    if (patchModelArray(value.result)) changed = true;
    if (patchModelArray(value.pages?.[0]?.data)) changed = true;
    if (patchModelArray(value.result?.data)) changed = true;
    if (patchModelArray(value.result?.models)) changed = true;
    if (patchModelArray(value.message?.result?.data)) changed = true;
    if (patchModelArray(value.message?.result?.models)) changed = true;
    if (patchNameSet(value.availableModels)) changed = true;
    if (patchNameSet(value.available_models)) changed = true;
    if (patchModelNameArray(value.availableModels)) changed = true;
    if (patchModelNameArray(value.available_models)) changed = true;
    if (removeHiddenNames(value, "hiddenModels")) changed = true;
    if (removeHiddenNames(value, "hidden_models")) changed = true;
    if (looksLikeModelGate && value.useHiddenModels !== false) {{
      value.useHiddenModels = false;
      changed = true;
    }}
    if (looksLikeModelGate && value.use_hidden_models !== false) {{
      value.use_hidden_models = false;
      changed = true;
    }}
    if (typeof value.default_model === "string" && modelNames().length && !modelNames().includes(value.default_model)) {{
      value.default_model = modelNames()[0];
      changed = true;
    }}
    if (value.defaultModel == null && modelNames().length > 0) {{
      value.defaultModel = descriptorFor(modelNames()[0]);
      changed = true;
    }}
    return changed;
  }};
  const patchObjectGraph = (root, visited = new WeakSet(), depth = 0) => {{
    if (!root || typeof root !== "object" || visited.has(root) || depth > 5) return false;
    visited.add(root);
    let changed = patchModelContainer(root);
    if (root instanceof Element || root === window || root === document || root === document.body || root === document.documentElement) return changed;
    for (const key of Object.keys(root)) {{
      if (["ownerDocument", "parentElement", "parentNode", "children", "childNodes"].includes(key)) continue;
      try {{
        if (patchObjectGraph(root[key], visited, depth + 1)) changed = true;
      }} catch {{}}
    }}
    return changed;
  }};
  const patchStatsigConfig = (config) => {{
    const value = config?.value;
    if (!value || typeof value !== "object") return config;
    const available = Array.isArray(value.available_models) ? [...value.available_models] : [];
    let changed = false;
    for (const name of modelNames()) {{
      if (!available.includes(name)) {{
        available.push(name);
        changed = true;
      }}
    }}
    const nextValue = {{ ...value, available_models: available, use_hidden_models: false, default_model: modelNames()[0] || value.default_model }};
    if (changed || nextValue.default_model !== value.default_model || value.use_hidden_models !== false) {{
      try {{
        config.value = nextValue;
      }} catch {{
        return {{ ...config, value: nextValue }};
      }}
    }}
    return config;
  }};
  const statsigClients = () => {{
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null];
    if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
    return clients.filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
  }};
  const patchStatsig = () => {{
    for (const client of statsigClients()) {{
      if (typeof client.getDynamicConfig !== "function") continue;
      if (!client.__ccSwitchModelWhitelistPatched) {{
        const original = client.getDynamicConfig.bind(client);
        client.getDynamicConfig = (name, options) => patchStatsigConfig(original(name, options));
        client.__ccSwitchModelWhitelistPatched = true;
      }}
      try {{ patchStatsigConfig(client.getDynamicConfig("107580212", {{ disableExposureLog: true }})); }} catch {{}}
    }}
  }};
  const assetUrl = (namePart) => {{
    const urls = [
      ...Array.from(document.scripts || []).map((script) => script.src),
      ...Array.from(document.querySelectorAll("link[href]") || []).map((link) => link.href),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].filter(Boolean);
    return urls.find((url) => url.includes("/assets/") && url.includes(namePart) && url.split("?")[0].endsWith(".js")) || "";
  }};
  const loadAppModule = async (namePart) => {{
    if (!state.modulePromises.has(namePart)) {{
      state.modulePromises.set(namePart, Promise.resolve().then(async () => {{
        const url = assetUrl(namePart);
        if (!url) throw new Error(`Codex App asset not found: ${{namePart}}`);
        return await import(url);
      }}).catch((error) => {{
        state.modulePromises.delete(namePart);
        throw error;
      }}));
    }}
    return await state.modulePromises.get(namePart);
  }};
  const appServerMethod = (method, params) => method === "send-cli-request-for-host" && params?.method ? String(params.method) : String(method || "");
  const patchAppServerResult = (method, result) => {{
    if (method !== "list-models-for-host") return result;
    if (Array.isArray(result)) patchModelArray(result, true);
    if (Array.isArray(result?.data)) patchModelArray(result.data, true);
    if (Array.isArray(result?.models)) patchModelArray(result.models, true);
    patchModelContainer(result);
    patchObjectGraph(result);
    return result;
  }};
  const patchRequestClient = (client) => {{
    if (!client || typeof client.sendRequest !== "function") return false;
    if (client.__ccSwitchModelRequestPatch === "1") return true;
    const original = client.__ccSwitchOriginalSendRequest || client.sendRequest.bind(client);
    client.__ccSwitchOriginalSendRequest = original;
    client.sendRequest = async function ccSwitchPatchedSendRequest(method, params, options) {{
      const result = await original(method, params, options);
      return patchAppServerResult(appServerMethod(method, params), result);
    }};
    client.__ccSwitchModelRequestPatch = "1";
    return true;
  }};
  const installAppServerPatch = async () => {{
    try {{
      const module = await loadAppModule("app-server-manager-signals-");
      for (const candidate of Object.values(module).filter((item) => item && typeof item === "object")) {{
        patchRequestClient(candidate);
        if (typeof candidate.sendRequest !== "function" && typeof candidate.get === "function") {{
          try {{ patchRequestClient(candidate.get()); }} catch {{}}
        }}
      }}
    }} catch (error) {{
      state.failures.push(String(error?.message || error));
    }}
  }};
  const patchMcpModelResponseData = (data) => {{
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const requestId = message?.id != null ? String(message.id) : "";
    if (state.requestIds.size > 0 && !state.requestIds.has(requestId)) return false;
    state.requestIds.delete(requestId);
    return patchModelContainer(data) || patchModelContainer(message) || patchModelContainer(message?.result) || patchModelContainer(message?.result?.data);
  }};
  const installMessagePatch = () => {{
    if (state.messagePatchInstalled) return;
    state.messagePatchInstalled = true;
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function ccSwitchPatchedDispatchEvent(event) {{
      try {{
        const detail = event?.detail;
        const request = detail?.request;
        if (event?.type === "codex-message-from-view" && detail?.type === "mcp-request" && request?.method === "model/list") {{
          request.params = {{ ...(request.params || {{}}), includeHidden: true }};
          if (request.id != null) state.requestIds.add(String(request.id));
        }}
        if (event?.type === "message") patchMcpModelResponseData(event.data);
      }} catch (error) {{
        state.failures.push(String(error?.message || error));
      }}
      return originalDispatchEvent.call(this, event);
    }};
    window.addEventListener("message", (event) => {{
      try {{ patchMcpModelResponseData(event?.data); }} catch (error) {{ state.failures.push(String(error?.message || error)); }}
    }}, true);
  }};
  const installResponsePatch = () => {{
    if (state.responsePatchInstalled || typeof Response === "undefined") return;
    state.responsePatchInstalled = true;
    const originalJson = Response.prototype.json;
    Response.prototype.json = async function ccSwitchPatchedResponseJson(...args) {{
      const data = await originalJson.apply(this, args);
      try {{ patchModelContainer(data); patchObjectGraph(data); }} catch (error) {{ state.failures.push(String(error?.message || error)); }}
      return data;
    }};
  }};
  const reactFiberKeys = (element) => Object.keys(element || {{}}).filter((key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance") || key.startsWith("__reactProps"));
  // Codex app-server 会根据 requires_openai_auth 暴露 OAuth 状态；旧配置或缓存状态
  // 可能把 renderer 留在非 chatgpt 模式，这里只修复前端 context，不改请求路由。
  const authContextValueFrom = (element) => {{
    for (const key of reactFiberKeys(element)) {{
      for (let fiber = element?.[key]; fiber; fiber = fiber.return) {{
        for (const value of [fiber.memoizedProps?.value, fiber.pendingProps?.value]) {{
          if (value && typeof value === "object" && typeof value.setAuthMethod === "function" && "authMethod" in value) return value;
        }}
      }}
    }}
    return null;
  }};
  const spoofChatGPTAuthMethod = (element) => {{
    const auth = authContextValueFrom(element);
    if (!auth || auth.authMethod === "chatgpt") return false;
    try {{
      auth.setAuthMethod("chatgpt");
      return true;
    }} catch (error) {{
      state.failures.push(String(error?.message || error));
      return false;
    }}
  }};
  const patchReactState = () => {{
    const visited = new WeakSet();
    const nodes = [document.body, ...document.querySelectorAll("button, [role='menu'], [role='dialog'], [data-radix-popper-content-wrapper]")].filter(Boolean);
    for (const node of nodes.slice(0, 220)) {{
      spoofChatGPTAuthMethod(node);
      for (const key of reactFiberKeys(node)) patchObjectGraph(node[key], visited);
    }}
  }};
  const run = () => {{
    installResponsePatch();
    installMessagePatch();
    void installAppServerPatch();
    patchStatsig();
    patchReactState();
  }};
  run();
  if (!state.interval) state.interval = setInterval(run, 1500);
  return {{ status: "ok", modelCount: modelNames().length, available_models: modelNames(), patchKey }};
}})()
"#
    )
}

/// 启动 Codex Desktop，并传入 remote debugging 参数。
fn launch_codex_with_debug_port(executable: &Path, debug_port: u16) -> Result<(), String> {
    if let Some(running) = detect_running_codex_main_process() {
        return Err(format!(
            "Codex Desktop is already running at {}. Fully quit Codex, then launch it from CCSwitchMulti so the model picker patch can be installed.",
            running.display()
        ));
    }
    let mut command = Command::new(executable);
    command
        .arg(format!("--remote-debugging-port={debug_port}"))
        .arg(format!(
            "--remote-allow-origins=http://127.0.0.1:{debug_port}"
        ));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to launch {}: {error}", executable.display()))
}

/// 查找 Codex Desktop 主进程路径；已运行但未开放 CDP 时不能原地注入。
fn detect_running_codex_main_process() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -notmatch ' --type=' } |
  Select-Object -First 1 -ExpandProperty ExecutablePath
"#;
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(PathBuf::from(text))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 按常见安装位置寻找 Codex Desktop 可执行文件。
fn resolve_codex_executable() -> Option<PathBuf> {
    detect_running_codex_main_process()
        .filter(|path| path.exists())
        .or_else(find_latest_windows_codex_executable)
}

/// 在 WindowsApps 中选择版本最新的 Codex Desktop。
#[cfg(target_os = "windows")]
fn find_latest_windows_codex_executable() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    if let Some(program_files) = std::env::var_os("ProgramW6432") {
        roots.push(PathBuf::from(program_files).join("WindowsApps"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\WindowsApps"));
    roots.sort();
    roots.dedup();

    let mut candidates = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.starts_with("OpenAI.Codex_") {
                continue;
            }
            for executable in windows_codex_package_executable_candidates(&path) {
                if executable.exists() {
                    candidates.push((version_tuple_from_package_name(name), executable));
                    break;
                }
            }
        }
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0));
    candidates
        .pop()
        .map(|(_, executable)| executable)
        .or_else(find_local_windows_codex_executable)
}

#[cfg(not(target_os = "windows"))]
fn find_latest_windows_codex_executable() -> Option<PathBuf> {
    None
}

/// WindowsApps 包内的 Codex Desktop 可执行文件候选路径。
///
/// MSIX 包布局随版本变化过：有的版本直接在 `app/Codex.exe`，有的把可执行文件
/// 放到 `app/resources`。只接受大写 `Codex.exe`，避免把 CLI launcher 当 Desktop。
fn windows_codex_package_executable_candidates(package_root: &Path) -> Vec<PathBuf> {
    vec![
        package_root.join("app").join("Codex.exe"),
        package_root.join("app").join("resources").join("Codex.exe"),
        package_root.join("Codex.exe"),
    ]
}

#[cfg(target_os = "windows")]
fn find_local_windows_codex_executable() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local_app_data).join("OpenAI").join("Codex");
        roots.push(root.clone());
        roots.push(root.join("app"));
    }

    for root in roots {
        let executable = root.join("Codex.exe");
        if executable.exists() {
            return Some(executable);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn find_local_windows_codex_executable() -> Option<PathBuf> {
    None
}

/// 从 WindowsApps 包目录名解析版本号，供排序使用。
fn version_tuple_from_package_name(name: &str) -> Vec<u32> {
    name.strip_prefix("OpenAI.Codex_")
        .and_then(|rest| rest.split_once('_').map(|(version, _)| version))
        .map(|version| {
            version
                .split('.')
                .filter_map(|part| part.parse::<u32>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_projection_accepts_model_and_slug_fields() {
        let value = json!({
            "models": [
                { "model": "qwen3.6", "display_name": "Qwen 3.6" },
                { "slug": "deepseek-v4-flash", "displayName": "DeepSeek V4 Flash" },
                { "id": "gpt-5.4-mini" }
            ]
        });
        let (names, models) = codex_model_entries_from_catalog_value(&value);
        assert_eq!(names, vec!["qwen3.6", "deepseek-v4-flash", "gpt-5.4-mini"]);
        assert!(models.iter().all(|model| model["hidden"] == false));
        assert_eq!(models[0]["displayName"], "Qwen 3.6");
    }

    #[test]
    fn model_picker_unlock_script_patches_renderer_whitelists() {
        let catalog = CodexModelCatalogProjection {
            default_model: Some("qwen3.6".to_string()),
            model_names: vec!["qwen3.6".to_string(), "deepseek-v4-flash".to_string()],
            models: vec![json!({ "model": "qwen3.6", "hidden": false })],
        };
        let script = build_model_picker_unlock_script(&catalog);
        assert!(script.contains("qwen3.6"));
        assert!(script.contains("deepseek-v4-flash"));
        assert!(script.contains("available_models"));
        assert!(script.contains("use_hidden_models: false"));
        assert!(script.contains("107580212"));
        assert!(script.contains("list-models-for-host"));
        assert!(script.contains("model/list"));
        assert!(script.contains("__ccSwitchCodexModelPickerUnlockV3"));
        assert!(script.contains("auth.setAuthMethod(\"chatgpt\")"));
    }

    #[test]
    fn shared_cdp_port_requires_explicit_codex_target() {
        let targets = vec![CdpTarget {
            id: "chrome-page".to_string(),
            target_type: "page".to_string(),
            title: "Chrome".to_string(),
            url: "https://example.com".to_string(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9222/devtools/page/1".to_string()),
        }];

        assert!(pick_codex_page_targets(&targets, 9222).is_err());
    }

    #[test]
    fn windows_codex_package_candidates_cover_known_desktop_layouts() {
        let root = PathBuf::from(r"C:\Program Files\WindowsApps\OpenAI.Codex_26.608.1.0_x64__id");
        let candidates = windows_codex_package_executable_candidates(&root);

        assert!(candidates.contains(&root.join("app").join("Codex.exe")));
        assert!(candidates.contains(&root.join("app").join("resources").join("Codex.exe")));
        assert!(!candidates.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == "codex.exe")
        }));
    }

    #[test]
    fn default_cdp_port_allows_initializing_codex_page() {
        let targets = vec![CdpTarget {
            id: "codex-page".to_string(),
            target_type: "page".to_string(),
            title: String::new(),
            url: String::new(),
            web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
        }];

        let targets = pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT)
            .expect("default Codex CDP port should allow early blank targets");
        assert_eq!(targets[0].id, "codex-page");
    }

    #[test]
    fn codex_cdp_port_injects_all_matching_pages() {
        let targets = vec![
            CdpTarget {
                id: "codex-main".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "app://codex/index.html".to_string(),
                web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/1".to_string()),
            },
            CdpTarget {
                id: "codex-dialog".to_string(),
                target_type: "page".to_string(),
                title: "Codex".to_string(),
                url: "app://codex/dialog.html".to_string(),
                web_socket_debugger_url: Some("ws://127.0.0.1:9229/devtools/page/2".to_string()),
            },
        ];

        let picked = pick_codex_page_targets(&targets, DEFAULT_CODEX_DEBUG_PORT)
            .expect("all Codex targets should be injectable");
        assert_eq!(
            picked
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            vec!["codex-main", "codex-dialog"]
        );
    }
}
