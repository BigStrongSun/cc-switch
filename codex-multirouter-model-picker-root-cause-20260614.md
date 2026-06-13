# Codex MultiRouter 模型候选只显示 3 个的根因记录

日期：2026-06-14

## 结论

MultiRouter 的 provider id 名字不是根因。根因是当前版本在 Codex takeover 已经生效后，保存或同步当前 provider 时只刷新了 live backup，没有把当前 provider 的 `modelCatalog` 重新投影到 Codex live 文件：

- `%USERPROFILE%\.codex\config.toml`
- `%USERPROFILE%\.codex\cc-switch-model-catalog.json`
- `%USERPROFILE%\.codex\models_cache.json`

因此 DB/UI 里的 MultiRouter 目录可以已经包含 OpenAI / Qwen / DeepSeek 的完整 7 个模型，但 Codex Desktop app-server 仍继续读取旧的三模型 catalog/cache。

## 旧版 CCSwitchMulti 行为

2026-06-08 附近的旧实现先通过 built-in `openai` + `openai_base_url` 让 Codex 自己刷新 `/models`，所以菜单能拿到完整候选。后来为了避免 built-in `openai` provider 触发路由、历史 bucket、WebSocket 和转换层退化，MultiRouter 改为稳定的 custom provider 桶 `codex_model_router_v2`。

这个 custom provider 路线必须由 CC Switch 主动写入 `model_catalog_json`，并同步 `models_cache.json`，否则 Codex Desktop 只会沿用旧缓存或默认 OpenAI 候选。

## 官方 cc-switch 行为

官方 cc-switch 把 Codex 候选模型作为 provider 私有配置保存：

- DB provider 的 `settings_config.modelCatalog` 是 SSOT。
- 写 live config 时投影为顶层 `model_catalog_json`。
- 生成 `.codex/cc-switch-model-catalog.json` 供 Codex 读取。
- 官方表单也把模型映射描述为生成 Codex `model_catalog_json`，并提示 catalog 变化后需要刷新 Codex 运行态。

官方实现重点不是 provider id，而是 provider 的 `modelCatalog` 是否被投影到 Codex 实际读取的 live catalog。

## 当前坏版本差异

切换 provider 路径已经正确：

- `ProxyService::sync_codex_live_from_provider_while_proxy_active`
- `ProxyService::write_codex_takeover_live_for_provider`
- `codex_config::prepare_codex_config_text_with_model_catalog`
- `codex_config::sync_codex_models_cache_with_cc_switch_catalog`

但是三个 provider 同步入口缺少同样的 Codex live 热同步：

- `ProviderService::update`
- `ProviderService::sync_current_provider_for_app`
- `provider/live.rs::sync_current_provider_for_app_respecting_takeover`

这些路径在 takeover 期间只调用 `update_live_backup_from_provider`，随后返回。结果是备份里有新 provider，live config/catalog/cache 仍然是旧三模型状态。

## 本次修复

在上述三个入口里，Codex 当前 provider 处于 takeover 或代理正在运行时，更新 backup 后继续调用：

`state.proxy_service.sync_codex_live_from_provider_while_proxy_active(provider)`

这样保存或同步当前 MultiRouter provider 时会重新生成：

- stable custom provider：`model_provider = "codex_model_router_v2"`
- 顶层 `model_catalog_json = "cc-switch-model-catalog.json"`
- `cc-switch-model-catalog.json` 的完整 OpenAI/Qwen/DeepSeek 候选
- `models_cache.json` 的完整 hot picker 候选

同时不回退 built-in `openai` provider，也不引入新的 WebSocket relay。

## 回归测试

扩展了 `switching_codex_router_provider_auto_enables_dedicated_local_takeover`：

1. 切换到 MultiRouter 后断言 live config、catalog、models_cache 有完整 7 模型。
2. 人为把 live catalog/cache 写回旧三模型状态。
3. 保存当前 provider，断言自动恢复完整 7 模型。
4. 再次写回旧三模型状态。
5. 单应用同步当前 provider，断言自动恢复完整 7 模型。
6. 再次写回旧三模型状态。
7. 全量同步当前 provider，断言自动恢复完整 7 模型。

这覆盖了用户实际遇到的“DB/UI 已经完整，但 Codex Desktop 仍显示 3 个 OpenAI 模型”的状态。
