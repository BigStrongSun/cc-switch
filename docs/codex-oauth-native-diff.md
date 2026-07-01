# Codex OAuth 接管与原生请求差异调研

本文档记录 `Selected model is at capacity` 排查中的可复用取证办法。目标是先比较原生 Codex 和 CCSwitchMulti OAuth 接管路径的请求形态，再决定是否需要 TLS 抓包。

## 路径边界

- 纯原生：Codex 直接调用官方 ChatGPT Codex OAuth 后端。
- 当前接管：Codex 调用本地 `127.0.0.1:<port>/v1`，再由 CCSwitchMulti route 转到官方 `https://chatgpt.com/backend-api/codex/responses`。
- 第三方中转：Codex/MultiRouter route 命中非官方 OpenAI-compatible 上游。

## 已知源码差异点

- 原生 Codex `ResponsesApiRequest` 会发送 `store`、`stream`、`include`、`prompt_cache_key`、可选 `service_tier` 和 `client_metadata`。
- 原生 Codex 会过滤 `service_tier = "default"`，只有模型 catalog 支持且配置为非默认值时才发送。
- 原生 Codex 会把 `prompt_cache_key` 默认设为 thread id，并在 `client_metadata` 中写入 `x-codex-installation-id`。
- CCSwitchMulti Codex OAuth adapter 会把本地 `/v1/responses` 归一化到官方 `/backend-api/codex/responses`，并添加 `originator: cc-switch`。
- CCSwitchMulti 对 Responses-Lite 采用负缓存 fallback：只有上游明确返回不支持 Lite header 的错误时，才去头重试。

## 工具

### 采集当前机器状态

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/codex-oauth-diagnostics.ps1 -LogTailLines 1200 -SinceMinutes 60
```

输出位于 `scripts/logs/codex-oauth-diagnostics/<timestamp>`，默认包含：

- `config.sanitized.toml`：脱敏后的 Codex live config。
- `auth.metadata.json`：只含 token 长度/短哈希的 auth 元数据。
- `router-events.json`：解析后的 `codex-router.log` 事件。
- `router-events.capacity-or-error.json`：非 2xx 或疑似 capacity 事件。

### 比对请求形态

内置自检：

```powershell
node scripts/codex-request-shape-compare.mjs --self-test --out scripts/logs/codex-request-shape-compare/self-test
node scripts/codex-request-shape-compare.mjs --serve-self-test --out scripts/logs/codex-request-shape-compare/serve-self-test
```

使用已有捕获 JSON：

```powershell
node scripts/codex-request-shape-compare.mjs --native native-request.json --proxy proxy-request.json --out scripts/logs/codex-request-shape-compare/manual
```

启动 mock 并运行外部 harness：

```powershell
node scripts/codex-request-shape-compare.mjs --serve --native-command "<run native harness>" --proxy-command "<run proxy harness>"
```

mock 模式会提供这些环境变量给外部命令：

- `CODEX_COMPARE_BASE_URL`
- `CODEX_COMPARE_NATIVE_BASE_URL`
- `CODEX_COMPARE_PROXY_BASE_URL`

外部请求可用 header `x-codex-compare-side: native|proxy` 或 query `?side=native|proxy` 标记归属。未标记时，第一条请求按 native，第二条请求按 proxy。

## 判断顺序

1. 先用 `codex-oauth-diagnostics.ps1` 确认报错时 route 是否命中官方 OAuth、第三方 route 或本地模型。
2. 若命中官方 OAuth，检查同 trace 的 `service_tier`、request shape、Responses-Lite fallback 和上游 status。
3. 用 `codex-request-shape-compare.mjs` 比对原生与接管路径的 `service_tier`、`prompt_cache_key`、`client_metadata`、`originator`、account id 和 session/window id。
4. 只有字段级 diff 无法解释问题，或线上原生与接管行为仍稳定分叉时，再进入 Fiddler/mitmproxy 抓包。
