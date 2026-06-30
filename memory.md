# CC Switch Repository Memory

## 2026-06-30 Codex MultiRouter Wizard Small Window Layout Fix

- 用户截图显示 Codex MultiRouter 向导在较小窗口、尤其接近 Tauri 默认 `1000x650` / 最小 `900x600` 时底部按钮区被裁掉。根因不是向导状态机或步骤跳转，而是 `CodexMultiRouterWizard` 中间 grid 使用 `max-h-[82vh]`，但外层没有整体高度约束，最终高度约等于 header + `82vh` + footer，默认高度下会超过视口。
- 修复边界：只调整 `src/components/codex/CodexMultiRouterWizard.tsx` 的遮罩弹窗布局。外层 overlay 改成 flex 居中并 `overflow-hidden`，向导 shell 改为 `max-h-full flex flex-col min-h-0`，header/footer `shrink-0`，中间 body `flex-1 min-h-0 overflow-hidden`，右侧内容和左侧步骤栏各自滚动。不要通过单纯提高 `tauri.conf.json` 默认窗口高度来掩盖问题，因为用户仍可能缩小窗口或恢复旧窗口状态。
- 回归测试落点：`tests/components/CodexMultiRouterWizard.test.tsx` 断言向导 shell/body/footer 的关键布局类，避免后续把高度约束重新放回 `82vh` 内容区。验证命令：`pnpm vitest run tests/components/CodexMultiRouterWizard.test.tsx`、`pnpm typecheck`、`pnpm build:renderer`、`git diff --check`。浏览器直接打开 Vite renderer 会因缺少 Tauri IPC 出现 `window.__TAURI__` 相关错误，只能作为有限页面加载检查；完整交互仍以 Tauri 桌面或组件测试为准。

## 2026-06-30 Codex MultiRouter Post-Setup Validation Refresh

- 用户追问“配置完返回的校验和刷新流程”，排查范围仍只限 Codex MultiRouter。现有成功判定已经正确：`StatusTab` 只在本地代理运行、Codex 接管、当前 provider 是选中 MultiRouter、入口/规则启用，并且当前方案 route 有真实成功转发证据时才触发 `onRuntimeReady`，不会因为其它 Codex 请求 200 就提前进入历史修复。
- 新发现的刷新体验缺口：向导 finish 页启用 MultiRouter 后，父级只 `invalidateQueries` proxyStatus/proxyTakeoverStatus/providers，状态页要等轮询或后台 refetch 才显示最新监听/接管/current provider/日志；用户配置完返回后可能短时间看到旧校验状态。修复为启用后显式 `refetchQueries` proxyStatus、proxyTakeoverStatus、providers/codex 和 usage/logs。
- 状态页新增“刷新校验”手动入口：刷新同一组校验源并显示完成/失败提示，便于用户从 Codex 发出一次请求后立即重新检查链路卡片、最近转发和历史修复触发条件。不改变成功判定、route 归因、诊断探测或模型源刷新逻辑。
- 继续排查其它 Codex 跳转入口后发现：工具栏直接打开 Codex MultiRouter 时如果只 `setCurrentView("codexRouter")`，会沿用上一次 `codexRouterWorkspaceTarget` 的 provider/tab。修复为统一走 `openCodexRouterWorkspace(null, "status")`；工作台内部 tab 跳转新增滚动容器 `scrollTo({ top: 0 })`，避免从长页面切到状态/模型源/测试页时停留旧滚动位置。历史修复跳转已有 `SessionManagerPage` 测试覆盖一次性消费，不需要改。

## 2026-06-30 Codex MultiRouter Configuration Guide Navigation Audit

- 用户明确收窄排查范围：只处理 Codex 分支配置和 Codex 多路路由配置指南，不泛化到 Claude Desktop、Gemini、OpenCode、OpenClaw 或 Hermes。上一轮误扩展改动已撤回，当前只沿 `CodexRouterWorkspacePage` / `CodexMultiRouterWizard` / Codex provider 表单查同类“点击后状态已变但用户看不到下一步”的问题。
- 新发现的真实 Codex-only 缺口：`CodexRouterWorkspacePage` 已从 `App` 接收 `onCreateProvider`，但参数被命名为 `_onCreateProvider` 后没有使用；在工作台没有普通 Codex 模型源、RouteCandidatePicker 为空时，只提示“先添加至少一个 Codex 模型源”并提供“关闭”，用户无法从配置指南链路直接打开 Codex 模型源添加面板。
- 修复边界：只在 Codex MultiRouter 工作台接入已有 `onCreateProvider` 回调，给“模型源”页和“没有可选 router”空状态提供“添加模型源”；同时给行内展开的候选 router 选择器 / MultiRouter 设置面板加 `scrollIntoView({ behavior: "smooth", block: "nearest" })`，避免点击“编辑匹配规则/创建多路路由”后面板在视口下方导致再次误判为卡死。不改 route 保存、provider 协议、modelCatalog、wizard 状态机或非 Codex app。
- 回归测试落点：`src/components/codex/CodexRouterWorkspacePage.test.ts` 覆盖无模型源时点击“添加模型源”会触发父级回调，以及打开“编辑匹配规则”后滚到行内 RouteCandidatePicker。

## 2026-06-30 MultiRouter Provider Preset Click Perceived Freeze Fix

- 用户截图里“创建多路路由 -> 单独接入模型源”点击 `Zhipu GLM` 后并不是走 `UniversalProviderPanel`，而是 `ProviderForm(appId="codex") -> ProviderPresetSelector -> handlePresetChange("codex-<index>")`。`Zhipu GLM` 来自 `src/config/codexProviderPresets.ts`，不在 `universalProviderPresets`。
- 只读追踪确认 GLM 预设切换会一次性批量更新 Codex auth/config/modelCatalog/reasoning/takeover/form reset，但 `CodexFormFields` 的 catalog/routing 父子回写已有 ref + JSON 比对守卫，没有发现无限 setState 循环。用户感知“卡死”的主要交互根因是预设网格很高，点击后仍停在预设按钮区，API Key/Base URL/模型映射等实际要填写的字段在下方首屏外，视觉上像没有继续。
- 修复边界：`src/components/providers/forms/ProviderForm.tsx` 给 Codex 字段区加 `ref`，在 Codex 新建模式选择任意预设或自定义模型源后，用 `setTimeout(0)` 等 React 提交完成再 `scrollIntoView({ behavior: "smooth", block: "start" })`，把视口带到关键配置区；不改 GLM 协议、modelCatalog、reasoning 或保存逻辑。
- 回归测试：`tests/components/ProviderForm.codexPreset.test.tsx` 直接渲染 `ProviderForm appId="codex"`，先后点击 `DeepSeek` 与 `Zhipu GLM` 两个不同 Codex 预设，断言对应 Base URL、GLM 的 `glm-5.2` catalog、本地接管开启，并确认每次选择都触发滚动；配合 `tests/components/CodexFormFields.test.tsx` 验证 catalog/routing 受控回写仍稳定。

## 2026-06-30 Promote v3.16.4-4wizard To Latest Release

- 用户在 GitHub releases 列表截图里看到 `v3.16.4-3` 仍显示 `Latest`，原因不是 `main` 未推送，而是 `v3.16.4-4wizard` 仍标记为 prerelease。GitHub 只会把 `Latest` 标给正式 release，prerelease 即使发布时间更新也不会替代正式版 latest。
- 已将 BigStrongSun/ccswitchmulti 的 `v3.16.4-4wizard` release 从 prerelease 改为正式 release，并通过 `gh release edit ... --latest` 显式标记为 Latest；该 tag 的 peeled commit 已在上一轮指向 `main` 的 `15c2d728ae04b857a5531859ce911de6c2665b57`。后续判断“页面看不到 latest”时要先检查 `isPrerelease` 和 GitHub 的 explicit latest 标记，不要只看 tag/main 是否推送。

## 2026-06-29 Merge Wizard Trial Branch Into Main

- 用户纠正 `v3.16.4-4wizard` 不能只停留在 `codex/multirouter-wizard` 分支：需要把 wizard 试用线合入 `main`。合并前确认 `main...codex/multirouter-wizard` 为 `0 41`，即 `main` 没有独有提交、wizard 分支领先 41 个提交。
- 合并策略：在 `main` 上执行非快进 merge `codex/multirouter-wizard`，保留一个明确 merge commit，避免 `main` 静默快进导致后续溯源不清。未跟踪的 `docs/release-notes/v3.16.4-4-zh.md` 和 `scripts/logs/` 仍保持未跟踪状态，不纳入合并或提交。
- 合入内容包括 MultiRouter 向导、协议/缓存能力修复、Hermes/usage upstream bugfix、Windows 图标根修复、网站图标导出以及 `3.16.4-4wizard` 版本面。后续若刷新 `v3.16.4-4wizard` release，tag 应指向 `main` 上的 merge/memory 提交，而不是仅指向 wizard 分支提交。

## 2026-06-29 MultiRouter Wizard Provider Config Protocol Display Fix

- 用户试用向导时反馈配置核心参数页误导：`OpenAI Official Backup` 显示“API 格式：未显式设置，向导保存路由时默认 Chat Completions”，同时“已有模型目录”provider 显示“未配置在线获取参数”。根因是 `CodexMultiRouterWizard` 配置页直接读 `meta.apiFormat/settingsConfig.apiFormat` 和本地 `/models` 抓取参数，没有复用 `inferWizardApiFormat()` 这条已经用于保存 route 的事实来源。
- 修复边界：配置页的 API 格式展示必须和最终 route 生成一致。官方 OpenAI/OAuth 或暴露 GPT/O 原生 Responses 模型的 provider，即使旧 metadata 写 `openai_chat` 或未写，也显示/保存为 `Responses API`；未知第三方没有实测结果时才保守显示 Chat Completions。若旧配置和推断不同，UI 要明确说“向导推断，已覆盖旧配置”，避免用户以为 official 会走 Chat。
- `/models` 获取能力和可路由模型目录是两回事：没有 Base URL/API Key 只代表不能在线刷新模型列表，不代表不能生成路由。已有 `modelCatalog` 的 provider 应显示“已有 modelCatalog，可跳过 /models 在线读取；如需刷新再补 Base URL/API Key”，不要再写“未配置在线获取参数”这种像错误的提示。
- 回归测试：`tests/components/CodexMultiRouterWizard.test.tsx` 覆盖 catalog-only provider 不显示旧提示，以及 `OpenAI Official Backup` 带旧 `openai_chat` metadata 时配置页展示 `Responses API` 并提示覆盖旧配置；数据层已有 `inferWizardApiFormat` 测试覆盖最终 route 保存为 `openai_responses`。

## 2026-06-29 CCSwitchMulti v3.16.4-4wizard Iconfix Release Refresh

- 按用户要求将既有 GitHub prerelease `v3.16.4-4wizard` 更新到任务栏图标根修复后的最新提交。先推送 `codex/multirouter-wizard`，再强制移动 annotated tag `v3.16.4-4wizard`，确保 peeled tag 指向最新提交而不是旧 `ea455656...`。
- Windows 资产使用 `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.4-4wizard-iconfix-assets` 覆盖上传：setup、setup.sig、portable zip、raw exe、`latest.json`、`README.md`、`RELEASE-METADATA.md`、Linux/macOS build notes 和合并版 `SHA256SUMS.txt`。既有 macOS `.dmg/.app.zip` 资产保留，因为 Windows 主机未重建 macOS 包。
- 上传后验证：远端 `refs/tags/v3.16.4-4wizard^{}` 指向任务栏图标修复提交；关键 Windows asset digest 为 setup `4a1b3edc...`、portable `10c7eaa5...`、raw exe `248cb88b...`、latest.json `15f54d63...`。`SHA256SUMS.txt` 同时包含新 Windows 资产和保留的 macOS 资产 digest。

## 2026-06-29 Windows Taskbar Icon Embedded Resource Root Fix

- 用户再次截图反馈任务栏图标仍像白色圆团后，重新沿真实链路排查：`src-tauri/icons/icon.ico` 已更新且小帧仍是 DIB，但 `src-tauri/target/release/cc-switch.exe` 与 `%LOCALAPPDATA%\CCSwitchMulti\cc-switch.exe` 的 `ExtractAssociatedIcon()` hash 仍是旧值。根因不是安装覆盖失败，而是 Cargo/Tauri 构建复用了旧 `resource.lib`，`build.rs` 没有声明 `icons/icon.ico`/相关 PNG 为 `rerun-if-changed`。
- 修复：`src-tauri/build.rs` 显式声明 `icons/icon.ico`、`32x32.png`、`128x128.png`、`128x128@2x.png` 和 `tauri.conf.json` 的构建依赖。修改图标后必须触发 native resource 重新生成，不能只看 `icon.ico` 文件时间。
- 图标生成策略调整：`scripts/generate-windows-icons.py` 不再手绘一套任务栏小图；`16/24/32/48/64` 也从 `assets/brand/ccswitchmulti-codex-app-icon-1024.png` 缩放生成，保持任务栏、安装器、应用内和网站图标同一个品牌 master。ICO 小帧仍写入 32-bit DIB，保留 Windows shell 兼容性。
- 安装链路补强：`src-tauri/nsis/installer-hooks.nsh` 继续修开始菜单/桌面快捷方式，并额外修存在时的任务栏固定项 `CCSwitchMulti.lnk`；`scripts/verify-windows-install-icon.ps1` 也检查可选任务栏固定项。
- 验证：运行 `python scripts/generate-windows-icons.py` 和 `python -m py_compile scripts/generate-windows-icons.py`；执行 `cargo clean --manifest-path src-tauri\Cargo.toml -p cc-switch` 后重新 `scripts\export-latest-ccswitchmulti.ps1 -ReleaseRoot C:\Users\sunda\Documents\LLMservice\ccswitchmulti-iconfix-install`，确认源 `icon.ico`、`src-tauri\target\release\cc-switch.exe`、raw exe 的 associated icon hash 全部为 `3E1F633E16DBD922D6A7A4538B1450276803745DDCC20C0BE5F8AB3875A9F3E5`；静默安装后 `scripts\verify-windows-install-icon.ps1` 通过，安装目录 exe hash 与源 ico 一致，开始菜单/桌面快捷方式 `IconLocation` 均为 `%LOCALAPPDATA%\CCSwitchMulti\cc-switch.exe,0`。刷新 Explorer 图标缓存并重启安装版后，任务栏截图确认图标为暗色圆角底的新品牌图。

## 2026-06-29 Codex MultiRouter 502 Official Route Diagnosis

- 用户截图里 `OpenAI Multi-Model Router` 在 `06/29 16:07` 连续出现 5 条 502，但同一时间段 `codex-router.log` 证明每次都已命中 `route_id=openai-official`，`effective_provider=codex-openai-router::route::openai-official`，`effective_endpoint=/responses`，`upstream_url=https://chatgpt.com/backend-api/codex/responses`，`responses_to_chat=false`，`auth_strategy=CodexOAuth`。因此这不是 route miss、不是官方 GPT 被错误转 Chat、也不是模型重名映射错误。
- 502 的直接原因是本机转发到官方 Codex Responses 上游时连接失败：`upstream_send_error ... elapsed_ms=3121/3128/4127 error=请求转发失败:_连接失败:_error_sending_request_for_url_(https://chatgpt.com/backend-api/codex/responses)`。数据库对应 5 条 `status_code=502`，随后 `16:07:20` 同一 session/model/route 立刻成功 200，说明是间歇性出站连接问题。
- 网络边界证据：当场 `Resolve-DnsName chatgpt.com` 返回 `198.18.0.6`（常见代理/TUN fake-ip 网段），`Test-NetConnection chatgpt.com -Port 443` 当前成功；CCSwitchMulti 日志显示 `GlobalProxy Initialized: direct connection`，WinHTTP 也是 direct。也就是说 CCSM 没有显式走全局代理，而是依赖系统 TUN/fake-ip 接管；502 更像本机代理/TUN/VPN 或官方链路短时抖动，不是 CCSM MultiRouter 配置本身。
- 修复一个会误导排障的产品问题：失败路径历史上会把 usage/error 落库到外层 router provider，导致 UI 只显示 `OpenAI Multi-Model Router` 502。`src-tauri/src/proxy/handlers.rs` 现在在 forward error 落库前复用 Codex route 解析和 target materialize 逻辑，把失败归因修正到真实 route/effective provider；未来同类失败应显示 `codex-openai-router::route::openai-official` 等 route 身份。

## 2026-06-29 CCSwitchMulti v3.16.4-4wizard Wizard Prerelease

- `v3.16.4-4wizard` 已作为 BigStrongSun/ccswitchmulti 的 GitHub 预发布版发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.4-4wizard`。这是 `codex/multirouter-wizard` 分支的向导试用包，`isPrerelease=true`、`isDraft=false`，不是正式无向导 release 线。
- 本地 release pipeline 成功导出到 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，构建 metadata 指向提交 `ea455656521b8e53cbb448788ecb679f0b29e0b5`，版本面为 `3.16.4-4wizard`。本地 staging 目录为 `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.4-4wizard-assets`。
- GitHub release 上传 10 个资产：`CCSwitchMulti_3.16.4-4wizard_x64-setup.exe`、安装包 `.sig`、`CCSwitchMulti_3.16.4-4wizard_x64-portable.zip`、`CCSwitchMulti_3.16.4-4wizard_x64.exe`、`latest.json`、`SHA256SUMS.txt`、`linux-build-note.md`、`macos-build-note.md`、`RELEASE-METADATA.md`、`v3.16.4-4wizard-zh.md`。Linux/macOS 仍只上传平台构建说明，Windows 本地未生成正式二进制。
- 发布后验证：`latest.json` 版本为 `3.16.4-4wizard`；raw exe 的 `FileVersion/ProductVersion` 为 `3.16.4-4wizard`；GitHub asset digest 与本地主资产 SHA256 对齐，安装包为 `85825ada0fb485cc8c533e972c0cfce2717f87e9f3d5d60ef86aefc90c271c67`，portable zip 为 `5bcb76ef458f4bde734f4759fad79c69efee0a702a3cfabb044731f5285f5144`，raw exe 为 `61ee6f96129c512c88805faed1bac7bb42b54516dbf9933f2c3b9e123ecf05db`。
- 注意：`gh release view` 的 `targetCommitish` 可能显示 `main`，但 annotated tag `v3.16.4-4wizard` 本身的 tag object 指向 `ea455656521b8e53cbb448788ecb679f0b29e0b5`。在 PowerShell 里查询 peeled tag 必须给 `v3.16.4-4wizard^{}` 加引号，否则 `^`/`{}` 可能被 shell 或宿主参数解析干扰，出现误导输出。
- 发布时仍保留未跟踪文件 `docs/release-notes/v3.16.4-4-zh.md` 和 `scripts/logs/`：前者是无向导 release note，不能混入 wizard 试用 release；后者是本地日志/构建产物，不应随 release memory commit 提交。

## 2026-06-29 Windows Taskbar Icon Compatibility Fix

- 用户截图确认任务栏图标问题更像 Windows shell 兼容性/缓存问题，不是单纯 1024 源素材低清。根因排查：旧 `src-tauri/icons/icon.ico` 虽含 `16/24/32/48/64/128/256` 全尺寸，但所有 frame 都是 PNG-in-ICO；部分 Windows 任务栏、Explorer 缓存或快捷方式场景会对 PNG 小帧抽取/缩放异常，出现发糊或旧缓存视觉。
- 新增 `scripts/generate-windows-icons.py` 作为可复现图标生成脚本：`16/24/32/48/64` 使用专门为任务栏简化的高对比小图，并写入传统 32-bit DIB ICO frame；`128/256` 仍使用品牌 1024 图压缩为 PNG frame；同时更新 Tauri PNG、Windows Square logo 和应用内 `src/assets/icons/app-icon.png`。
- 验证点：解析 `src-tauri/icons/icon.ico` 时 `16/24/32/48/64` 的 frame 签名应为 `28 00 00 00...`（DIB），`128/256` 为 PNG；不要再回退到所有 frame 都是 PNG 的 ICO。实际安装后仍需确认快捷方式 `IconLocation` 为 `%LOCALAPPDATA%\CCSwitchMulti\cc-switch.exe,0`，并在 Windows 图标缓存较旧时重启 Explorer 或清理 icon cache。

## 2026-06-29 CCSwitchMulti v3.16.4-4 No-Wizard Release Boundary

- 用户确认 v3.16.4-3 不应作为正式无向导版发布，因为 tag `v3.16.4-3` 指向的 `1534a0e45dc17acd4b792de484f1c6b724cb7e18` 来自 `codex/multirouter-wizard`，仍包含 `CodexMultiRouterWizard`、`codexMultiRouterWizard` helper、ProviderList 的“配置多路模型”入口和向导测试。
- 正确修正策略不是删除或破坏 `codex/multirouter-wizard` 分支里的向导功能；wizard 分支要保留用于继续试用/迭代。正式无向导 release 应从不含向导的基线/分支切出，只合入已确认正式要带的 bugfix、provider 拆分、Responses-Lite fallback、子 Agent 用量统计、Windows 图标安装链路和 spawn_agent 模型可见性修复。
- 以后用户要求“发布当前版本”但近期分支名或 commit 含 `wizard/trial/easy` 时，必须先确认是否是试用向导包还是正式无向导包；不要直接从 `codex/multirouter-wizard` HEAD 打正式 release，也不要为了正式 release 在 wizard 分支上删除向导代码。

## 2026-06-29 CCSwitchMulti v3.16.4-3 Formal Release

- 2026-06-29 继续完善 MultiRouter 向导和单独 Codex provider 的协议探测：真实连通性测试必须先弹确认框，明确会向上游发送 `/v1/responses` 与 `/v1/chat/completions` 请求，可能消耗额度/流量/触发限流，输出上限为 1024 而不是 1。判断策略改为双协议结果矩阵：两者都通或仅 Responses 通时优先 Responses，仅 Chat 通时切到 Chat Completions，两者都不通时不能说成“不支持 Responses”，应提示 API Key、Base URL、模型权限、额度、网络或上游故障等更宽的失败边界。
- 2026-06-29 进一步明确：`/v1/responses` 探测通过不等于完整 Codex 功能正常。它只证明 Base URL/API Key/模型名/最小非流式 Responses 请求可用；完整功能还要看真实 Codex 会话里的 SSE/流式输出、工具调用、reasoning/上下文、多模态、限流稳定性、MultiRouter route 命中和历史修复后的 Desktop 状态。UI 文案必须称为“基础协议测试/基础请求可用”，不能把它包装成全功能验收。
- 2026-06-29 缓存命中调研结论：不要把“给 probe 加几个 Codex header”当成缓存验证。OpenAI/Codex prompt cache 主要依赖长前缀精确匹配、`prompt_cache_key` 路由、可选 `prompt_cache_retention`、body 前缀稳定和 `usage.prompt_tokens_details.cached_tokens`；DeepSeek Context Caching 默认自动启用，依赖后续请求完整复用已持久化的前缀单元，usage 字段是 `prompt_cache_hit_tokens/prompt_cache_miss_tokens`；Z.AI/GLM Context Caching 同样自动识别重复 system prompt/历史/长文档，并在 `usage.prompt_tokens_details.cached_tokens` 显示命中。适配优先级应是：保持真实 Codex OAuth 路径原生 Responses 不被转 Chat；Responses->Chat 转换要稳定 messages/tools/system 前缀和 canonical JSON；只对明确支持 OpenAI cache 参数的 Chat 上游考虑透传 `prompt_cache_key/prompt_cache_retention`，不能对 DeepSeek/GLM 一刀切注入未知字段。
- 2026-06-29 深度调研后的缓存适配边界：CCSM 的缓存适配应做成 provider/route capability，而不是把“Responses 探测成功”或“Chat 探测成功”当缓存结论。官方 OpenAI/Codex OAuth 走原生 Responses 并保留真实 client-provided session identity；OpenAI-compatible Chat 只有在明确声明支持 OpenAI prompt cache 参数时才透传 `prompt_cache_key/prompt_cache_retention`；DeepSeek/Z.AI/GLM 默认走自动前缀缓存，不注入 OpenAI 私有 cache 参数；Qwen/DashScope 兼具 Responses、隐式缓存和 `cache_control` 显式缓存，需按协议能力声明而非只按 provider 名称处理。当前代码缺口主要是：MultiRouter `CodexRoutingCapabilities` 无 cache capability 层；DeepSeek `prompt_cache_hit_tokens/prompt_cache_miss_tokens` 未统一映射到 `cache_read_tokens/input_tokens`；`openai_chat` 转换没有 cache capability gate；向导应展示“缓存兼容性/真实 usage 证据”，不要把基础连通性测试说成缓存命中验证。
- 2026-06-29 已实现缓存适配第一阶段：`ProviderMeta`/route capabilities 新增 `codexCache` capability 和 `promptCacheRetention`；MultiRouter route 物化时会把 `capabilities.codexCache` 带入运行时 meta，Codex Responses→Chat 转换只在 `cacheMode=openai_prompt_cache` 或显式 supports 时透传 `prompt_cache_key/prompt_cache_retention`，DeepSeek/GLM/Qwen 自动缓存路由不会收到 OpenAI 私有 cache 参数；Claude→Responses 增加显式 `promptCacheRetention` 支持，但 Codex OAuth 反代路径会移除 retention 以避免未确认参数触发 400；usage parser 现在能把 DeepSeek `prompt_cache_hit_tokens` 和 Qwen/DashScope details 里的 `cache_creation_input_tokens` 记入缓存统计。向导 route 预览页会显示每条 route 的缓存策略摘要，提示真实缓存命中看 usage 而不是基础连通性测试。
- 2026-06-29 修订 MultiRouter 向导收尾状态机边界：状态页进入“配置成功 -> 历史修复”不能只看任意最新 Codex proxy log 为 2xx/3xx；必须看到当前选中的 MultiRouter plan 的 route 有成功转发证据。`StatusTab` 现在用当前方案聚合后的 `trafficRows.successCount > 0` 作为 `currentRouteForwardOk`，只有当前 provider、代理监听、Codex 接管、路由入口和当前方案 route 转发都成立时才触发 `onRuntimeReady`。回归测试覆盖“不相关 provider/model 的成功日志不能触发历史修复交接”。
- 2026-06-29 `codex/multirouter-wizard` 合并 `main` 时确认 `main` 已是当前分支祖先，`git merge main` 返回 Already up to date；本轮只把向导试用版本面统一改为 `3.16.4-4wizard`（`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`）。该版本号用于区分 wizard 试用构建，不代表无向导正式发布线。
- 2026-06-29 检查遗漏 bugfix 时同步远端发现 `upstream/main` / `origin/main`（`farion1231/cc-switch` 原版）新增两个明确修复并已 cherry-pick 到 `codex/multirouter-wizard`：`d1f6c74b` 修复 usage_script 凭据覆盖只应保存显式不同值，避免 provider 主 API Key/Base URL 修改后用量查询仍走旧覆盖；`61d7ac01` 修复 Windows Hermes 配置目录解析，按 settings override、`HERMES_HOME`、平台默认 `%LOCALAPPDATA%\hermes` 顺序对齐 Hermes 自身行为。`d1f6c74b` 与当前分支 provider live-config 保护逻辑在 `ProviderService` 函数区冲突，解决方式是同时保留 usage credential normalize 和 `codex_provider_requires_local_proxy`。
- 2026-06-29 按用户要求准备 `easy` 后缀试用包：版本面从 `3.16.4-3` 临时同步为 `3.16.4-3-easy`，用于重新打包验证 MultiRouter 向导更宽窗口、首页说明简化和步骤不回跳修复。该版本是本地试用包命名，不代表新的正式 GitHub release。
- 2026-06-29 `3.16.4-3-easy` 本地 Windows 试用包已由 post-commit pipeline 成功导出到 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，metadata 指向 `codex/multirouter-wizard` 的 `50499816cd3fcfd3c80fcc28ec156d011a855480`。可试用文件包括 `windows/installer/CCSwitchMulti_3.16.4-3-easy_x64-setup.exe`、`windows/portable/CCSwitchMulti_3.16.4-3-easy_x64-portable.zip`、`windows/raw-exe/CCSwitchMulti_3.16.4-3-easy_x64.exe`；`SHA256SUMS.txt` 覆盖 easy 资产，raw exe `FileVersion/ProductVersion=3.16.4-3-easy` 已验证。
- 2026-06-29 修复 MultiRouter 向导继续试用反馈：向导遮罩层级为 `z-[120]`，普通 `AddProviderDialog` 的 `FullScreenPanel` 只有 `z-[60]`，所以在向导第 2 步点击“添加 Provider/添加模型源”会像没反应；现在 `FullScreenPanel` 支持传入层级，App 只在向导打开时把 Add Provider 面板提升到 `z-[140]`。配置核心参数页也改为三态显示：可自动获取模型、已有模型目录可继续、需补全配置；创建模型源和配置页的 provider 卡片区有独立滚动高度，避免必须拉高整个窗口才能看到后续 provider。
- 2026-06-29 修复 MultiRouter 向导重名策略和官方协议推断：旧 `aliasModelName()` 取 `provider.id` 第一段，自动 ID 会生成 `3ecd52c8-gpt-*` 这类不可读前缀；现在第三方重名模型统一用 `模型名-provider展示名` 后缀，官方 OpenAI/订阅源保留原名，多个第三方互冲突时各自加 provider 名后缀并保留 `upstreamModel`。官方 OpenAI GPT/O 模型源即使旧 metadata 写 `openai_chat`，向导也生成 `openai_responses` route；OpenAI-compatible 中转不能仅因名字包含 openai 被当官方源。
- 2026-06-29 继续修正向导协议来源：旧 provider 可能因为历史保存、复制、混合协议拆分或第三方预设把 `meta.apiFormat/settingsConfig.apiFormat` 留成 `openai_chat`；向导不能把这个字段当最终真相。现在保存和预览前会把用户显式 `/v1/responses` 连通性测试结果应用到草稿，实测通过的 provider 自动提升为 `openai_responses`，失败/警告/跳过才保留旧 chat 或默认策略，避免一边探测通过一边仍生成 chat route。
- `v3.16.4-3` 已作为 BigStrongSun/ccswitchmulti 的 GitHub formal release 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.4-3`。Release 为非 draft、`prerelease=false`，发布时间为 `2026-06-29T02:02:35Z`，annotated tag `v3.16.4-3` 的 peeled commit 为 `1534a0e45dc17acd4b792de484f1c6b724cb7e18`（`chore(release): prepare CCSwitchMulti v3.16.4-3`）。
- 本地 Windows release pipeline 成功，导出目录为 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，完成时间 `2026-06-29 09:56:35 +08:00`。`latest.json` 版本为 `3.16.4-3`，updater URL 指向 `https://github.com/BigStrongSun/ccswitchmulti/releases/download/v3.16.4-3/CCSwitchMulti_3.16.4-3_x64-setup.exe`；raw exe `CCSwitchMulti_3.16.4-3_x64.exe` 的 FileVersion/ProductVersion 均验证为 `3.16.4-3`。
- 本次 release 上传 9 个资产：`CCSwitchMulti_3.16.4-3_x64-setup.exe`、安装包 `.sig`、`CCSwitchMulti_3.16.4-3_x64-portable.zip`、`CCSwitchMulti_3.16.4-3_x64.exe`、`latest.json`、`SHA256SUMS.txt`、`linux-build-note.md`、`macos-build-note.md`、中文 release note `v3.16.4-3-zh.md`。Linux/macOS 正式二进制仍未在 Windows 本地生成，只提供平台构建说明。
- 发布前验证覆盖：`pnpm typecheck`；`pnpm vitest run tests/components/CodexFormFields.test.tsx tests/components/AddProviderDialog.test.tsx tests/components/ProviderList.test.tsx tests/components/CodexMultiRouterWizard.test.tsx tests/lib/codexMultiRouterWizard.test.ts`；`cargo fmt --manifest-path src-tauri\Cargo.toml --check`；`cargo test --manifest-path src-tauri\Cargo.toml codex_model_catalog --lib`；`cargo test --manifest-path src-tauri\Cargo.toml codex_subagent_usage_stats --lib`；`cargo test --manifest-path src-tauri\Cargo.toml responses_lite --lib`；`git diff --check`。
- 发布过程中曾有一次手动 pipeline 与 post-commit pipeline 重叠，导致 Tauri artifact lock 等待；最终采用 post-commit pipeline 导出的 `3.16.4-3` 资产发布，并停止了冗余 `tmpC017` Tauri build 进程。以后 release 前如果已经触发 post-commit pipeline，先等 `scripts/logs/post-commit-release.log` 完成，避免再手动启动第二条 `tauri build`。

## 2026-06-28 Codex MultiRouter Wizard Implementation

- 2026-06-29 修复 MultiRouter 向导试用反馈的三处 UI/流程问题：遮罩窗口从 `max-w-5xl` 放宽为接近 1280px 的 `96vw` 宽度，内容区高度提高到 `82vh`，左侧步骤列加宽，避免默认窗口下 provider/路由组件挤压；第一页文案改为先说明“接入模型源、读取模型并处理重名、生成分流规则、启用并修复历史记录”四件用户任务，`127.0.0.1:15721` 等技术细节降级为备注。
- 这次“点到第 2 步又跳回第 1 步”的真实根因是 `CodexMultiRouterWizard` 在 `open/providers/existingPlan` effect 中每次 props identity 变化都会重新 `dispatchFlow({ type: "INIT" })`。`App.tsx` 原来 inline 传 `Object.values(providers)`，任意父级 rerender 都可能生成新数组，导致向导被重置。修复方式是向导内用 `initializedOpenRef` 保证每次打开只初始化一次，另设 provider 同步 effect 只追加/移除打开期间新建或删除的普通 Codex provider，不再派发 `INIT`；`App.tsx` 同时 memoize `codexWizardProviders` 降低无意义 props 变化。
- 2026-06-29 已为上述 UI/流程修复导出新的本地试用包 `3.16.4-3`：导出目录仍是 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，`RELEASE-METADATA.md` 指向 `codex/multirouter-wizard` 的 `1534a0e45dc17acd4b792de484f1c6b724cb7e18`，可试用文件包括 `windows/installer/CCSwitchMulti_3.16.4-3_x64-setup.exe`、`windows/portable/CCSwitchMulti_3.16.4-3_x64-portable.zip`、`windows/raw-exe/CCSwitchMulti_3.16.4-3_x64.exe`。手动触发的 pipeline 与 post-commit pipeline 并发时返回过一次 `tauri build failed with exit code -1`，但 post-commit pipeline 随后完成导出；最终 `SHA256SUMS.txt` 和 raw exe `FileVersion/ProductVersion=3.16.4-3` 已验证。
- 分支 `codex/multirouter-wizard` 新增 Codex 首页底部居中的 `配置多路模型` 入口，落点是 `ProviderList` 的 Codex 专属 CTA；空 Provider 列表也会显示该入口，右上角原有 MultiRouter 工作台图标入口保持不变。
- 新增遮罩式 `CodexMultiRouterWizard`：Portal 到 `document.body`，黑色 fixed overlay，按教程顺序引导理解本地 `15721` MultiRouter、创建模型源、检查 API Key/Base URL/API 格式、自动获取 `/models`、处理重名模型、生成按 provider 分组的 route、保存发布、显式启用并打开工作台 `test` 页。
- 2026-06-28 追加状态机改造：`CodexMultiRouterWizard` 不再只是 `stepIndex` 线性向导，而是由 `wizardFlowReducer` 显式维护 `opened/needSources/reviewProviderConfig/configIncomplete/readyToFetchModels/fetchingModels/modelFetchPartial/modelsFetched/collisionReviewRequired/routePreview/savingPlan/saveFailed/published/enablePrompt/enabling/enableFailed/enabled/completed/dismissed` 等状态。左侧步骤点击会映射到对应业务状态；下一步按钮会做 gate，例如无模型源停在 `needSources`，配置缺口进入 `configIncomplete`，保存失败进入 `saveFailed` 并展示错误。
- 状态机辅助数据落在 `src/lib/codexMultiRouterWizard.ts`：`getWizardConfigIssues()` 判断缺 Base URL/API Key 且没有可用 modelCatalog 的 provider；`collectWizardModelNameCollisions()` 收集同一 upstreamModel 被多个 provider 暴露的冲突，供向导进入 `collisionReviewRequired` 并提示别名策略。模型刷新现在复用 `mergeFetchedModelsIntoWizardProvider()`，保留已有手写字段。
- 新增 `src/lib/codexMultiRouterWizard.ts` 作为可单测数据层：普通 Codex provider 才作为模型源，MultiRouter provider 通过 `settingsConfig.codexRouting` 识别并排除；官方/OAuth 源没有普通 `/models` 时使用保守官方 catalog 兜底；第三方/中转站与官方同名模型会生成可见别名并保留 `upstreamModel` 指向真实上游模型。
- 向导保存策略：草稿留在 React state；只有点击“保存并发布”才调用 `providersApi.add/update` 写入带 `codexRouting` 和 `modelCatalog` 的 MultiRouter provider；不会静默切换当前 Codex provider，完成页“启用这个多路路由”复用 App 里的 `switchProvider` 路径，让既有 Codex 本地接管、PROXY_MANAGED、OAuth 保留逻辑继续生效。
- 路由生成策略：每个模型源一条 route，使用 `targetProviderId` + `auth.source="provider_config"`，不复制第三方 API Key/Base URL，不写 `requires_openai_auth`；默认按 provider/model 文本推断 `gpt`/`o`、`deepseek`、`qwen` 等前缀。
- 验证：`pnpm vitest run tests/components/ProviderList.test.tsx src/components/codex/CodexRouterWorkspacePage.test.ts tests/components/CodexFormFields.test.tsx tests/components/ProviderForm.codexCatalog.test.ts tests/components/CodexMultiRouterWizard.test.tsx tests/lib/codexMultiRouterWizard.test.ts` 通过；`pnpm typecheck` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml codex_model_catalog --lib`、`model_fetch --lib`、`switching_codex_router_provider_auto_enables_dedicated_local_takeover --lib` 均通过。`pnpm format:check` 当前失败在两个未参与本次改动的既有文件 `src/components/codex/CodexRouterWorkspacePage.tsx` 和 `src/components/providers/forms/CodexFormFields.tsx`，本次未扩大 diff 去格式化无关大文件。
- 状态机改造验证：`pnpm vitest run tests/components/ProviderList.test.tsx src/components/codex/CodexRouterWorkspacePage.test.ts tests/components/CodexFormFields.test.tsx tests/components/ProviderForm.codexCatalog.test.ts tests/components/CodexMultiRouterWizard.test.tsx tests/lib/codexMultiRouterWizard.test.ts` 通过，48 tests passed；`pnpm typecheck` 通过；`git diff --check` 针对本次状态机改动文件通过。
- 2026-06-29 补齐向导每一步“异常/可继续”规则和真实 Responses 连通性探测：`CodexMultiRouterWizard` 的每个步骤卡片会展示本步骤可能失败的边界和继续条件；`fetchModels` 步骤新增用户显式点击的“测试 /v1/responses 连通性”，对每个普通 Codex provider 的可见模型发送最小 `input="ping"`、`max_output_tokens=1`、`stream=false` 请求，避免在自动刷新模型时静默消耗额度。
- 连通性状态机新增 `probingConnectivity/connectivityPassed/connectivityPartial/connectivityFailed`。`openai_responses` provider 的 `/v1/responses` 探测失败是阻塞项，不能保存发布；`openai_chat` provider 的直接 Responses 失败只是 warning，因为运行时 MultiRouter 会转到 `/chat/completions`；缺 Base URL/API Key 且已有 `modelCatalog` 时允许继续但标为 skipped，缺配置且没有目录时阻塞。
- 后端命令 `probe_codex_responses_for_config` 在 `src-tauri/src/commands/model_fetch.rs`，只做显式探测不缓存结果。URL 生成会把 provider 根地址、`/v1`、完整 `/v1/chat/completions` 或直接 `/v1/responses` 都收敛到 `/v1/responses`；HTTP 错误、网络错误和超时都结构化返回 `ok/status/url/model/detail`，错误体截断到 512 字符，避免 UI/日志被上游 HTML 或长 JSON 淹没。
- 本轮为满足全局格式检查，额外对既有 `src/components/codex/CodexRouterWorkspacePage.tsx` 做了纯 Prettier 格式化，不改业务逻辑；`pnpm format:check` 现在通过。
- 2026-06-29 继续补强异常可见性：`CodexMultiRouterWizard` 新增向导级 `wizardIssues` 列表，所有异步 catch 不能只发 toast，必须写入 UI 问题面板并标明 `错误/警告`、provider、异常详情和 `可继续/需处理后继续`。当前覆盖 `/models` 单 provider 失败、整体刷新中断、`/v1/responses` IPC/命令异常、保存失败、启用失败，以及用户尝试越过阻塞连通性结果的场景。
- 2026-06-29 补齐 MultiRouter 向导发布后的自动收尾：用户点击“启用这个多路路由”后，App 会先启动 CCSwitchMulti 本地代理，再打开 Codex live 接管，随后切换当前 Codex provider 到该 MultiRouter 方案并打开工作台 `status` 页。状态页不会只因配置态全绿就提示成功，必须同时看到最近一次 Codex 代理转发为 2xx/3xx，确保“当前链路、监听、Codex 接管、路由入口、最近转发”都成功后才 toast “配置成功”并跳到 Codex 历史修复页。
- 2026-06-29 完整引导交接细化：`CodexMultiRouterWizard` 启用成功后必须自动关闭遮罩，让用户看到 App 已打开的 MultiRouter `status` 页；toast 明确要求去 Codex 发送一次请求，等待当前链路、监听、Codex 接管、路由入口和最近转发都成功。向导里的“打开工作台”也改为打开 `status` 页，不再跳 `test` 页，避免绕开五项状态验证。
- 2026-06-29 入口选择规则：Codex 首页底部 `配置多路模型` 不再直接打开向导，而是每次先弹出入口选择面板；用户可以随时关闭退出，也可以选择“开始引导配置”进入遮罩式向导，或选择“直接打开工作台”进入 MultiRouter `status` 页。这个选择不受 dismissed localStorage 影响，确保用户再次点击入口仍可决定是否开启引导。
- 历史修复页新增向导收尾入口：`SessionManagerPage` 通过一次性 `initialCodexHistoryRepair` 自动打开 `CodexHistoryRepairPanel` 并消费标记；自动跳转进入时面板顶部会显示历史修复点击顺序：加载历史、预览修复、确认写入、完整重启 Codex、打开 GitHub 仓库点 Star。真实应用历史修复成功后回调 App，提示用户完整重启 Codex，然后先请求用户给 CCSwitchMulti GitHub 仓库点 Star，再用默认浏览器打开 `https://github.com/BigStrongSun/ccswitchmulti`。如果后续引导回调失败，只报“历史修复已完成，但后续引导失败”，不能把修复本身标记为失败。
- 2026-06-29 已为 MultiRouter 向导试用打本地 Windows 包：运行 `scripts/local-release-pipeline.ps1 -Reason manual-multirouter-wizard-test` 成功，导出目录 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，metadata 指向分支 `codex/multirouter-wizard`、提交 `214bc5b4650e20d3de7cc13a3ff113cda63b00c4`、版本 `3.16.4-2`。可试用文件包括 `windows/installer/CCSwitchMulti_3.16.4-2_x64-setup.exe`、`windows/portable/CCSwitchMulti_3.16.4-2_x64-portable.zip`、`windows/raw-exe/CCSwitchMulti_3.16.4-2_x64.exe`；这是本地试用包，不是正式 release bump。

## 2026-06-28 Mixed Relay Responses Capability Boundary

- 当前 MultiRouter 对 Codex `/responses` 的上游协议选择是 route/effective-provider 级配置判定，不是模型级在线能力探测。运行时入口是 `src-tauri/src/proxy/providers/codex.rs::explain_codex_responses_upstream_protocol`，优先看 managed `codex_oauth`、`meta.apiFormat`、`settings_config.apiFormat/api_format`、已知 chat-only base_url、`config.toml wire_api`，最后默认原生 Responses。
- 对“同一个中转里既有 GPT/Responses 模型，也有 Qwen/DeepSeek 等 Chat-only 模型”的正确现有用法是拆成多条 route：GPT/Responses 模型 route 写 `upstream.apiFormat=openai_responses`，Chat-only 模型 route 写 `upstream.apiFormat=openai_chat`。如果 route 引用 `targetProviderId`，`materialize_codex_routed_provider_from_target` 会继承目标 provider 的 base_url/auth/apiFormat；因此同一个目标 provider 不能天然表达“部分模型 responses、部分模型 chat”，除非拆成两个 provider 或使用内联 route 覆盖协议。
- 目前 `/models` 刷新只读取模型 id、owned_by、context_window 等元数据并写回 `modelCatalog`，`CodexCatalogModel` 和 `CodexRoutingCapabilities` 只有图片/文本/推理相关能力，没有 `supportsResponses` / per-model `apiFormat` 字段。状态页“协议探测”读取配置判定和 `codex-router.log` 最近真实请求的 `effective_endpoint/responses_to_chat`，不会主动请求远端 `/v1/responses`，所以不会自动发现某个模型不支持 Responses。
- 若后续实现在线探测，应做成显式手动/批量按钮而不是自动刷新时静默执行：对每个候选模型发最小 `/v1/responses` 探测请求，识别 404/405/400 unsupported endpoint/model 等结果并缓存到 provider `modelCatalog.models[].supportsResponses` 或 `apiFormat`；探测会消耗额度、可能触发供应商限流，也可能误判“模型不支持”与“账号无权限/渠道暂不可用”，因此结果应带时间戳、错误摘要和手动覆盖入口。
- 2026-06-28 普通 Codex provider 新增表单“获取模型”路径加入保守拆分提示：当 `/models` 同时返回 GPT-like（如 `gpt-*`、OpenAI namespace 下的 gpt、o 系列）和非 GPT-like 模型，且当前表单还没有用户手写 route 时，`CodexFormFields` 只弹出“检测到混合协议模型”确认框，不会静默写入 routing。用户确认后只记录提交意图并打开本地接管；真正点击新增时由 `AddProviderDialog` 生成两个独立 provider：`<providerName>-responses` 写 `meta.apiFormat=openai_responses` 且只保留 Responses 模型目录，`<providerName>-chat` 写 `meta.apiFormat=openai_chat` 且只保留 Chat 模型目录；用户取消时只保留已获取的模型列表，routing、provider 拆分意图和 apiFormat 都不变。编辑已有 provider 时不启用自动拆 provider，避免“编辑 A 生成 B/C”的危险行为。

## 2026-06-28 Responses-Lite Header Retry Fallback Policy

- 用户指出“第三方一律剥 `x-openai-internal-codex-responses-lite`”仍然过宽，因为未来第三方上游可能支持 Responses-Lite，提前砍掉 header 可能影响它们自己的 Lite 路径、prompt cache 或其它能力协商。策略已改成 optimistic pass-through：默认保留该 header 发给上游，只有上游明确返回 `This model is not supported when using X-OpenAI-Internal-Codex-Responses-Lite.` 这类错误时，才剥离 header 并对同一个 provider 重发一次。
- 实现落点仍在 `src-tauri/src/proxy/forwarder.rs`。发送前不再调用静态 strip helper；错误响应体读取并解压后调用 `should_retry_without_codex_responses_lite_header()` 判断，条件是 `AppType::Codex`、请求里确实有 Lite header、状态码为 `400/404/422/501` 之一、错误体包含精确 Lite 不支持文本。命中后记录 `upstream_retry_without_responses_lite`，移除该 header 后只重试一次；普通 400、非 Codex app、无 header 或错误体不匹配都不重试。
- 2026-06-28 进一步改为带过期时间的短期能力负缓存，避免同一上游/模型在连续请求里每次都先失败一次。缓存是内存态，TTL 为 24 小时，key 按 effective provider id、上游 URL 的 scheme/host/port/path、实际请求模型隔离，并忽略 query 以避免敏感参数进入缓存 key。命中缓存时直接去掉 Lite header 发送并记录 `responses_lite_fallback_cache_hit`；过期后自动删除并重新带 header 探测，防止未来第三方上游支持 Lite 后仍被永久去头。
- 验证通过：`cargo fmt --manifest-path src-tauri\Cargo.toml --check`；`cargo test --manifest-path src-tauri\Cargo.toml responses_lite --lib`（6 passed）；`cargo test --manifest-path src-tauri\Cargo.toml codex_responses_lite_error_triggers_retry_without_header --lib`。

## 2026-06-28 Responses-Lite Header Source And Proxy Failure Mechanism

- OpenAI Codex 源码确认 `x-openai-internal-codex-responses-lite` 不是普通透传 header，而是由模型元数据 `ModelInfo.use_responses_lite` 驱动的官方内部协商信号。`codex-rs/protocol/src/openai_models.rs` 定义 `use_responses_lite: bool`；`codex-rs/core/src/client.rs::add_responses_lite_header()` 在该值为 true 时给 HTTP Responses 请求加入 `x-openai-internal-codex-responses-lite: true`；WebSocket 路径则在 `build_ws_client_metadata()` 中写入 `ws_request_header_x_openai_internal_codex_responses_lite=true`。
- Lite 模式还会改变请求结构，不只是多一个 header：`build_responses_request()` 用 `prompt.get_formatted_input_for_request(model_info.use_responses_lite)`；Lite 为 true 时会去掉图片 detail、把 tools 放进 `AdditionalTools`/instructions 前缀、关闭 `parallel_tool_calls`，并让部分 tool planning 走 Lite 分支。说明服务端会按这个信号选择不同 Responses 处理路径。
- 中转遇到问题的根因是“协议能力错配”：Codex 官方客户端/后端之间的私有能力信号被 CCSwitchMulti 或其它代理原样转发给第三方 OpenAI-compatible 上游，或者转发给当时尚未支持该模型 Lite 路径的官方后端分支。上游看到 header 后按 Lite 路径校验模型，若该模型/账号/区域/后端版本不支持 Lite，就返回 `This model is not supported when using X-OpenAI-Internal-Codex-Responses-Lite.`。最新策略不是预先剥离，而是默认透传、命中特定 Lite 不支持错误后剥头重试一次。

## 2026-06-28 Responses-Lite Header Strip Policy Narrowed

- 上游作者关闭 `#4727` 后重新评估，原先 `should_strip_codex_private_header_for_upstream(_url, name)` 只看 header 名、无条件剥 `x-openai-internal-codex-responses-lite` 的策略过宽。这个 header 对第三方 OpenAI-compatible / MultiRouter 目标确实是官方私有信号，不应透传；但托管 ChatGPT Codex OAuth 目标属于官方协议路径，应该保留给官方后端自行协商，避免改变 Responses-Lite / prompt cache / 官方内部能力分支。
- 该静态剥离策略后来被进一步收窄为 fallback 重试策略：默认保留 header，只有上游明确返回 Lite 不支持错误时剥头重试一次。不要再恢复“第三方 Codex/OpenAI-compatible 上游发送前直接剥离”的口径。
- 这次验证时主工作区 `src-tauri/tauri.conf.json` 已有未归属脏改，新增 `bundle.windows.nsis.uninstallerIcon` 被当前 `tauri-build` 拒绝，导致主工作区 `cargo test --manifest-path src-tauri\Cargo.toml codex_responses_lite_header --lib` 卡在 build script。为不修改用户的 NSIS/icon 改动，使用临时 detached worktree `C:\Users\sunda\Documents\cc-switch-test-responses-lite` 套同一份 `forwarder.rs` 改动验证：`cargo fmt --manifest-path src-tauri\Cargo.toml --check` 通过；`cargo test --manifest-path src-tauri\Cargo.toml codex_responses_lite_header --lib` 通过 3 个用例：官方托管保留、第三方剥离、非 Codex app 保留。

## 2026-06-28 Windows Taskbar Icon Install Verification

- 本地 release pipeline 导出的 raw exe `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\windows\raw-exe\CCSwitchMulti_3.16.4-2_x64.exe` 已经正确嵌入 `src-tauri/icons/icon.ico`；用 `System.Drawing.Icon.ExtractAssociatedIcon()` 抽取后和源 `icon.ico` 一致，都是新的白色云/青色底图标。
- 用户看到 Windows 任务栏仍是旧图标时，优先检查启动路径。开始菜单和桌面快捷方式默认指向安装目录 `%LOCALAPPDATA%\CCSwitchMulti\cc-switch.exe`，而不是导出目录 raw exe。若只运行 raw exe 或只生成导出产物，固定任务栏/开始菜单仍可能从旧安装目录或 Windows 图标缓存读取旧图标。
- 这次用 `CCSwitchMulti_3.16.4-2_x64-setup.exe /S` 静默安装后，`%LOCALAPPDATA%\CCSwitchMulti\cc-switch.exe` 被替换为 3.16.4-2，内嵌图标抽取结果也变成新图标；监听端口 `15721/15722` 由安装版 `cc-switch.exe` 接管。若任务栏视觉仍旧，剩余边界是 Windows Explorer / 任务栏固定项图标缓存，需要刷新快捷方式或重启 Explorer，而不是重新修 Tauri 图标配置。
- 进一步固化在 `src-tauri/tauri.conf.json` 的 `bundle.windows.nsis`：当前项目使用的 `tauri-build` 只接受 `installerIcon`，不能写 `uninstallerIcon`；安装包图标显式设置为 `icons/icon.ico`，并通过 `src-tauri/nsis/installer-hooks.nsh` 的 `NSIS_HOOK_POSTINSTALL` 重写已存在的开始菜单和桌面快捷方式，把 `IconLocation` 固定为安装目录里的 `cc-switch.exe,0`。验证脚本为 `scripts/verify-windows-install-icon.ps1`，用于比对源 ico、安装目录 exe 内嵌图标和快捷方式图标目标。

## 2026-06-28 MultiRouter spawn_agent Model Override Visibility Fix

- 用户截图里 `spawn_agent` 工具提示“没有显式 model 选择字段”的根因不是提示词没写模型名，也不是单纯 catalog 前五候选排序问题；对照 `openai/codex` 最新源码确认，`multi_agent_v2` 的 `create_spawn_agent_tool_v2()` 在 `hide_spawn_agent_metadata=true` 时会调用 `hide_spawn_agent_metadata_options()`，直接从工具 schema 删除 `agent_type`、`model`、`reasoning_effort`、`service_tier`。新版 Codex 的 `MultiAgentV2Config::default()` 默认 `hide_spawn_agent_metadata=true`，所以只把 `qwen3.6` 写进 message 会继承父模型。
- CCSwitchMulti 的修复边界在 `src-tauri/src/codex_config.rs` 的 MultiRouter Codex config 投影：接管写入 `model_catalog_json` 和 provider inline models 时，同时确保 `[features.multi_agent_v2] hide_spawn_agent_metadata = false`。如果用户已有 `multi_agent_v2 = true`，转换成 table 并保留 `enabled = true`；如果已有 table，只覆盖隐藏 metadata 开关；不要无条件强行启用 v2，避免和旧 `[agents].max_threads` 语义制造新冲突。
- Codex 源码还确认 `spawn_agent_models_description()` 只展示 `ModelPreset.show_in_picker` 的前 5 个，而 `ModelPreset.show_in_picker` 来自 `ModelInfo.visibility == list`。因此 catalog 条目必须同时保留新版 `ModelInfo` snake_case 字段（`slug`、`visibility=list`、`supported_in_api=true`、`default_reasoning_level`、`supported_reasoning_levels`）和旧 renderer / 旧 direct preset 路径字段（`id`、`show_in_picker=true`、`hidden=false`、`defaultReasoningEffort`、`supportedReasoningEfforts`）。
- Provider inline `models` 也要同步补齐 `slug`、`description`、`visibility=list`、`show_in_picker=true`、`supported_in_api=true`、`default_reasoning_level`、`supported_reasoning_levels`，避免只写顶层 `model_catalog_json` 时某些 Desktop 热切路径看到不完整模型元数据。
- 回归测试落点：`cargo test --manifest-path src-tauri/Cargo.toml codex_model_catalog_projects_spawn_agent_model_info_fields --lib`、`cargo test --manifest-path src-tauri/Cargo.toml codex_multi_agent_v2_keeps_spawn_agent_model_override_visible --lib`、`cargo test --manifest-path src-tauri/Cargo.toml codex_model_catalog_ --lib`，并配合 `cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`git diff --check`。

## 2026-06-28 MultiRouter Subagent Usage Model Aggregation Fix

- “今日子 Agent 会话流量”全 0 的根因不是前端数值格式化，而是 Codex 子 Agent JSONL 的 `session_meta.payload.session_id` 在当前 Codex Desktop 中指向父线程 ID；子 Agent 自己的线程 ID 在 `state_5.sqlite.threads.id` 和 rollout 文件名后缀里。旧 `session_usage_codex.rs` 同步时把 `proxy_request_logs.session_id` 写成父线程，导致 `build_codex_subagent_usage_stats_from_history()` 用子 Agent id 做 `data_source='codex_session' AND session_id IN (...)` 时查不到当天用量。
- 修复边界分两层：后续同步在 `session_meta` 标记为 `source.subagent.thread_spawn` / `source.thread_spawn` 时，优先用 rollout 文件名里的 36 位线程 ID 作为 `session_id`；已有错归到父线程的历史/当天数据不迁移 DB，而是在子 Agent 统计页按子 Agent rollout JSONL 只读回退解析 `token_count`，恢复 request/token/model 聚合。
- 模型聚合不能依赖是否已有 token_count 命中。`modelStats.agentCount` 现在从子 Agent 的 `turn_context` / `token_count` primary model 归并，每个模型一行展示子 Agent 数、请求、Tokens、费用；即使某个模型的子 Agent 暂无用量，也要显示 agentCount，避免页面退化成几百个子 Agent 明细行。
- 前端 `CodexRouterWorkspacePage.tsx` 的子 Agent 会话流量区默认只保留模型聚合表和一行数据源摘要，不再默认渲染逐子 Agent 明细表。这样状态页回答“每个模型有多少子 Agent、消耗多少 token”，而不是“每个子 Agent 用了什么模型”。
- 回归测试落点：`cargo test --manifest-path src-tauri/Cargo.toml codex_subagent_usage_stats --lib`、`cargo test --manifest-path src-tauri/Cargo.toml test_codex_subagent_model_stats_counts_agents_without_usage --lib`、`cargo test --manifest-path src-tauri/Cargo.toml test_sync_codex_subagent_uses_rollout_thread_id --lib`，并配合 `cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`pnpm typecheck`、`git diff --check`。

## 2026-06-28 CCSwitchMulti v3.16.4-2 Formal Release

- `v3.16.4-2` 已作为 BigStrongSun/ccswitchmulti 的 GitHub 正式 release 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.4-2`。Release 为非 draft、`prerelease=false`，发布时间为 `2026-06-28T05:00:55Z`。本地 tag `v3.16.4-2` 为 annotated tag，tag 对象为 `cf874abd37e10f767971deea69e0178edfd0aa71`，解引用到版本提交 `d81abacdccb6915e31ebf829e50155ae95f64a37`（`chore(release): prepare CCSwitchMulti v3.16.4-2`）。
- 本次正式版覆盖 `v3.16.4-1` 之后的两个用户可见修复：`fa32a34c` 新增异常退出 / panic / 正常退出结构化日志与“打开日志目录”入口；`7ebd7354` 修复 Codex Desktop `x-openai-internal-codex-responses-lite` 内部 header 被转发到真实上游导致 gpt-5.5 等模型 HTTP 400 的问题。版本面统一更新为 `3.16.4-2`，并新增中文 release note `docs/release-notes/v3.16.4-2-zh.md`。
- Windows 本地 release pipeline 由 post-commit hook 启动并成功完成，导出目录为 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，完成时间 `2026-06-28 12:57:52 +08:00`。raw exe `CCSwitchMulti_3.16.4-2_x64.exe` 的 FileVersion/ProductVersion 均验证为 `3.16.4-2`，下载后的 `latest.json` 也验证为 `version=3.16.4-2` 且指向 `https://github.com/BigStrongSun/ccswitchmulti/releases/download/v3.16.4-2/CCSwitchMulti_3.16.4-2_x64-setup.exe`。
- 本次 release 上传 9 个平铺资产：`CCSwitchMulti_3.16.4-2_x64-setup.exe`、安装包 `.sig`、`CCSwitchMulti_3.16.4-2_x64-portable.zip`、`CCSwitchMulti_3.16.4-2_x64.exe`、`latest.json`、`SHA256SUMS.txt`、`linux-build-note.md`、`macos-build-note.md`、`v3.16.4-2-zh.md`。`SHA256SUMS.txt` 是从平铺 staging 目录 `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.4-2-assets` 重新生成的，GitHub asset digest 与本地 checksum 对应。Linux/macOS 正式二进制未在 Windows 本地构建，本次仍上传平台构建说明。
- 发布前验证通过：`pnpm typecheck`；`cargo fmt --manifest-path src-tauri\Cargo.toml --check`；`cargo test --manifest-path src-tauri\Cargo.toml codex_responses_lite_header --lib`；`cargo test --manifest-path src-tauri\Cargo.toml ordinary_headers_are_preserved_for_upstream --lib`；`cargo test --manifest-path src-tauri\Cargo.toml app_exit_monitor --lib`；`git diff --check`。发布后验证：`gh release view v3.16.4-2 --repo BigStrongSun/ccswitchmulti --json tagName,isDraft,isPrerelease,publishedAt,url,assets`、`gh api repos/BigStrongSun/ccswitchmulti/releases/latest`、`git show-ref --tags v3.16.4-2`、下载并解析 release `latest.json`。

## 2026-06-28 Codex Responses-Lite Header Upstream Strip

- `This model is not supported when using X-OpenAI-Internal-Codex-Responses-Lite` 的根因不是 MultiRouter 自身路由错误，而是 Codex Desktop 发给本地后端的内部协商头 `x-openai-internal-codex-responses-lite` 被 CC Switch / CCSwitchMulti 的 `forwarder.rs` 默认透传到了真实上游。OpenAI 在 2026-06-26 左右收紧 Lite 路径后，`gpt-5.5` 等模型会因此在 official ChatGPT Codex upstream 或第三方代理 upstream 返回 HTTP 400。
- 正确修复边界在转发层 header policy：`src-tauri/src/proxy/forwarder.rs` 构建 `ordered_headers` 时，在默认透传前调用 `should_strip_codex_private_header_for_upstream()`，无条件移除 `x-openai-internal-codex-responses-lite`。不要把它修成 UI 开关、catalog schema、模型映射或 MultiRouter route 规则；也不要粗暴移除 OAuth/session/account headers，否则会破坏 Codex 官方登录态、前缀缓存和 CCSwitchMulti 之前的 OAuth login-preservation 修复。
- 这次先在原版 `C:\Users\sunda\Documents\LLMservice\ccswitch official` 基于 `origin/main` 创建 `codex/strip-codex-responses-lite-header`，提交 `1e6a46b7 fix(proxy): strip Codex Responses-Lite header upstream`，并向 `farion1231/cc-switch` 提交 PR `#4727`，关联 issue `#4700`。随后把同一策略移植到 CCSwitchMulti `C:\Users\sunda\Documents\LLMservice\cc-switch` 的 `codex/merge-official-v3.16.4` 分支。
- 回归测试落点：`proxy::forwarder::tests::codex_responses_lite_header_is_stripped_for_official_upstream`、`codex_responses_lite_header_is_stripped_for_third_party_upstream`、`ordinary_headers_are_preserved_for_upstream`。验证命令优先跑 `cargo fmt --manifest-path src-tauri\Cargo.toml --check`、`cargo test --manifest-path src-tauri\Cargo.toml codex_responses_lite_header --lib`、`cargo test --manifest-path src-tauri\Cargo.toml ordinary_headers_are_preserved_for_upstream --lib`、`git diff --check`。

## 2026-06-28 CCSwitchMulti v3.16.4-1 Prerelease

- `v3.16.4-1` 已作为 BigStrongSun/ccswitchmulti 的 GitHub prerelease 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.4-1`。Release 为非 draft、`prerelease=true`，发布时间为 `2026-06-27T20:52:24Z`，target commit 为 `e0228d531d1a7086a808d706e6ecb2618de44f4c`（`docs(memory): record completed v3.16.4-1 merge`）。
- 本地 Windows release pipeline 成功，导出目录为 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，完成时间 `2026-06-28 04:50:26 +08:00`。raw exe `CCSwitchMulti_3.16.4-1_x64.exe` 的 FileVersion/ProductVersion 均验证为 `3.16.4-1`，`latest.json` 指向 `https://github.com/BigStrongSun/ccswitchmulti/releases/download/v3.16.4-1/CCSwitchMulti_3.16.4-1_x64-setup.exe`。
- 本次 prerelease 上传 8 个资产：`CCSwitchMulti_3.16.4-1_x64-setup.exe`、安装包 `.sig`、`CCSwitchMulti_3.16.4-1_x64-portable.zip`、`CCSwitchMulti_3.16.4-1_x64.exe`、`latest.json`、`SHA256SUMS.txt`、`linux-build-note.md`、`macos-build-note.md`。Linux/macOS 正式二进制未在 Windows 本地构建，后续需要 supplemental workflow 或对应平台构建补齐。
- 发布前后验证：`pnpm release:local` 运行了 `pnpm typecheck` 并完成 Tauri NSIS Windows x64 build；使用本地 `C:\Users\sunda\.ccswitchmulti\tauri-update.key` 生成 updater 签名；`gh release view v3.16.4-1 --repo BigStrongSun/ccswitchmulti --json tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url,assets` 复核 release 状态和资产摘要；`SHA256SUMS.txt` 中 Windows 资产 hash 与 GitHub release asset digest 对应。

## 2026-06-28 CCSwitchMulti v3.16.4-1 Official Merge Completed

- `codex/merge-official-v3.16.4` 已完成官方 `farion1231/cc-switch` `v3.16.4` 跟进，版本面更新为 `3.16.4-1`。不要把它理解成直接 merge 官方 tag；这次按 `45555638..e50fc0eb` 的缺口逐个 cherry-pick / 手工合并，保留了 `cc-switch-multi`、`CCSwitchMulti`、`com.ccswitchmulti.desktop`、BigStrongSun updater、MultiRouter workspace、外部 OpenAI-compatible API、Codex history repair、WebDAV/S3 sync 和 fork release 脚本。
- 高风险合并点的最终边界：`codex_oauth_auth.rs` 采用官方共享 `crate::proxy::http_client::get()` 出站，但保留 Multi 的 `oauth_token_url` 测试注入和 refresh-token 轮换语义；`forwarder.rs` 合入 zstd/gzip/br/deflate 解压与 local proxy request overrides，同时保留 Multi 的 4 元组返回和 `codex_router_log`，上游错误摘要使用解压后的 body；`ProviderMeta` 同时保留 `min_output_tokens` 和官方 `local_proxy_request_overrides`。
- Codex 表单合并时必须记住：官方 `apiFormat` 已变成上游 wire format 选择，Multi 的本地路由/模型映射由 `takeoverEnabled` 独立控制。`CodexFormFields`/`ProviderForm` 已采用 `takeoverEnabled` / `codexTakeoverEnabled`，保留 MultiRouter catalog/routing、visible model 与 upstream model 分离；不要恢复旧的“apiFormat == chat 才显示路由”的耦合逻辑。
- 已合入的官方功能包括 ETok rename、Kimi 图标/赞助文案/auto compact、Volcengine Ark AK/SK usage、Skills UI 修复、Windows ARM64 release workflow、Usage live end time、JsonEditor dark mode、DB too-new recovery screen、local proxy request overrides、Copilot/Codex OAuth 全局代理 client、body 解压、Doubao Seed 2.1、Codex CN providers native Responses presets、SubRouter/OpenCode Go presets、v3.16.4 docs/release notes、Fable 5 banner removal 和 fork 版本 bump。
- 收尾测试修复：`tests/components/CodexFormFields.test.tsx` 的 test harness 需要传入 `takeoverEnabled`、`onTakeoverEnabledChange`、`localProxyHeadersOverride`、`onLocalProxyHeadersOverrideChange`、`localProxyBodyOverride`、`onLocalProxyBodyOverrideChange`。否则 `pnpm typecheck` 会报缺必填 props，Vitest 会在 `trim()` 处因 undefined 崩溃；这是测试壳没跟上组件契约，不是生产逻辑需要默认兜底。
- 本轮验证通过：`pnpm typecheck`；`vitest run tests/components/CodexFormFields.test.tsx tests/config/codexChatProviderPresets.test.ts tests/config/subrouterProviderPresets.test.ts tests/lib/requestOverrides.test.ts src/components/codex/CodexRouterWorkspacePage.test.ts`；`cargo fmt --manifest-path src-tauri/Cargo.toml --check`；`cargo test --manifest-path src-tauri/Cargo.toml local_proxy_ --lib`；`cargo test --manifest-path src-tauri/Cargo.toml content_encoding --lib`；`cargo test --manifest-path src-tauri/Cargo.toml token_request_ --lib`；`cargo test --manifest-path src-tauri/Cargo.toml get_status_does_not_refresh --lib`；`git diff --check`。广义 `pnpm test:unit -- ...` 早先因脚本展开跑到 `tests/integration/App.test.tsx` 出现过一次 timeout，目标测试收敛后未复现，若发布前做全量 CI 仍需关注该集成测试是否环境性超时。

## 2026-06-28 Official v3.16.4 Delta And CCSwitchMulti Merge Boundary

- Official `farion1231/cc-switch` `v3.16.4` was verified from GitHub release/tag: release published `2026-06-27T05:14:41Z`, tag `v3.16.4` points to `e50fc0eb281cf937251a1cb24a44e792d69029ac`. Local `git diff v3.16.3..v3.16.4 --stat` shows 57 commits and 138 files changed with `+9409/-1020`; the release note itself summarizes 53 commits / 126 files / `+8149/-1016`, so use git as the exact source for merge planning and release notes as product summary.
- Current CCSwitchMulti `main` is `23c43f59e124db15608f9192a89a2e6dd141434e` (`docs(memory): record v3.16.3-23 release`), version surfaces are `3.16.3-23`, and `git merge-base HEAD v3.16.4` is official commit `455556380b52c18d3d444a751a6c17de6d4ee5b0` (`Chat API: skip tool calls with missing function names`). That means CCSwitchMulti has already absorbed the official v3.16.4 path through `45555638`; do not re-merge earlier commits such as CODEX_SQLITE_HOME probing, cached tool-call restore, DeepSeek `thinking:disabled` effort stripping, settings scroll reset, models.dev pricing import, duplicate Codex `base_url` cleanup, or Add Provider search click fix.
- Do not merge the full official tag into CCSwitchMulti. `git merge-tree HEAD v3.16.4` reports direct conflicts in fork identity and high-divergence files including `README.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `src-tauri/src/proxy/forwarder.rs`, `src-tauri/src/proxy/mod.rs`, `src-tauri/src/proxy/providers/codex_oauth_auth.rs`, `src/components/providers/forms/CodexFormFields.tsx`, `src/components/providers/forms/ProviderForm.tsx`, locale JSON files, and `tests/config/codexChatProviderPresets.test.ts`. A full tag merge also appears to delete many CCSwitchMulti-only modules when viewed as `HEAD..v3.16.4`.
- Fork identity must be preserved during any v3.16.4 merge: `cc-switch-multi` package name, `CCSwitchMulti` product name, `com.ccswitchmulti.desktop` identifier, BigStrongSun updater endpoints/signing, release/export scripts, supplemental Linux/macOS workflows, `codex-history-repairer`, MultiRouter workspace, external OpenAI-compatible API, WebDAV/S3 sync, Codex history repair UI/tooling, model fetch/catalog overlay behavior, and the Codex OAuth login-preservation fixes from `v3.16.3-23`.
- The still-missing official commits are `6ec86cff..e50fc0eb` after merge-base `45555638`: Homebrew docs cleanup; CTok to ETok rename; Kimi icon/prime-partner/order updates; Volcengine Ark AK/SK usage; Skills UI fixes; Kimi auto compact window; Windows ARM64 release support; live end time in usage range; JsonEditor dark mode; database-too-new recovery screen; local proxy request overrides; Copilot/Codex OAuth global proxy fix; zstd/gzip/br/deflate request and error body decompression; Doubao Seed 2.1 pricing/preset; Codex upstream format selector decoupling; unmanaged skill green dot; native Responses API presets for CN Codex providers; SubRouter and OpenCode Go presets; v3.16.4 docs/release notes; Fable 5 banner removal; and official version bump.
- Low-risk/high-value merge candidates for CCSwitchMulti are: `1a0e8c7a` zstd/body decompression, `524b9d98` Copilot/Codex OAuth requests using shared global proxy client, `9171ad75` usage live end time, `55abd182` JsonEditor dark mode, `f1328d89` unmanaged skill green dot, `2d478876` Claude MCP custom config path, `2781d40e` Skills/card UI fixes, `c4630b5c` Volcengine Ark usage query, `2e547c98`/`fdf538e5` Doubao Seed 2.1 pricing/preset, and provider pricing/preset additions that do not overwrite fork-specific catalog behavior.
- Medium/high-risk items need manual hunk porting, not blind cherry-pick: `6fd4e6f4` local proxy request overrides touches `forwarder.rs`, `ProviderForm.tsx`, `CodexFormFields.tsx`, `types.ts`, locales; `edeee25f` database recovery screen needs early DB-version checks integrated with CCSwitchMulti startup/updater semantics; `a4eb5f37` format selector decoupling must preserve MultiRouter model catalog browser and visible/upstream model split; `273cc48c` native Responses API preset migration must preserve CCSwitchMulti route mapping semantics; `430ddf92`/`dd6a951c` SubRouter/OpenCode Go presets and `142c8c1d` ETok rename should be merged without dropping fork presets/docs.
- Do not take official `f9547da9` version bump literally. The CCSwitchMulti successor should use the fork version scheme, likely `3.16.4-1` if preparing a release from this official base, and update all fork version surfaces consistently (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, release notes/export metadata).

## 2026-06-28 CCSwitchMulti v3.16.3-23 Prerelease

- `v3.16.3-23` 已作为 GitHub prerelease 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-23`。Release 为非 draft、`prerelease=true`，发布时间为 `2026-06-27T19:50:42Z`，target commit 为 `d8f254fbf9d7b687f385e12bd8df98125306d5f3 build(pnpm): approve release build dependencies`，tag 覆盖 `v3.16.3-22..main` 的 16 个未发布提交。
- 本次发布包含 Codex OAuth 休眠/唤醒与 provider 切换稳定性修复：`get_status()` 保持离线状态语义、`access_token` 只在内存缓存、`RefreshTokenInvalid` 只在真实 token 请求明确 401/403 时清账号；同时移除 `codex_config.rs` 模型 catalog fallback 里的隐藏 live OAuth fetch，避免独立 `CodexOAuthManager` 轮换 refresh token 后主 manager 误删账号。
- Windows 本地 post-commit release pipeline 构建成功，导出目录为 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，完成时间 `2026-06-28 03:49:04 +08:00`。raw exe `CCSwitchMulti_3.16.3-23_x64.exe` 的 FileVersion/ProductVersion 均验证为 `3.16.3-23`，`latest.json` 指向 `v3.16.3-23` 的 Windows setup 资产。
- pnpm 11 在发布前阻止 `esbuild`/`msw` postinstall，修复方式是提交 `pnpm-workspace.yaml` 的 `allowBuilds` / `onlyBuiltDependencies` 白名单，并运行 `pnpm approve-builds --all`、`pnpm install --frozen-lockfile`、`pnpm typecheck` 验证。以后本地 release pipeline 遇到 `ERR_PNPM_IGNORED_BUILDS`，先检查该文件，不要交互式留 placeholder。
- 发布资产当前包含 Windows setup、setup signature、portable zip、raw exe、`latest.json`、`SHA256SUMS.txt`、Linux/macOS build notes；Linux/macOS 二进制资产未在本地生成，需要后续 supplemental workflow 或对应平台构建补齐。发布后复核 `gh release view v3.16.3-23 --repo BigStrongSun/ccswitchmulti --json tagName,targetCommitish,isDraft,isPrerelease,publishedAt,url,assets` 返回 8 个资产。

## 2026-06-28 Codex OAuth Sleep Wake Refresh Invalid Status Fix

- 休眠/唤醒后 Codex OAuth 认证页显示“已登录账号”的原版语义是“本地 `codex_oauth_auth.json` 里仍有账号和 refresh_token 记录”，不是在线验证结果。`get_status()` 不应主动 refresh，也不应因为打开认证页就清理账号；否则状态页会放大 refresh token 使用次数和临时网络误判。
- 最终修复边界：保持原版凭据模型，`refresh_token` 持久化，`access_token` 只在内存缓存。只有真实请求、额度查询、模型查询等需要 Bearer token 的路径调用 `get_valid_token_for_account()`；当 OpenAI token 端点明确返回 401/403 并映射为 `RefreshTokenInvalid` 时，才移除对应账号并让下一次状态查询显示未认证。网络错误、解析错误等临时故障不清空账号。
- 追加排查发现的隐藏边界：`src-tauri/src/codex_config.rs` 生成 Codex provider/model catalog 时不能因为官方 `models_cache.json` 缺失或无 `context_window` 就创建独立 `CodexOAuthManager` 去读取同一份 `codex_oauth_auth.json` 并在线 fetch models。该路径绕过 app 托管的 `CodexOAuthState`，若 refresh token 被官方轮换，主 manager 可能继续持旧 token，后续真实请求会误判 OAuth 失效并清账号。配置/catalog 生成只能读取离线 cache 或测试覆盖值，真实 OAuth refresh 必须通过托管状态发生在用户显式触发的请求/额度/模型查询路径。
- 底层容错也要保留：`CodexOAuthManager::get_valid_token_for_account()` 在 access_token 缓存未命中并拿到账号刷新锁后，应在读取 refresh_token 前重新加载一次 `codex_oauth_auth.json`。这不是为了恢复隐式在线刷新，而是防止未来双进程、旧版本遗留独立 manager 或其他实例已经把 refresh_token 从 A 轮换到 B 后，当前实例继续用内存 A 刷新并触发 `RefreshTokenInvalid` 误删账号。
- 前端 `useManagedAuth` 的 `hasAnyAccount` 不能只等于 `accounts.length > 0`，应受后端 `authenticated` 约束。Codex OAuth 本地账号记录和真实可用认证态必须分开看；以后不要再用“本地有账号”直接驱动绿色认证状态或保存校验。
- 回归测试落点：`codex_oauth_auth.rs` 覆盖 `get_status_does_not_refresh_or_remove_invalid_account`、`token_request_removes_account_when_refresh_token_is_invalid`、`token_request_refreshes_expired_default_account_when_token_is_valid`。验证命令优先跑 `cargo test --manifest-path src-tauri\Cargo.toml token_request_ --lib` 和 `cargo test --manifest-path src-tauri\Cargo.toml get_status_does_not_refresh --lib`。

## 2026-06-27 Logging And Frequent Exit Diagnostics Inventory

- 程序已有三类本地日志：通用运行日志由 `tauri-plugin-log` 写到 `<app_config_dir>/logs/cc-switch.log`（默认 `~/.cc-switch/logs/cc-switch.log`），panic hook 追加写 `<app_config_dir>/crash.log`，Codex MultiRouter 诊断事件写 `<app_config_dir>/logs/codex-router.log`。默认 app config 目录仍是用户家目录下 `.cc-switch`，但启动时会先读取 Store 里的 app_config_dir 覆盖。
- `src-tauri/src/panic_hook.rs` 会在启动最早期安装 panic hook，并强制 `RUST_BACKTRACE=1`；崩溃日志包含时间戳、版本、OS/arch/family、工作目录、线程名/ID、panic message、文件/行/列和完整 backtrace。`src-tauri/Cargo.toml` 设置 `panic = "unwind"`，因此 Rust panic 能被 hook 捕获；但直接进程 abort、系统杀进程、WebView/前端 JS 崩溃不一定进入该 hook。
- 通用日志初始化在 `src-tauri/src/lib.rs` 的 setup 阶段，目标包括 stdout 和日志目录文件 `cc-switch.log`，轮转策略是 `KeepSome(2)`、单文件 1GB。启动后会从 DB 的 `log_config` 读取开关和级别，通过 `log::set_max_level` 应用；前端入口是设置页高级里的 `LogConfigPanel`，只提供启用/禁用和 error/warn/info/debug/trace 级别选择。
- Codex router 日志由 `src-tauri/src/proxy/codex_router_log.rs` 直接追加写入，记录 `route_resolved`、`request_prepared`、`upstream_send`、`upstream_status`、`response_ready` 等清洗后的排障事件；它不会记录 prompt、header 原文或 SSE 内容，并会遮盖 token/API key。MultiRouter 状态页的一键诊断会读取该文件判断近期请求、错误和真实出站协议。
- 现有“异常退出恢复”只针对代理/Live 接管残留：启动时检查 DB live backup 和 live config 占位符，必要时调用 `recover_from_crash()` 恢复配置。这不是通用的频繁退出检测，也不会统计崩溃次数。
- 当前没有现成的“频繁退出/崩溃频率”检测：没有启动 marker、正常退出 marker 清理、退出原因/退出码统一记录、时间窗口计数、watchdog、最近 crash 自动提示，也没有“打开日志目录”的设置页按钮。排查别人频繁退出时，先让对方收集 `~/.cc-switch/crash.log`、`~/.cc-switch/logs/cc-switch.log`，若涉及 Codex MultiRouter 再收集 `~/.cc-switch/logs/codex-router.log`；如果 `crash.log` 没有新条目，就要考虑非 Rust panic 路径（前端/WebView、系统杀进程、安装器重启、进程 abort）。

## 2026-06-28 Abnormal Exit And Crash Cause Logging

- 新增 `src-tauri/src/app_exit_monitor.rs` 作为不依赖数据库的异常退出记录层：启动时写 `<app_config_dir>/logs/app-run-marker.json`，正常退出时删除 marker 并向 `<app_config_dir>/logs/app-exit-events.jsonl` 追加 `clean_exit`，下次启动如果发现 marker 残留则追加 `abnormal_exit_detected` 并在 `cc-switch.log` 打 warn。这样数据库初始化失败、配置迁移失败或 Tauri 事件循环异常退出也能留下证据。
- `panic_hook` 现在除了继续写完整 `<app_config_dir>/crash.log`，还会向 `app-exit-events.jsonl` 写结构化 `panic` 事件，包含 panic message、源码位置和线程摘要；完整 backtrace 仍只在 `crash.log`，避免 JSONL 过大。
- 已挂接的正常/显式退出路径包括窗口关闭退出、用户主动退出、Tauri restart、自定义 `restart_process`、Windows updater install 前退出、旧 config 加载失败用户退出、数据库初始化失败用户退出。系统强杀/abort 仍无法在退出前写 clean event，但会因 marker 残留在下次启动被识别。
- 设置页高级日志配置新增“打开日志目录”入口，调用 `open_log_dir` 打开 `<app_config_dir>/logs`，方便用户收集 `cc-switch.log`、`app-exit-events.jsonl`、`app-run-marker.json` 和 `codex-router.log`。完整 Rust backtrace 的 `crash.log` 仍位于 `<app_config_dir>` 根目录。

## 2026-06-26 CCSwitchMulti v3.16.3-22 Prerelease

- `v3.16.3-22` 已作为 GitHub prerelease 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-22`。Release 为非 draft、`prerelease=true`，发布时间为 `2026-06-26T04:16:52Z`，tag 指向 `d4260d1aeb89ade1859f4a341612a8453fc57cbb chore(release): prepare v3.16.3-22 prerelease`。
- 业务修复来自 `9b91ff5d fix(codex): refresh multirouter model sources optimistically`：MultiRouter `/models` 刷新成功后不再等待父级 providers refetch，当前打开的 route picker 会通过 `optimisticModelSourcesById` 立即读到新 catalog，解决“读取成功但 UI 仍显示未发现模型目录 / 卡在旧列表”的边界。
- Windows 本地 post-commit release pipeline 构建成功，导出目录为 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，完成时间 `2026-06-26 11:59:43`；Windows setup 为 `CCSwitchMulti_3.16.3-22_x64-setup.exe`，raw exe 的 FileVersion/ProductVersion 均验证为 `3.16.3-22`，`latest.json` 指向 `v3.16.3-22`。
- 发布创建时 `gh release create` 在 raw exe 上传阶段遇到 EOF 并留下 draft release；恢复方式是停止残留 `gh` 进程，逐个补传缺失 Windows 资产，并删除误名 checksum 资产后重新上传正确的 `SHA256SUMS.txt`。后续 Linux/macOS workflow 又刷新了最终 checksum。
- Supplemental Linux Release workflow `28216822549` 成功，上传 AppImage、deb、rpm；Supplemental macOS Release workflow `28216824340` 成功，上传 unsigned universal `.app.zip`、universal updater tarball 和 `.tar.gz.sig`。最终 release 共有 12 个资产，`SHA256SUMS.txt` 覆盖除自身外的 11 个资产。
- 发布前验证：`pnpm test:unit -- src/components/codex/CodexRouterWorkspacePage.test.ts`（21 个测试通过）、`pnpm typecheck`、`cargo check --manifest-path src-tauri/Cargo.toml`（仅既有 `commands/misc.rs` unused warnings）、`git diff --check`（仅 `Cargo.lock` LF/CRLF 提示）。发布后复核：`gh release view v3.16.3-22 --repo BigStrongSun/ccswitchmulti --json tagName,isDraft,isPrerelease,url,assets,publishedAt,targetCommitish`、下载 `SHA256SUMS.txt` 检查 11 条 checksum、`gh run view 28216822549` 和 `gh run view 28216824340` 均为 `status=completed, conclusion=success`。

## 2026-06-26 MultiRouter Model Refresh UI Stale Catalog Fix

- 新版仍出现“加载模型列表卡住 / UI 没刷新”时，要区分两类问题：`v3.16.3-21` 已解决 `/models` 读取或保存事务不 settle 导致永久 loading；本次发现的剩余边界是刷新成功后 `nextProvider` 写入 DB/React Query，但当前 `CodexRouterWorkspacePage` 的 `modelSources` 仍可能来自父级旧 `providers` props，导致已打开的 `RouteCandidatePicker` 继续显示旧 catalog 或“未发现模型目录”。
- 根因位置是 `src/components/codex/CodexRouterWorkspacePage.tsx`：旧 `effectiveProviders` 只叠加 `optimisticRoutingPlan`，没有叠加普通模型源的刷新结果；同时刷新成功分支的 `queryClient.setQueryData(["providers","codex"])` 在 cache 尚无 `providers` 字段时会返回旧引用，不能保证触发 UI 更新。
- 修复方式是新增 `optimisticModelSourcesById`，在 `fetchModelsForConfig -> providersApi.update(nextProvider)` 成功后立即把普通 provider 的新 catalog 叠加进 `effectiveProviders`，让候选 router 和空 match route 立刻读取新模型；当父级 props 的 catalog 追上或 provider 连接配置/baseUrl/API key 变化时自动释放 overlay，避免旧 catalog 长期压住新配置。
- 回归测试新增 `refreshes visible route picker candidates after provider catalog save without parent refetch`：provider 初始 catalog 为空，打开候选选择器时显示“未发现模型目录”，`/models` 返回 `fresh-route-model` 且保存成功后，在不模拟父级 refetch 的情况下候选卡片必须立刻显示 `fresh-route-model` 并移除空目录提示。
- 本轮验证：`pnpm test:unit -- src/components/codex/CodexRouterWorkspacePage.test.ts`（21 个测试通过）、`pnpm typecheck`、`pnpm build:renderer`、`git diff --check`。renderer build 仍只有既有 baseline/browserlist/大 chunk 警告。

## 2026-06-25 CCSwitchMulti v3.16.3-21 Prerelease

- `v3.16.3-21` 已作为 GitHub prerelease 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-21`。tag 指向 `554bed1c chore(release): prepare v3.16.3-21 hotfix`，业务修复来自 `966a8e38 fix(codex): settle model refresh save-back hangs`。
- 本次热修的真实边界：`v3.16.3-20` 只修了并发刷新和 `/models` 阶段超时，仍可能在读取成功后的 `providersApi.update` 写回 provider / plan catalog 阶段永久 loading；`v3.16.3-21` 才把读取和写回合成同一个 30 秒超时事务。
- Windows 本地 release hook 构建成功，导出目录为 `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`，raw exe 文件版本为 `3.16.3-21`。release 创建时 `gh release create` 曾在 raw exe 上传阶段卡住，留下 draft；处理方式是停止残留 `gh`，补传 raw exe，再 `gh release edit --draft=false --prerelease=true` 发布。
- Supplemental Linux Release workflow `28177240622` 成功并上传 AppImage、deb、rpm；Supplemental macOS Release workflow `28177240635` 成功并上传 unsigned universal `.app.zip`、updater tarball 和 tarball 签名。最终 release 共有 12 个资产，`SHA256SUMS.txt` 覆盖除自身外的 11 个资产。
- 发布前验证：`pnpm test:unit -- src/components/codex/CodexRouterWorkspacePage.test.ts`、`pnpm typecheck`、`cargo check --manifest-path src-tauri/Cargo.toml`（仅既有 `commands/misc.rs` unused warnings）、`git diff --check`、`pnpm build:renderer`。

## 2026-06-25 MultiRouter Model Refresh v3.16.3-21 Hotfix Boundary

- 用户/外部反馈截图仍停在“候选 provider 模型列表刷新 / 正在读取模型列表...”时，必须区分三个版本边界：本机安装目录 `C:\Users\sunda\AppData\Local\CCSwitchMulti\cc-switch.exe` 仍是 `3.16.3-18`，公开 `v3.16.3-19` 完全不含刷新状态机修复，公开 `v3.16.3-20` 含 `ddfeed42`/`33a0bc58` 但不含 `966a8e38 fix(codex): settle model refresh save-back hangs`。
- `v3.16.3-20` 的 `withModelRefreshTimeout` 只包住 `fetchModelsForConfig(...)`，读取成功后的 `providersApi.update(nextProvider)` 与受影响 plan 写回仍可能永久挂起；当前 HEAD `966a8e38` 才把读取、provider catalog 写回、MultiRouter plan catalog 写回合成同一个 30 秒超时事务，并显示“已读取 N 个模型，正在写回本地配置...”阶段文案。
- 本轮现场验证：`pnpm test:unit -- src/components/codex/CodexRouterWorkspacePage.test.ts` 通过 20 个测试；截图类问题应通过补发 `v3.16.3-21` 处理，release notes 不能再建议 save-back 卡住用户只升级到 `v3.16.3-20`。

## 2026-06-25 MultiRouter Model Refresh Save-Back Timeout Fix

- MultiRouter 路由页“候选 provider 模型列表刷新”卡在“正在读取模型列表...”不只可能发生在 `/models` IPC/网络阶段；`src/components/codex/CodexRouterWorkspacePage.tsx` 在读取成功后还会 `providersApi.update` 写回普通 provider 的 `modelCatalog`，并重建/写回受影响 MultiRouter plan 的 `modelCatalog`。旧 `withModelRefreshTimeout` 只包住 `fetchModelsForConfig`，如果后续 provider/plan 保存、Codex live catalog/cache 同步或本地 DB/文件写入挂起，UI 仍会永久停留在 loading。
- 当前修复把“读取 `/models` -> 写回 provider catalog -> 写回受影响路由方案”视作一个刷新事务，30 秒超时覆盖整个事务；读取完成进入保存阶段时，卡片文案改为“已读取 N 个模型，正在写回本地配置...”，避免把保存阶段误判成远端 `/models` 还在读。
- 超时 attempt 会被记录到 `modelRefreshTimedOutAttemptKeysRef`，后台迟到的 Promise 不允许再把 error/loading 覆盖成 success；同时 catch 只在该 provider 仍然是当前 attempt 时写错误态，避免旧 attempt 超时覆盖新 attempt。
- 回归测试 `src/components/codex/CodexRouterWorkspacePage.test.ts` 覆盖两类永久 loading 边界：`fetchModelsForConfig` 永不返回，以及 `providersApi.update` 写回刷新结果永不返回。后者会先显示写回阶段文案，30 秒后落到错误态，迟到 resolve 不能再变成成功态。

## 2026-06-25 Codex Catalog Visible Alias And Upstream Model Split

- 第三方 Codex provider 的 `modelCatalog.models[].model` 是 Codex/子 Agent 可见候选名，不再强制等于真实上游模型名；新增 `upstreamModel`/`upstream_model` 表示请求发往上游时使用的模型。为空或等于 `model` 时按旧配置兼容处理。
- 普通表单和 MultiRouter 自动 `/models` 刷新合并时必须按 `upstreamModel || upstream_model || model` 优先匹配远端返回的 id，避免用户把 `gpt-5.5` 改成 `gpt-5.5-thirdparty` 后，下一次刷新又新增一个重复的 `gpt-5.5` 或把别名覆盖掉。新增远端模型默认写成 `model=id, upstreamModel=id`，保存时若二者相同会省略 upstream 字段。
- 运行时出站映射顺序固定为：route 级 `codexResolvedUpstreamModelOverride` / `modelMap` 优先，其次 catalog 条目的 `upstreamModel`，最后回退到 provider/config 里的单模型字段。这个映射必须同时覆盖 Responses 原生直连和 Responses->Chat 转换路径。
- Codex catalog 文件可以携带 `upstreamModel` 作为 cc-switch 私有元数据，但 OpenAI-compatible `/v1/models` 的 `data[]` 只能暴露可见模型名和上下文窗口，不应把真实 upstream alias 暴露出去。

## 2026-06-25 MultiRouter Model Refresh Release Boundary And Timeout Guard

- 用户/他人看到 MultiRouter 路由页“候选 provider 模型列表刷新”一直卡在“正在读取模型列表...”时，先确认运行版本；`v3.16.3-19` tag 指向 `6a1cf4e1`，不包含本地 `ddfeed42 fix(codex): settle multirouter model refresh states`，而本机安装目录 `C:\Users\sunda\AppData\Local\CCSwitchMulti\cc-switch.exe` 仍是 `3.16.3-18`，所以截图类问题很可能是发布包未带修复而不是 HEAD 修复失效。
- 2026-06-25 再次确认：GitHub prerelease `v3.16.3-19` 的 target commit 仍是 `6a1cf4e1`，`ddfeed42` 和 `33a0bc58` 都不在该 tag 内；别人发来的两个 provider 同时显示“正在读取模型列表...”的截图，应优先按“公开包未发布刷新状态机修复”处理。下一次发版必须包含 `ddfeed42`/`33a0bc58`，否则该问题会继续在已安装包里出现。
- `src/components/codex/CodexRouterWorkspacePage.tsx` 的候选 provider 自动刷新现在有双层保护：per-provider active attemptKey 负责防止 rerender cleanup 吞掉 pending 请求终态；前端 `withModelRefreshTimeout` 再给 IPC/后端异常挂起加 30s 兜底，必须让 UI 从 loading 落到错误态。
- attemptKey 不能只记录 `Boolean(apiKey)`；API Key 从一个非空值换成另一个非空值时必须重新发起 `/models` 读取，并让旧请求结果无法写回。当前实现对 API Key 做短哈希后参与内存态 attemptKey，不持久化也不展示完整密钥。
- 回归测试在 `src/components/codex/CodexRouterWorkspacePage.test.ts` 增加两类边界：API Key 变化时 stale request 不写回，以及 `fetchModelsForConfig` 永不返回时 30s 后显示错误而不是永久 loading。

## 2026-06-25 MultiRouter Candidate Model Refresh Loading Fix

- MultiRouter 路由页“候选 provider 模型列表刷新”一直停在“正在读取模型列表...”的根因在前端并发刷新状态机，不是后端 `/models` 请求缺少超时。后端 `src-tauri/src/services/model_fetch.rs` 每个请求已有 15s timeout；问题是 `src/components/codex/CodexRouterWorkspacePage.tsx` 自动刷新多个 provider 时，第一个 provider 成功写回 `providersApi.update` / `setOptimisticRoutingPlan` 会触发 effect cleanup，旧实现用局部 `cancelled` 阻断后续 pending provider 的 `.then/.catch`，而新一轮 effect 又被 `modelRefreshAttemptedKeysRef` 去重跳过，于是 UI 永久留在 loading。
- 修复方式是按 provider 维护当前最新 `attemptKey`，用 `modelRefreshActiveAttemptKeysRef` 判断请求是否仍是该 provider 的最新 attempt；正常 rerender 不再吞掉同批并发请求终态，真实配置变更产生的新 attempt 仍能阻止旧请求覆盖状态或写回 DB。
- 回归测试在 `src/components/codex/CodexRouterWorkspacePage.test.ts` 用可手动 resolve/reject 的 Promise 复现两个 provider 并发：Provider A 先成功并触发 rerender 后，Provider B 后续成功必须显示 `已读取并更新 1 个模型。` 且写回；Provider B 后续失败必须显示错误而不是卡 loading。
- 本轮验证：`pnpm test:unit -- src/components/codex/CodexRouterWorkspacePage.test.ts`、`pnpm typecheck`、`pnpm build:renderer`、`git diff --check`。renderer build 仍只有既有 baseline/browserlist/chunk 警告。

## 2026-06-25 CCSwitchMulti v3.16.3-19 Prerelease

- `v3.16.3-19` 已作为 GitHub prerelease 发布：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-19`。tag 指向版本 bump 提交 `6a1cf4e1`，版本面同步点仍是四处：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`。业务修复提交是 `2e9723c1`（MultiRouter 子 Agent 流量监控 + 浅色主题修复），前面还包含 vLLM/Qwen 上下文窗口修复提交 `7481bbb5`、`6d5d8c02`。
- 本次 release notes 必须继续用中文。内容覆盖：MultiRouter “今日子 Agent 会话流量”、子 Agent/模型聚合、会话用量同步入口、浅色模式可读性修复、vLLM `max_model_len/maxModelLen` 上下文窗口读取、SQLite session_id 分块查询，以及 macOS universal history-repair sidecar 构建修复。
- 本地 Windows 构建路径：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local-release-pipeline.ps1 -ReleaseRoot C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-19 -Reason manual-prerelease-v3.16.3-19`。产出被整理到 `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-19-assets`，包括 setup、setup.sig、portable zip、raw exe、`latest.json`。
- Linux 资产在 WSL `openclaw` 内完成，仍然使用临时 `{"bundle":{"createUpdaterArtifacts":false}}` 配置构建：先 `cargo build --manifest-path src-tauri/Cargo.toml --bin codex-history-repairer --features history-repairer --release`，再 `pnpm tauri build --bundles appimage,deb,rpm --config <tmpfile>`。实际上传资产是 `CCSwitchMulti_3.16.3-19_amd64.AppImage`、`CCSwitchMulti_3.16.3-19_amd64.deb`、`CCSwitchMulti-3.16.3-19-1.x86_64.rpm`。
- macOS 本机仍不能构建；这次通过 `Supplemental macOS Release` workflow_dispatch 构建并上传，run id `28150527263` 成功，耗时约 29m30s。该 workflow 上传了 `CCSwitchMulti_3.16.3-19_universal.tar.gz`、`.tar.gz.sig`、`CCSwitchMulti_3.16.3-19_universal.app.zip`，并刷新 release `SHA256SUMS.txt`。
- 最终 release 资产数为 12：Windows 4 个、Linux 3 个、macOS 3 个、`latest.json`、`SHA256SUMS.txt`。tag/main push 触发的 `.github/workflows/release.yml` push run 仍出现无 job 的失败记录，不作为本次发布路径；本次实际发布路径是手动本地 Windows + WSL Linux + supplemental macOS。
- 本轮验证：`pnpm typecheck`、`pnpm build:renderer`、`cargo check --manifest-path src-tauri/Cargo.toml`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo test --manifest-path src-tauri/Cargo.toml codex_subagent_usage_stats --lib`、`git diff --check`。已知非阻塞警告仍是 Rust unused helper、Vite browserslist/baseline 和大 chunk 警告，以及 Tauri bundler `__TAURI_BUNDLE_TYPE` warning。

## 2026-06-24 MultiRouter Subagent Usage And Light Theme Readability

- MultiRouter 状态页的子 Agent 流量监控不能从真实代理转发日志里直接推断身份；真实代理日志只回答 route/provider/model 的出站归属。子 Agent 监控的来源应固定为 Codex 本地历史 SQLite/JSONL：先用 `thread_source="subagent"` 或 JSONL `session_meta.payload.source.subagent.thread_spawn` 确认子 Agent，再只聚合 `proxy_request_logs` 中 `app_type='codex'`、`data_source='codex_session'`、`session_id IN (subagent session ids)` 的同步用量行。
- 子 Agent 监控的 UI 口径是“本地 Codex 会话 token_count 同步后的用量”，不是代理层实际请求转发次数；因此页面需要保留“今日子 Provider / Model 流量”和“今日子 Agent 会话流量”两个分区，前者看真实出站，后者看子 Agent/模型消耗。
- MultiRouter 页面和第三方 Agent API 页面浅色模式修复应优先使用 `bg-card`、`bg-muted`、`bg-background`、`text-foreground`、`text-muted-foreground`、`border-border` 等语义 token，再把原来的深色透明样式放进 `dark:` 变体。不要在浅色主类里继续使用 `bg-slate-950/*`、`text-slate-100`、`text-white` 或深色半透明卡片。
- 子 Agent 会话统计查询 `session_id IN (...)` 时必须分块，当前保守批量是 500；`get_codex_subagent_usage_stats` 默认会为了状态页读取最多 1600 条历史、最多 5000 条只读候选，因此不要把所有 session_id 一次塞进 SQLite 变量绑定。
- 本轮验证基线：`pnpm typecheck`、`pnpm build:renderer`、`cargo fmt --manifest-path src-tauri/Cargo.toml --check`、`cargo test --manifest-path src-tauri/Cargo.toml test_codex_subagent_usage_stats_only_counts_subagent_session_rows --lib`、`cargo check --manifest-path src-tauri/Cargo.toml`。Rust 只剩既有 `commands/misc.rs` unused 警告；renderer build 只剩既有 browserslist/baseline 和大 chunk 警告。

## 2026-06-24 CCSwitchMulti v3.16.3-18 GitHub Release

- 远端 `BigStrongSun/ccswitchmulti` 已经存在 `v3.16.3-17` prerelease（含本地 Windows/Linux 资产），因此这次不能复用旧 tag；新的正式 release 需要前进到 `v3.16.3-18`。版本面同步点仍是四处：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json`。
- `v3.16.3-18` GitHub Release 已发布为 Latest：`https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-18`。release tag 指向提交 `6ff4252f`（版本 bump + unsigned macOS workflow 基线），后续 workflow 修复继续落在 `main` 上的 `93ec101b`，然后用 `workflow_dispatch` 构建同一个 tag 的补充资产。
- 本地 Windows 构建由 post-commit release hook 自动触发成功，随后用 `scripts/export-latest-ccswitchmulti.ps1 -SkipBuild -ReleaseRoot C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-18` 固化干净版本目录。发布 staging 目录是 `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-18-assets`，只保留本次 release 实际上传的 Windows/Linux 资产与 `latest.json`。
- 本地 Linux 构建是在 WSL `openclaw` 中完成的，命令路径要先补 `PATH=\"$HOME/.cargo/bin:$PATH\"`，再构建 `codex-history-repairer` sidecar，然后用临时 `{\"bundle\":{\"createUpdaterArtifacts\":false}}` 配置执行 `pnpm tauri build --bundles appimage,deb,rpm --config <tmpfile>`。这次实际产物是 `CCSwitchMulti_3.16.3-18_amd64.AppImage`、`CCSwitchMulti_3.16.3-18_amd64.deb`、`CCSwitchMulti-3.16.3-18-1.x86_64.rpm`。
- macOS 本地构建在这台 Windows 主机上仍然不可行，硬边界是 Tauri 需要目标平台原生运行时和 macOS SDK/WebKit，而不是“少装一个 Rust target”。能完成的是 GitHub macOS runner 上的 unsigned supplemental build。
- 第一次 supplemental macOS workflow（run `28094163276`）失败的真实根因不是签名，而是 universal 打包阶段缺少 `src-tauri/target/universal-apple-darwin/release/codex-history-repairer`。修复方式不是重试，而是在 `.github/workflows/release.yml` 和 `.github/workflows/supplemental-macos-release.yml` 中都显式为 `codex-history-repairer` 构建 `aarch64-apple-darwin` 与 `x86_64-apple-darwin`，再用 `lipo` 合成 universal sidecar。
- 第二次 supplemental macOS workflow（run `28095435446`）成功后，release 额外补齐了 unsigned macOS 资产：`CCSwitchMulti_3.16.3-18_universal.tar.gz`、`CCSwitchMulti_3.16.3-18_universal.tar.gz.sig`、`CCSwitchMulti_3.16.3-18_universal.app.zip`，并自动刷新了 `SHA256SUMS.txt`。最终 release 共有 12 个资产：Windows 4 个、Linux 3 个、macOS 3 个、`latest.json`、`SHA256SUMS.txt`。
- 这条发布线还有两个环境约束要记住：一是 `.github` 被仓库 `.gitignore` 忽略，新增或修改 workflow 时必须 `git add -f .github/workflows/...`；二是本地 `post-commit` hook 会自动跑 `scripts/local-release-pipeline.ps1` 并占用 `scripts/logs/local-release.lock`，发布期间不要并发再起第二个本地构建。

## 2026-06-24 MultiRouter Protocol Probe And Codex Responses Decision Unification

- 当前 Codex MultiRouter 的 `/responses` -> 上游协议选择，本质上一直是“配置判定”，不是在线能力探测。单一真理来源现在收敛到 `src-tauri/src/proxy/providers/codex.rs::explain_codex_responses_upstream_protocol`：优先级为 managed `codex_oauth` 直连官方 `responses` > `meta.apiFormat` > `settings_config.api_format/apiFormat` > 已知 Chat Completions-only `base_url` > `config.toml wire_api` > 默认 `responses`。
- 这次修复顺手把一个关键边界钉死：只要 provider 被识别为 managed Codex OAuth，哪怕残留了 `apiFormat=openai_chat` 之类污染字段，也必须保持原生 `chatgpt.com/backend-api/codex/responses` 透传，不能再被误转成 `/v1/chat/completions`。
- `src-tauri/src/commands/proxy.rs` 的 MultiRouter 诊断现在会为每条 route 返回 `configuredProtocol/configuredProtocolSource/configuredProtocolDetail`，而且 route 摘要不再自己猜 target provider 配置，而是通过与运行态一致的 `build_codex_route_probe_provider` 物化 effective provider 后再判定。
- `codex-router.log` 的 `request_prepared` 事件原本就包含 `effective_endpoint`、`upstream_url`、`responses_to_chat`、`responses_to_messages`。现在诊断层会把这些字段解析成 `actualProtocol`，前端状态页“协议探测”视图可按每个 `Provider + Model` 展示“配置判定”与“最近实测”，直接看出最后一次真实出站走的是 `responses`、`chat` 还是 `messages`。
- 状态页里的“协议探测”按钮不会主动消耗真实上游额度；它只读取当前 route 配置和最近 router 日志。因此它解决的是“当前代码会怎么判、最近一次实际怎么走”的可见性问题，不是远端能力协商。如果后续真要做在线 capabilities probe，需要单独设计安全的探测请求与缓存。

## 2026-06-24 Codex Official Context Window Live Fallback

- 在 `src-tauri/src/codex_config.rs` 中，官方 GPT/Codex 模型的上下文窗口读取链现在是：provider DB 显式 `contextWindow` > `~/.codex/models_cache.json` > 本机已登录 Codex OAuth 账号实时拉取 `https://chatgpt.com/backend-api/codex/models` > `config.toml` 的 `model_context_window` > 最终默认值 `128000`。
- 这条 live fallback 专门覆盖首次配置、用户清理 `models_cache.json`、缓存损坏、以及缓存里只有 slug 但缺少 `context_window` 的场景，避免 Codex Desktop 又回退成 128k/约 122k 的显示。
- 同步桥接异步 OAuth 拉模时，不要在已有 Tokio runtime 里直接嵌套 `block_on` 或用当前线程硬顶网络 future。当前实现改为把 live 官方读取放到独立线程，再在该线程里使用 `tauri::async_runtime::block_on`，这样不会污染调用侧 runtime，也更适合 Tauri 同步配置生成路径。
- 回归测试必须至少覆盖三类边界：`models_cache.json` 缺失、JSON 损坏、缓存存在但缺失上下文字段；三种情况下都应能从 live OAuth 元数据恢复 `context_window`。

## 2026-06-24 Release Workflow Fork Secret Degradation

- `fork` 仓库的 release matrix 不能假设一定有 Apple 签名/公证 secrets。若 `APPLE_CERTIFICATE` 一类 secret 为空，旧 workflow 会在 `Import Apple signing certificate` 直接失败，并因为 matrix 默认 `fail-fast` 取消掉本来还能完成的 Windows/Linux 打包。
- 修复策略：`release.yml` 里将矩阵改为 `fail-fast: false`；macOS 证书导入、DMG 公证、签名验证只在 Apple secrets 和 `APPLE_SIGNING_IDENTITY` 都存在时执行。缺少签名材料时，macOS 仍然产出 updater `.tar.gz` 和 `.zip`，但跳过 `.dmg`、公证与签名校验，不再拖死整条 release。

## 2026-06-24 Codex Official GPT Context Window Projection Fix

- 现场现象：Codex Desktop 里官方链路/Multirouter 的 `gpt-5.5` 显示约 122k 上下文，而 CCSwitchMulti live `config.toml` 和 `cc-switch-model-catalog.json` 中 `gpt-5.5` 已是 272000。122k 与 128000 的 `effective_context_window_percent=95` 接近，说明 Desktop 某条读取路径忽略了 272000 后回退到了默认 128k。
- 根因边界：`src-tauri/src/proxy/handlers.rs` 的 Codex client `GET /v1/models` 会把 cc-switch catalog 扩展成 OpenAI-compatible `data[]`。该 `data[]` 以前只写 `context_window` / `max_context_window`，没有 `contextWindow` / `maxContextWindow`。Codex Desktop 某些 renderer/app-server 路径读取 `data[]` 时会看 camelCase 字段，读不到就按默认 128k 再乘 95% 展示。
- 修复：`openai_model_entry_with_source` 在 `data[]` model entry 中同时投 snake_case 与 camelCase：`context_window`、`max_context_window`、`contextWindow`、`maxContextWindow`。这不改变 raw `models[]` catalog 和已有外部 OpenAI API 兼容字段，只补齐 Desktop 读取别名。
- 回归测试：`proxy::handlers::tests::codex_catalog_models_response_keeps_catalog_and_openai_data` 必须断言四个上下文字段都存在并等于源 catalog 值。
- 后续根治：`src-tauri/src/codex_config.rs` 生成 catalog spec 时，官方 GPT/Codex 模型若 DB `modelCatalog` 未显式写 contextWindow，应优先读取 Codex 官方 `models_cache.json` 的动态上下文窗口，再回退到 `model_context_window` / 128000。不要继续把 `272000` 等 OpenAI 数值当成唯一真实来源。

## 2026-06-24 Qwen Local Context Window Fetch Fix

- 用户现场把问题边界收紧到“获取模型列表阶段没拿到 `qwen3.6=262144`，导致 Codex catalog/压缩阈值先错了”，而不是单纯的 `/responses -> chat` 输出预算裁剪。上游报错里出现的 `262144` 只是运行时错误文本，本地之前不会把它自动回写到 provider catalog。
- 直接探测用户这条 vLLM 端点 `https://www.matrixminecraft.cn:24443/vllm/v1/models` 后确认：远端其实已经返回了 `max_model_len: 262144`，并不是“vLLM 没给上下文窗口”。根因是 `src-tauri/src/services/model_fetch.rs::extract_context_window` 只识别 `context_window/max_context_window/contextWindow/maxContextWindow`，没识别 vLLM 的 `max_model_len/maxModelLen`。
- 因此正确修复不是给 `qwen3.6` 做应用级静态兜底，而是在配置阶段的真实 `/models` 读取里补上 vLLM 字段解析。这样点“获取模型列表”时就能直接把 `262144` 写进 provider catalog，MultiRouter 和 Codex picker 后续都读取真实值。
- 回归测试改为覆盖 `max_model_len` 和 `maxModelLen` 两种 vLLM 风格字段；`pnpm test:unit -- tests/utils/codexModelContext.test.ts tests/utils/codexSpawnAgentCandidates.test.ts`、`pnpm typecheck`、`cargo test --manifest-path src-tauri/Cargo.toml switching_codex_router_provider_auto_enables_dedicated_local_takeover --lib` 全部通过。

## 2026-06-24 Codex Provider Model Context Window Fallback

- 根因：DeepSeek 等 OpenAI-compatible provider 的 `/models` 端点仅返回模型 id（如 `deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash`），不承诺返回 `context_window` 字段。而 Codex provider 表单的"获取模型列表"按钮和 MultiRouter 工作台的自动候选刷新都只在 `fetched.contextWindow` 为 truthy 时才写入上下文窗口，远端没给就留空。
- 修复策略：引入共用工具 `src/utils/codexModelContext.ts`，为 `mergeFetchedModelsIntoCatalogRows`（普通表单）和 `providerWithFetchedModelCatalog`（MultiRouter 候选刷新）提供统一的上下文推断优先级：远端显式值 > 用户已有目录值 > 本地 provider/model 预设元数据。预设匹配会对比 providerId/name/baseUrl/websiteUrl 信号以避免同名模型跨供应商误套。
- DeepSeek 兼容别名（`deepseek-chat`、`deepseek-reasoner`）也在工具中写入了显式 1M 上下文映射，不会因为上游返回旧式 id 而丢上下文。
- 测试 `tests/utils/codexModelContext.test.ts` 覆盖：远端显式值优先、已有目录保留、DeepSeek 预设兜底、DeepSeek 别名兜底、未知模型不捏造上下文。
- 相关提交：该修复同时变更 `CodexFormFields.tsx` 和 `CodexRouterWorkspacePage.tsx`，让两处上下文合并逻辑共用同一推断函数。

## 2026-06-24 Empty Codex Official Seed OAuth Routing Fix

- v3.16.3-15 的 official/OAuth materialize 修复仍有一个漏网条件：全新安装或恢复后的 `codex-official` 可能只是 `category="official"` 的空 seed provider，`settings_config.auth` 为空且没有 `base_url`，真实 OAuth 账号在 CCSwitchMulti 的 `CodexOAuthManager` 存储里。旧判断只认 `meta.providerType="codex_oauth"`、provider 内 `auth.auth_mode="chatgpt"` / tokens，或 router provider 自身的 managed auth，因此空 seed 被误当普通 Codex provider，GPT 原生 route 命中后仍会在 `CodexAdapter::extract_base_url` 报 `Codex Provider 缺少 base_url 配置`。
- 修复应把 `category == "official"` 且 id/name/route target 明确标记 `codex-official` / `OpenAI Official` 的空 seed 识别为 managed Codex OAuth，但继续让带真实非本地 `base_url` 的 provider 走普通第三方路径，避免误伤自定义 OpenAI-compatible provider。
- 回归测试要覆盖两条路径：MultiRouter `targetProviderId="codex-official"` 命中空 official seed 后 materialize 成 `meta.provider_type="codex_oauth"`；以及直接对空 official seed 调 `CodexAdapter` 时返回 `https://chatgpt.com/backend-api/codex` 和 `AuthStrategy::CodexOAuth`。

## 2026-06-24 Qwen MultiRouter Live Route Check

- 用户现场怀疑 MultiRouter 到 `qwen3.6` 的请求没有真正发出去。只读复查确认当前 live `~/.codex/config.toml` 已指向 `model_provider = "codex_model_router_v2"` 和 `base_url = "http://127.0.0.1:15721/v1"`，`cc-switch.exe` 进程 `C:\Users\sunda\AppData\Local\CCSwitchMulti\cc-switch.exe` 同时监听 `15721` 与 `15722`，`http://127.0.0.1:15721/health` 返回 200。
- 当前 DB 里 `codex-openai-router` 是 Codex current provider，`settings_config.codexRouting` 为对象 schema；`qwen-local` route 启用，匹配 `qwen3.6` / `qwen` 前缀，上游为 `https://www.matrixminecraft.cn:24443/vllm/v1`，`wire_api=openai_chat`，并保留 `codexChatReasoning` 的 `enable_thinking` 与 `minOutputTokens=2048`。
- 真实 `spawn_agent model=qwen3.6` 极小请求返回 `OK`。同一时间 `~/.cc-switch/logs/codex-router.log` 出现完整链路：`route_resolved route_id=qwen-local route_missed=false`、`request_prepared upstream_url=https://www.matrixminecraft.cn:24443/vllm/v1/chat/completions responses_to_chat=true`、`auth_prepared auth_strategy=Bearer`、`upstream_send`、`upstream_status status=200`、`response_ready status=200`。这证明当前 MultiRouter 路由层和 15721 转发链路是通的，请求确实进了 qwen 上游。
- 本轮直接探测 `https://www.matrixminecraft.cn:24443/vllm/v1/models` 曾先返回 502，随后返回 200 且列出 `qwen3.6`；因此“卡住/没反应”更像上游 vLLM/relay 短暂抖动、模型冷启动或当时请求未实际选择/发出 qwen，而不是当前 MultiRouter 配置缺 route。后续复现时优先抓失败时刻的 `codex-router.log`：若没有 `model=qwen3.6` 新行，问题在 Codex/子 Agent 发起前；若有 `upstream_send` 但无 200，则看上游状态、首包超时或 502/521。

## 2026-06-24 CCSwitchMulti 3.16.3-15 GitHub Release

- Published `https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-15` from local `main` after pushing commit `0739638b` and annotated tag `v3.16.3-15` to the `fork` remote (`https://github.com/BigStrongSun/ccswitchmulti.git`).
- This release is the hotfix successor to `3.16.3-14` for Codex MultiRouter regressions. It includes legacy array-shaped `settings_config.codexRouting` compatibility, Rust route resolver support before UI resave, official/OAuth target provider local-proxy pollution handling, and follow-up diagnostics hardening.
- Verification before release: `pnpm typecheck`, `pnpm vitest run src/components/codex/CodexRouterWorkspacePage.test.ts tests/components/useCodexConfigState.test.ts`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, and `cargo test --manifest-path src-tauri\Cargo.toml codex_route --lib`.
- Windows export root: `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-15`. The first full export timed out at the shell after 15 minutes while `cargo/rustc` was still running; after the build and NSIS processes finished, rerunning `scripts\export-latest-ccswitchmulti.ps1 -ReleaseRoot ... -SkipBuild` completed export, signing, `latest.json`, and checksum generation.
- Initial Windows-hosted upload included `CCSwitchMulti_3.16.3-15_x64-setup.exe`, `.sig`, `CCSwitchMulti_3.16.3-15_x64-portable.zip`, `CCSwitchMulti_3.16.3-15_x64.exe`, `latest.json`, `README.md`, `linux-build-note.md`, `macos-build-note.md`, and `SHA256SUMS.txt`.
- Follow-up Linux supplement: the local WSL build produced AppImage/deb/rpm after first building the `codex-history-repairer` sidecar, but local uploads to `uploads.github.com` repeatedly stalled or disconnected. Commit `ffc2fa0e` added `.github/workflows/supplemental-linux-release.yml`, then GitHub Actions run `28076382107` built and uploaded Linux x86_64 assets for `v3.16.3-15`.
- Final release assets include Linux x86_64 `CCSwitchMulti_3.16.3-15_amd64.AppImage`, `CCSwitchMulti_3.16.3-15_amd64.deb`, and `CCSwitchMulti-3.16.3-15-1.x86_64.rpm`; `linux-build-note.md` was removed after the real Linux packages were uploaded. macOS aarch64 `dmg` and `.app.zip` assets are also present on the release.
- Important release hygiene: the export script's default `SHA256SUMS.txt` is a full export-tree checksum and may include internal tool files or nested platform notes that are not uploaded as release assets. For `v3.16.3-15`, `SHA256SUMS.txt` was regenerated from GitHub release asset digests so every entry corresponds to a downloadable asset.

## 2026-06-23 CCSwitchMulti 3.16.3-14 MultiRouter Route Regression

- `3.16.3-14` 的用户现场证明存在真实回归：MultiRouter provider 仍存在，但 `settings_config.codexRouting` 可能被保存成扁平数组，缺少新版对象外壳 `{ enabled, routes, defaultRouteId }`。新版前后端若只按对象 schema 读取，会表现为 `routing_configured=false` 或 `route_missed=true`，随后请求回落到 MultiRouter provider 自身；MultiRouter 自身不是普通上游，没有真实外部 `base_url`，会报 `Codex Provider 缺少 base_url 配置` 或递归保护 400/502。
- 根因不是 DeepSeek key、网络、用户教程步骤或必须删库重配。现场“直接写 SQLite 把 codexRouting 修成对象”只能作为临时恢复，产品修复必须兼容已损坏/旧式数组 schema，并在 UI 保存时自动迁移回对象 schema。
- 修复点：`CodexRouterWorkspacePage.readCodexRouting` 和 `useCodexConfigState.extractCodexRoutingConfig` 都必须先判断 `Array.isArray(codexRouting)`，将 legacy route 数组迁移成 `{ enabled: true, routes: [...] }`，避免 `typeof [] === "object"` 路径把 routes 清空。Rust `proxy/providers/codex.rs` 的 route resolver 也必须直接消费数组型 `codexRouting`，这样用户未重新保存 DB 前请求链路也能恢复。
- 第二层现场污染：OpenAI Official target provider 可能被写入本地接管代理 `127.0.0.1:15721`，导致 GPT route 命中后又递归回本机代理。route materialize 时，official/OAuth 目标 provider 的本地 proxy `base_url` 不能被当作真实上游；应按托管 Codex OAuth 处理并让 `CodexAdapter` 使用 `https://chatgpt.com/backend-api/codex`。
- 回归测试应覆盖：前端读取 legacy array 不丢 route；表单初始化 legacy array 不清空 route；后端 resolver 能用 legacy array 匹配 GPT/DeepSeek；official target provider 带本地 proxy `base_url` 时仍 materialize 为 `codex_oauth`。

## 2026-06-23 Codex History Repair State DB Auto Detection

- Codex history repair must not hard-code `~/.codex/sqlite/state_5.sqlite` as the default active DB. macOS user reports and upstream Codex issue evidence point to the current default state DB at `~/.codex/state_5.sqlite`; the `sqlite/` child directory is only a compatibility fallback for older/local transitional builds.
- Active DB resolution order should be: explicit UI/CLI override path, `sqlite_home` from Codex config, `CODEX_SQLITE_HOME`, default root `~/.codex/state_5.sqlite`, then legacy fallback `~/.codex/sqlite/state_5.sqlite`. This preserves configured migrations while fixing default macOS detection.
- The history repair UI should describe the default as `~/.codex/state_5.sqlite` and mention automatic `sqlite_home` / `CODEX_SQLITE_HOME` detection, so users do not manually copy the stale sqlite-subdir path into the override field.

## 2026-06-23 MultiRouter Model Modality Alignment

- MultiRouter 不能给新建 route 默认写入 `capabilities: { inputModalities:["text","image"], textOnly:false, supportsReasoning:true }`。这会把 DeepSeek V4 Flash/Pro 等纯文本模型错误标成图文，并且后端 `codex_routing_capabilities_for_model` 会优先信任 route 能力，覆盖模型名纯文本兜底。
- 正确能力来源顺序：route 显式能力 > `modelCatalog.models[]` 条目能力（`inputModalities` / `textOnly` / `supportsImage` / `vision` / `capabilities`）> 保守模型名兜底。未知模型不要默认标成图文，避免多模态/纯文本静默误判。
- DeepSeek Codex 预设的 `deepseek-v4-flash` 和 `deepseek-v4-pro` 应在 `modelCatalog` 中声明 `inputModalities:["text"]`、`textOnly:true`、`supportsImage:false`；MultiRouter 聚合 catalog 要保留这些字段并同步写入 route/catalog 能力。
- Rust `codex_config.rs` 生成 Codex Desktop model catalog 时，也要读取 `modelCatalog.models[]` 的能力声明；只看 route 能力或硬编码模型名会让前端目录和后端投影再次分叉。

## 2026-06-22 Codex MultiRouter User Guide

- 新增用户向说明书 `docs/guides/codex-multirouter-guide-zh.md`，定位为把 Codex Desktop 登录、CCSwitchMulti OAuth 授权、第三方模型源、本地路由映射、MultiRouter 工作台、子 Agent 前 5 候选排序、路由启动、Debug 检查、Codex 重启和历史修复串成完整流程的中文 Markdown。
- 文档只引用仓库已有真实截图：`docs/images/codex-official-auth-preservation/01-codex-app-enhancement-setting.png`、`docs/images/codex-deepseek-routing/01-codex-providers-require-routing.png`、`02-deepseek-codex-routing-form.png`、`03-local-route-codex-takeover.png`。MultiRouter 工作台、子 Agent 排序、状态 Debug、会话管理历史修复等新页面尚无真实截图，文档末尾列出待补路径，后续应补真实 UI 截图，不要伪造。
- 使用规则固化：先登录 Codex Desktop，再在 CCSwitchMulti `设置 → 认证` 完成 ChatGPT/Codex OAuth；额外模型源如 DeepSeek/GLM/本地模型通常要开启 `需要本地路由映射`，在高级选项 `模型映射` 中点击 `获取模型列表` 并配置上下文窗口；MultiRouter 的 `子 Agent 候选模型` 必须手动把目标模型排入前 5 并 `保存排序`；保存/切换/模型目录变化后必须完全退出并重启 Codex Desktop。
- 历史修复说明保持当前产品边界：历史入口在右上角时钟/会话管理页的 `Codex 历史修复`，流程是 `加载历史`、按需全选当前页、`预览修复`、确认计数后 `确认写入`，完成后再次重启 Codex。该功能修复 provider bucket 可见性，不应表述为会话正文丢失修复。
- 主 `README.md` 前部的 CCSwitchMulti 分支说明后新增 `Codex 多路由配置说明书` 小节，直接链接 `docs/guides/codex-multirouter-guide-zh.md`，让首次配置用户先读完整流程而不是只看功能截图。
- 2026-06-22 用户补齐 MultiRouter 教程真实 UI 截图，稳定保存到 `docs/images/codex-multirouter/`：`01-settings-auth-oauth.png`、`02-add-provider-entry.png`、`03-configure-provider-local-routing.png`、`04-fetch-models-context-window.png`、`05-multirouter-entry.png`、`06-create-multirouter.png`、`07-configure-route-rules.png`、`08-save-route-rules.png`、`09-subagent-model-order.png`、`10-enable-routing-settings.png`、`11-debug-entry.png`、`12-13-history-repair-panel.png`、`13-codex-model-picker-validation.png`。这些图对应用户指定的 1-13 步及重启后 Codex 模型候选验证，不要再把这些场景列为待补截图。
- 渲染产物：`docs/images/codex-multirouter-guide/pages/` 保存 Markdown 说明书按页渲染的 PNG，规格为 1440x2400；当前页码包括 `00-overview.png`、`01-flow.png`、`02-step-1.png` 到 `12-step-11.png`、`13-faq.png`、`14-related-docs.png`，并有 `manifest.json` 记录标题和路径。说明书截图变更后必须重新生成这些分页 PNG 和 `output/pdf/codex-multirouter-guide-zh.pdf`。
- 2026-06-23 说明书分页生成流程已抽成仓库内 skill：`skills/markdown-paged-guide/`，包含 `scripts/render_paged_guide.cjs` 和 `scripts/pngs_to_pdf.py`。后续截图型 Markdown 说明书应优先用 `<!-- guide-page: file.png | title -->` 显式分页，统一用 `--max-image-height` 控制全书截图尺寸，再输出 `pages/manifest.json` 与 PDF。当前 MultiRouter 教程已改为 15 页：第一页入门准备，第二页 `总流程速览`，截图统一 `maxImageHeight=500`，避免双截图页底部溢出。

## 2026-06-22 CCSwitchMulti README Xiaohongshu Feedback QR

- GitHub multi README 的活跃源码落点是 `C:\Users\sunda\Documents\LLMservice\cc-switch\README.md`，对应 `fork` remote `https://github.com/BigStrongSun/ccswitchmulti.git`；`C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti` 是固定交付/发布目录，不作为源码 README 修改点。
- README 顶部反馈入口使用仓库内资产 `assets/xiaohongshu-discussion-qr.png`，由用户提供的小红书群截图裁剪出纯二维码区域；README 引用路径保持相对路径 `assets/xiaohongshu-discussion-qr.png`，便于 GitHub 渲染。
- 顶部说明保留两条反馈路径：提交 GitHub Issue，或扫码加入小红书讨论群；二维码来自 2026-06-22 截图，标注有效期至 2026-07-20，后续过期需要替换同名资产并更新有效期文案。
- 纠正：GitHub 默认渲染的 `README.md` 应恢复并保持 `ff29c274 docs(readme): add ccswitchmulti screenshots and scenario` 那版中文 CCSwitchMulti 专属 README，包含“适合谁使用”“功能截图”和 MultiRouter 截图说明；不要用上游 `README_ZH.md` 或英文 `README.md` 覆盖默认首页。
- 配套图片资产必须随该版 README 一起保留：`assets/screenshots/ccswitchmulti/{provider-list,multirouter-status,multirouter-routes,codex-model-picker,usage-statistics}.png` 以及历史赞助图 `assets/partners/logos/lemondata.png`、`assets/partners/logos/ccsub.jpg`。如果只恢复 README 而不恢复这些文件，GitHub README 会出现大面积图片加载失败。

## 2026-06-22 MultiRouter Deletion Flow

- MultiRouter provider 通常就是 Codex 当前 provider；普通 provider 删除链路前端会禁用当前项，后端 `ProviderService::delete` 也会拒绝删除当前 provider，所以工作台必须提供 MultiRouter 专用删除入口。
- 删除当前 Codex MultiRouter 前，先自动切到一个非 MultiRouter 的普通 Codex provider 作为 fallback，再调用原有 `delete_provider`。不要绕过后端当前 provider 保护；保护逻辑仍用于防止误删正在使用的普通 provider。
- 工作台内至少在总览方案卡、路由规则页方案卡、状态页当前方案操作区展示删除按钮。删除动作仍走统一确认框，避免误点。

## 2026-06-22 MultiRouter Routes Compact Layout

- MultiRouter 规则配置页要优先按“同屏操作台”处理：顶部状态只做紧凑状态带，方案栏和规则详情栏不要固定到 360px，主布局应控制在约 300px 侧栏，避免小窗口时规则列表、详情和子 Agent 候选区被挤出屏幕。
- 候选 provider 模型刷新提示必须保留失败可见性，但成功/读取中的状态适合做一行紧凑条目；不要让刷新成功列表单独撑出一个大卡片高度。
- 子 Agent 候选模型面板的右侧候选池需要有 `max-height` + 内部滚动，预览卡片和拖拽项保持低高度；否则候选池会把整个 MultiRouter routes 页向下撑开，截图里顶部和候选区无法一页看全。

## 2026-06-22 MultiRouter Candidate Provider Model Refresh

- MultiRouter 路由规则页不能只消费普通 provider 已经持久化的 `settingsConfig.modelCatalog`，否则新建/切换 MultiRouter 时会停留在旧 GPT fallback，Qwen/DeepSeek/VLLM 等候选普通 provider 不会进入子 Agent 候选。
- 进入 `CodexRouterWorkspacePage` 的 `routes` tab 时，应自动对所有候选普通 Codex provider 调用 `fetch_models_for_config` 读取 `/models`；读取成功后写回该 provider 的 `settingsConfig.modelCatalog.models` 和 `spawnAgentModels`，并同步重建所有引用它的 MultiRouter plan catalog。
- 官方/OAuth provider 没有普通 base_url/API key 时跳过普通 `/models` 读取；普通 provider 缺 base_url、缺 API key、返回空列表或请求失败时，要在路由页和候选 router 卡片上明确提示“获取模型列表失败，请检查当前 provider 配置”。
- MultiRouter 的 `buildModelCatalogForRoutes` 必须按当前 routes 重建 catalog，只复用旧 catalog 的 display/context 元数据，不能无条件保留旧模型；否则取消 GPT route 或改成 VLLM/Qwen route 后，旧 GPT fallback 仍会污染 spawn_agent 前五候选。
- 普通 Codex provider 的“获取模型列表”按钮应把远端模型合并进模型映射表，并在保存时即使不是 `openai_chat` 也持久化非 official provider 的 modelCatalog；保存时空的 `spawnAgentModels` 要从 catalog 前五个自动补齐。

## 2026-06-21 WebDAV Cross-Device Codex Config Contamination

- WebDAV/S3 v2 sync does not upload `~/.codex/config.toml` as a raw file; the protocol uploads `db.sql` plus `skills.zip`.
- The synced SQL snapshot still includes portable and non-portable configuration rows such as `providers`, `mcp_servers`, `settings`, and `proxy_config`. After another device downloads the snapshot, normal CC Switch logic can write those DB rows back into that device's live Codex `~/.codex/config.toml`.
- Therefore cross-user WebDAV sync can effectively contaminate another machine's Codex config with the source machine's absolute paths, for example `notify`, `mcp_servers.*.command`, `mcp_servers.*.args`, local plugin/runtime cache paths, or provider config snippets that contain `C:\Users\<source-user>\...`.
- Do not treat this as Codex randomly generating bad paths. The root cause boundary is CC Switch sync importing machine-local DB values and later live-syncing them to Codex. Safe cross-device sync needs either excluding machine-local rows/fields or adding a per-device reconciliation/sanitization step before writing live configs.

## 2026-06-21 CCSwitchMulti 3.16.3-6 Local Export

- Version bump for the local manual-test build must update all four version surfaces: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock`.
- The local export pipeline for `3.16.3-6` produced Windows artifacts under `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`: `windows\installer\CCSwitchMulti_3.16.3-6_x64-setup.exe`, `windows\portable\CCSwitchMulti_3.16.3-6_x64-portable.zip`, and `windows\raw-exe\CCSwitchMulti_3.16.3-6_x64.exe`.
- Post-commit release hooks can start a background full build immediately after release/version commits. If a manual run hits `scripts\logs\local-release.lock`, inspect `scripts\logs\post-commit-release.log` and wait for cargo/rustc/makensis to exit instead of starting competing builds.

## 2026-06-21 Codex MultiRouter Route Toggle UX

- The MultiRouter route picker has two independent states: candidate membership and route enabled. UI labels must spell this out as `未加入`, `已加入并启用`, or `已加入但停用`; using only `启用/停用` makes users think the checkbox itself is the enabled state.
- In the generic Codex Provider edit form, route row switches must synchronously publish the full `codexRouting` object back to the parent form. Relying only on a child-to-parent effect introduces a one-render race where toggling a route and immediately pressing Save can persist the old enabled value.
- OpenAI/Codex official providers can legitimately have no `modelCatalog`. For route creation/picker display, only those OpenAI-like sources should get GPT/O-series fallback models; do not apply the fallback to every provider whose id starts with `codex-`, or Qwen/DeepSeek catalogs get polluted.
- `RouteCandidatePicker` 的 `selectedIds/enabledIds` 是未保存的本地草稿；同一个多路路由内普通父组件重渲染、provider refetch 或 optimistic plan 刷新时，不能再从 `candidate.route.enabled` 重新初始化，否则用户刚点的 `已启用` 会被旧配置覆盖回 `已停用`。父层 `routingPlans/modelSources` 应保持 memoized，子层候选刷新时只给新出现的 router 应用默认值，已有候选必须保留草稿状态。
- 子 Agent 候选模型面板右侧候选池不要使用固定 `max-h-*` 做滚动高度；它位于和左侧拖拽列表同一行的 grid 中，右侧卡片应 `h-full min-h-0 flex flex-col`，Tabs content 用 `flex-1 min-h-0`，列表自身 `h-full overflow-y-auto`，否则右下角滚动范围会和紫色外框高度不一致。

## 2026-06-21 Codex MultiRouter Picker Persistence

- MultiRouter 工作台的“创建多路路由”不能复用普通 Provider 创建表单；普通表单不会初始化 `settingsConfig.codexRouting`，会把新对象归到普通模型源，导致新建的多路路由在 MultiRouter 列表不可见。
- 正确创建路径是直接 `providersApi.add(nextPlan, "codex", false)` 写入一个带 `settingsConfig.codexRouting.enabled=true`、`routes=[]`、`modelCatalog` 初始目录的 Codex provider，然后打开候选 router 选择器。
- 候选 router 保存时必须把宽松 route 规整成后端可消费结构：稳定 `id`、`enabled`、`targetProviderId`、`match.models/prefixes`、`upstream.apiFormat`、`upstream.auth`，并确保 `defaultRouteId` 指向现有 route。
- 保存候选 routes 时同步重建 `settingsConfig.modelCatalog` 和 `spawnAgentModels`，否则 Codex 选择器/子 Agent 可见模型会与路由规则不一致。
- Tauri/Rust 持久化链路对 `settingsConfig` 是整段 JSON 直通保存：`providersApi.add/update` -> `ProviderService::add/update` -> `db.save_provider` -> SQLite `providers.settings_config`。后端不会裁剪 `codexRouting` 或 `modelCatalog`，本次修复不需要后端 schema 改动。
- MultiRouter provider 自身不是普通 Codex 上游，不应该进入通用 ProviderForm 去填 API Key、API 请求地址、本地模型路由或模型目录。多个 MultiRouter 共享同一套系统投影接管语义：Codex live config 指向 `codex_model_router_v2`、`http://127.0.0.1:15721/v1`、`wire_api=responses` 和 `cc-switch-model-catalog.json`，这些由切换/接管流程和工作台自动维护；用户只编辑方案名称、备注、入口启用、默认 route 和候选 routes。

## 2026-06-16 External OpenAI API Chinese Input Diagnostics

- Current live external Agent API profile was verified read-only from `~/.cc-switch/cc-switch.db`: enabled on `0.0.0.0:15722`, `backendType=provider`, `appType=codex`, `providerId=codex-official`, `defaultModel=gpt-5.5`. This means the reported `/v1/chat/completions` issue goes through External Chat Completions -> synthetic `codex_oauth` provider -> ChatGPT Codex `/backend-api/codex/responses`, not through the normal `15721` MultiRouter route table.
- Source-level UTF-8 chain remains `body.collect().to_bytes()` -> `serde_json::from_slice` -> `serde_json::Value` -> `chat_completions_request_to_codex_responses` -> `serde_json::to_vec` -> reqwest body; no ASCII/Latin-1/GBK conversion was found.
- Real compatibility gap fixed in `src-tauri/src/proxy/providers/openai_compat.rs`: Chat message content parts with Responses-style `type: "input_text"` or `type: "output_text"` were previously dropped because only `type: "text"` was accepted. This can make Codex see only surviving English tokens or references from mixed third-party Agent payloads. The converter now preserves `text`, `input_text`, and `output_text` as Responses text parts.
- Added non-content diagnostics for the external codex-official path: `external_chat_unicode_probe` in `codex-router.log` records text part count, character count, non-ASCII count, question mark count, replacement-character count, and a short hash before forwarding to Codex OAuth. It deliberately does not log prompt text.
- Regression tests added: `chat_request_preserves_chinese_through_codex_responses_conversion`, `chat_request_preserves_responses_style_text_parts`, `v1_chat_completions_preserves_chinese_for_profile_backend`, and `external_codex_unicode_stats_detects_chinese_without_prompt_leak`.

## 2026-06-16 CCSwitchMulti 3.16.2-20 GitHub release

- Published `https://github.com/BigStrongSun/cc-switch/releases/tag/v3.16.2-20` from target commit `b38e0649aeafce68e3c6b300bcb53c22b4edb413` after pushing `feat/codex-local-model-routing` to the fork.
- Uploaded 10 exact assets: Windows setup exe, setup signature, portable zip, raw exe, `CodexHistoryTool_3.16.2-20.zip`, `latest.json`, root `README.md`, Linux/macOS build notes, and `SHA256SUMS-v3.16.2-20.txt`.
- Do not upload the fixed export directory wholesale for this release line: `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\SHA256SUMS.txt` still includes old version residue such as earlier raw exes. Use the version-specific checksum file for release verification.
- Post-release verification passed: `gh release view v3.16.2-20` reported a non-draft, non-prerelease release with all 10 assets; `git ls-remote --tags fork v3.16.2-20` pointed at the target commit; downloaded release `latest.json` points updater clients at `v3.16.2-20/CCSwitchMulti_3.16.2-20_x64-setup.exe`.

## 2026-06-14 Subagent Visible Model Toolcall Test

- User requested subagent testing for all currently visible Codex models plus toolcall capability.
- Live Codex config at test time used `model_provider = "codex_model_router_v2"` with `model_catalog_json = "cc-switch-model-catalog.json"` and `[model_providers.codex_model_router_v2] base_url = "http://127.0.0.1:15721/v1"`, `wire_api = "responses"`.
- `~/.codex/cc-switch-model-catalog.json` exposed 7 list-visible API-supported slugs with parallel tool calls enabled: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `qwen3.6`, `deepseek-v4-flash`, `deepseek-v4-pro`.
- Subagent + shell toolcall passed for `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `deepseek-v4-flash`, and `deepseek-v4-pro`. Each successful worker ran safe read-only PowerShell checks such as `Get-Location`, `Get-Date`, and `Get-ChildItem`.
- `gpt-5.3-codex-spark` could be spawned but both attempts ended with `You've hit your usage limit. Try again later.`, so model availability/toolcall could not be verified in this run.
- `qwen3.6` first completed with an empty final status, then the explicit retry failed with `unexpected status 502 Bad Gateway` while handling `/responses`; CCSwitch logs showed routing was correct (`route_id=qwen-local`, upstream `https://www.matrixminecraft.cn:24443/vllm/v1/chat/completions`) but the Qwen upstream returned 502 with `<urlopen_error_[Errno_111]_Connection_refused>`. Direct probes to `https://www.matrixminecraft.cn:24443/vllm/v1/models` and `/chat/completions` also returned 502, so the failure boundary is the Qwen vLLM upstream, not local model-catalog visibility or subagent shell toolcall permissions.
- Local router process remained running during the test: PID `46200`, path `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\windows\raw-exe\CCSwitchMulti_3.16.2-14_x64.exe`, listening on `0.0.0.0:15721`.
- Do not treat unauthenticated `GET http://127.0.0.1:15721/v1/models` returning 401 as proof of model failure; this endpoint requires auth in the current router path.

## 2026-06-14 Codex Desktop Three-Model Runtime Snapshot

- Re-focused the 3-model picker report on the current running Codex Desktop state, not only on provider-id/history cleanup.
- Current live files are valid for MultiRouter: `~/.codex/config.toml` has `model_provider = "cc_switch_codex_router"`, top-level `model_catalog_json = "cc-switch-model-catalog.json"`, and `[model_providers.cc_switch_codex_router]` pointing at `http://127.0.0.1:15721/v1`; both `cc-switch-model-catalog.json` and `models_cache.json` contain the 7 expected slugs.
- A fresh Codex CLI process using the current `~/.codex/config.toml` (`codex debug models`) returns all 7 slugs, proving the generated catalog is parseable by Codex and the model fields are not filtered out by `visibility` / `supported_in_api`.
- The current thread tool description is not reliable proof of a 3-model Desktop picker: Codex hard-caps `spawn_agent` model override descriptions at 5 entries (`MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT_DESCRIPTION = 5`), so DeepSeek can be omitted there even when the static catalog contains it. Use Desktop `model/list` / visible picker evidence for the UI claim.
- Current DB state is valid for MultiRouter: `codex-openai-router` is current, its `modelCatalog` has the 7 expected slugs, and `codexRouting` has enabled OpenAI/Qwen/DeepSeek routes. `codex-router.log` shows real `route_resolved` / `upstream_status` attribution for OpenAI, Qwen, and DeepSeek routes in prior/current runs.
- Codex app-server `model/list` is served from `supported_models(thread_manager)`, and `ThreadManager::new` builds a shared `models_manager` once from the startup `Config`. Later config/catalog writes do not automatically rebuild this manager. If the visible Desktop picker still shows only 3 while fresh `codex debug models` returns 7, the remaining root-cause boundary is the running Desktop app-server/UI model-list snapshot or UI cache, not CCSwitch catalog generation or route configuration.

## 2026-06-13 Codex MultiRouter Stable Bucket Reconciliation

- Re-checked the 3-model Codex Desktop picker issue after the 3.16.2-5 build.
- Live `~/.codex/config.toml` was already in MultiRouter takeover form with top-level `model_catalog_json = "cc-switch-model-catalog.json"`, `base_url = "http://127.0.0.1:15721/v1"`, `wire_api = "responses"`, `requires_openai_auth = false`, and `supports_websockets = false`.
- Live `cc-switch-model-catalog.json` and `models_cache.json` both contained the 7 expected slugs: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `qwen3.6`, `deepseek-v4-flash`, and `deepseek-v4-pro`.
- Codex source archaeology showed `model_catalog_json` is the actual model candidate source; arbitrary non-reserved provider ids do not unlock the picker. Thread/history listing does use the current `model_provider` as its default provider bucket, so changing the MultiRouter id can hide historical sessions.
- Decision: keep `codex_model_router_v2` as the stable runtime MultiRouter provider id, while keeping `cc_switch_codex_router` in legacy/history source lists so older sessions can still migrate. Do not switch back to built-in `openai + openai_base_url` for MultiRouter unless a separate Codex source-level proof requires it.
- Runtime DB note: `codex-openai-router.settings_config.config` may still carry the old `model_provider = "openai"` plus `openai_base_url` persisted shape, but takeover code normalizes it to the stable local provider table. Future cleanup can normalize the stored provider config too, but the live candidate source is the generated catalog pointer.

## 2026-06-13 Codex MultiRouter Candidate Bucket Fix

- User reported the current CCSwitchMulti build still showed only three OpenAI candidates in Codex Desktop, while the older 2026-06-08 CCSwitchMulti build showed the full MultiRouter list.
- Code/DB archaeology:
  - 2026-06-08 working backups used `model_provider = "cc_switch_codex_router"` plus top-level `model_catalog_json = "cc-switch-model-catalog.json"` and `[model_providers.cc_switch_codex_router]`.
  - The working path was the static Codex `model_catalog_json` file with 7 router model slugs, not `models_cache.json` alone and not the later `openai + openai_base_url` experiment.
  - The current local DB had drifted to `model_provider = "openai"` with `openai_base_url = "http://127.0.0.1:15721/v1"` in `codex-openai-router.settings_config.config`, which risks pushing the picker back into Codex's built-in OpenAI provider semantics.
- Fix:
  - `src-tauri/src/codex_config.rs` now sets `CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID` to `cc_switch_codex_router`.
  - `src-tauri/src/services/proxy.rs` keeps normal third-party Codex providers on `custom`, but MultiRouter takeover writes the 2026-06-08 router bucket, removes `openai_base_url`, and keeps `supports_websockets = false`.
  - `src-tauri/src/codex_history_migration.rs` treats `cc_switch_codex_router` as a known router/openai-history source so history sync does not split buckets.
  - `src-tauri/src/services/provider/mod.rs` regression test now starts from the drifted `openai + openai_base_url` persisted config and asserts the live config is normalized to `cc_switch_codex_router` with 7 catalog/cache models.
- Verification passed:
  - `cargo test --manifest-path src-tauri\Cargo.toml switching_codex_router_provider_auto_enables_dedicated_local_takeover --lib -- --nocapture`
  - `cargo test --manifest-path src-tauri\Cargo.toml history --lib`
  - `cargo test --manifest-path src-tauri\Cargo.toml --lib codex`
  - `cargo fmt --manifest-path src-tauri\Cargo.toml --check`
  - `cargo check --manifest-path src-tauri\Cargo.toml` (only pre-existing warnings in `commands/misc.rs`)

## 2026-06-11 Codex Windows App Upgrade Strategy

- User reported Codex CLI update failure from the CC Switch settings page: current `0.137.0`, latest `0.139.0`, toast stack included `aws_lc_0_39_0_jent_entropy_switch_notime...`.
- Local diagnosis:
  - Default `codex` resolves to `C:\Users\sunda\AppData\Local\OpenAI\Codex\bin\codex.exe`.
  - Another Codex executable exists under `C:\Program Files\WindowsApps\OpenAI.Codex_26.608.1337.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`.
  - `codex --version` is `codex-cli 0.137.0`.
  - `codex update` says it cannot detect the installation method.
  - `npm view @openai/codex version` is `0.139.0`, but `winget upgrade --id 9PLM9XGG6VKS --source msstore` reports no available Store upgrade.
- Root cause: the previous Windows lifecycle updater treated Codex App/MSIX launcher paths as ordinary system/npm installs and could build `codex update || npm i -g @openai/codex@latest`, mixing the Codex App runtime with the user's WinGet Node/npm.
- Fix in `src-tauri/src/commands/misc.rs`:
  - Classify `AppData\Local\OpenAI\Codex`, `WindowsApps\OpenAI.Codex_...`, and `Microsoft\WindowsApps\codex.exe` paths as `codex-app`.
  - For Codex App/MSIX installs, generate a Store package update command with `winget upgrade --id 9PLM9XGG6VKS --source msstore --accept-source-agreements --accept-package-agreements`.
  - Do not attach npm fallback for this install source.
  - If multiple Codex entries are detected and no default install can be selected, any Codex App/MSIX entry forces the Store update command instead of the static `codex update || npm ...` fallback.
- Regression coverage:
  - `codex_windows_app_uses_ms_store_upgrade_without_npm_fallback`.
  - `ambiguous_codex_app_install_uses_ms_store_upgrade`.
  - `windows_codex_app_is_identified`.
  - Validation passed: `cargo test --manifest-path src-tauri\Cargo.toml anchored_upgrade_windows --lib`, `cargo test --manifest-path src-tauri\Cargo.toml install_source_classification --lib`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, `cargo check --manifest-path src-tauri\Cargo.toml`.

## 2026-06-08 Router UI/Save Logic Fix

- Latest user symptom: after launching the portable build and selecting `OpenAI Multi-Model Router`, Codex Desktop still only showed OpenAI/GPT candidates and lost `gpt-5.3-codex-spark`, DeepSeek, and Qwen. The CC Switch list also showed `OpenAI Multi-Model Router` with the `不支持路由` badge.
- Multi-agent assessment: this was a narrow local state + UI/save-path diagnosis, so the main agent handled it directly instead of spawning subagents. Verification was done through process checks, DB inspection, typecheck, and packaging.
- Live process check:
  - Running process was PID `48844`, started `2026-06-08 20:39:21`.
  - Path: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503\release\bundle\portable\cc-switch.exe`.
  - This was the earlier 17:34 router-candidate portable, not the newer UI/save-logic fixed build below.
- Local DB hotfix:
  - Backup directory: `C:\Users\sunda\.cc-switch\backups\codex-router-category-fix-20260608_205059`.
  - `codex-openai-router.category` was corrected from `official` to `aggregator`.
  - Current provider was left as `codex-official`; no runtime switch away from the user's backup/official line was performed.
- Current Codex config check:
  - `C:\Users\sunda\.codex\config.toml` currently has no `model_provider`, `model_catalog_json`, local `base_url`, or `127.0.0.1` router/proxy lines, so Codex Desktop is still effectively on the backup/official config.
  - `C:\Users\sunda\.codex\cc-switch-model-catalog.json` exists and contains 7 model slugs: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `qwen3.6`.
  - Therefore a missing CodexSpark/DeepSeek/Qwen dropdown after this state means the router takeover was not active, not that the catalog file was absent.
- Root causes:
  - `src/components/providers/ProviderCard.tsx` treated every Codex `official` category provider as `不支持路由`, even when `settings_config.codexRouting` existed. A router provider with official OAuth routes must still be treated as proxy-routed.
  - `src/hooks/useProviderActions.ts` only required the proxy for non-official providers. A Codex router with `codexRouting` now also requires the local proxy even when route auth uses managed official OAuth.
  - `src/components/providers/forms/ProviderForm.tsx` skipped `modelCatalog` and `codexRouting` persistence for category `official`, and only saved the model catalog for `openai_chat`. The router's outer API is `openai_responses`, so editing/saving it could wipe the generated catalog and routes.
- Code fix:
  - `ProviderCard.tsx` now detects `settings_config.codexRouting`, marks such Codex providers as needing routing, and suppresses the false `不支持路由` badge.
  - `useProviderActions.ts` now treats Codex router providers as local-proxy-required providers and allows them during proxy takeover.
  - `ProviderForm.tsx` now preserves `modelCatalog` and `codexRouting` when routing is enabled or routes exist, including router providers whose outer API format is `openai_responses`.
- Verification:
  - `pnpm typecheck` passed.
  - `pnpm tauri build --bundles nsis --config "$env:TEMP\cc-switch-tauri-no-updater.json"` passed.
- Latest UI/save-logic fixed artifacts:
  - Portable exe: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-ui-fix-20260608_210732\release\bundle\portable\cc-switch.exe`
    - SHA256 `4D3E0A7EC297901CEEAB972B3B70018521F0052077AEB6062F4468BE2B6F036A`
  - Portable zip: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-ui-fix-20260608_210732\release\bundle\portable\CC Switch_3.16.1_x64-portable.zip`
    - SHA256 `1D7338E7F137D5CA1888F3A966F8877DA26CB8F3CEE8A87324075F0EE53CDAC7`
  - NSIS installer: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503\release\bundle\nsis\CC Switch_3.16.1_x64-setup.exe`
    - SHA256 `A1194B9A55BB2478BA182FAB1A6C7FF9AACA6DEED450A4A4662947099D5C298A`
- Architecture clarification:
  - `OpenAI Multi-Model Router` is not merely upstream CC Switch's native provider switcher, and it is not an external script. It depends on the local Codex multi-model routing patch now present in this repo.
  - Native CC Switch routing/proxy takeover can redirect Codex to one selected provider, but by itself it does not create a single Codex Desktop model dropdown containing OpenAI, CodexSpark, DeepSeek, and Qwen candidates.
  - The patched path has three required layers: `settings_config.modelCatalog` projects `~/.codex/cc-switch-model-catalog.json` so Codex can display all candidates; `settings_config.codexRouting` stores model-to-upstream routes; the Rust local proxy resolves the request `model` via `resolve_codex_model_routed_provider` and converts Responses to Chat where needed.
  - Therefore the multi-model dropdown requires CC Switch local proxy/takeover plus the patched `modelCatalog`/`codexRouting` implementation. Switching ordinary providers alone is not enough.

## 2026-06-08 Router Candidate/Timeout Fix Package

- Root cause found in the local user DB:
  - `codex-openai-router.settings_config.modelCatalog.models` only contained 4 OpenAI models, so Codex candidate model UI could not show DeepSeek/Qwen.
  - `codex-openai-router.settings_config.codexRouting` was missing, so even a selected DeepSeek/Qwen model would not have a route.
  - Code gap: `src-tauri/src/services/provider/live.rs::restore_live_settings_for_provider_backfill` preserved DB-only `modelCatalog` but not DB-only `codexRouting`; switch-away backfill from Live could wipe the router route table because Live `config.toml` cannot represent it.
- Code fix:
  - `src-tauri/src/services/provider/live.rs` now preserves both `modelCatalog` and `codexRouting` during Codex backfill.
  - Regression test added: `codex_switch_backfill_preserves_stored_codex_routing_when_live_lacks_it`.
- Local DB fix:
  - Backup: `C:\Users\sunda\.cc-switch\backups\codex-router-multimodel-fix-20260608_172503\cc-switch.db.before`.
  - Current provider was left as `codex-official`; no official/backup runtime switch was performed.
  - Router catalog models now include `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `qwen3.6`.
  - Router routes:
    - `openai-official`: `gpt-*` -> `https://chatgpt.com/backend-api/codex`, `openai_responses`, `managed_codex_oauth`.
    - `deepseek`: `deepseek-*` -> `https://api.deepseek.com`, `openai_chat`. DeepSeek key is currently empty, so the candidate appears but requests need a key before success.
    - `qwen-local`: `qwen3.6` -> `https://www.matrixminecraft.cn:24443/vllm/v1`, `openai_chat`, `apiKey=vllm-local`.
- Verification:
  - `cargo test codex_switch_backfill --manifest-path src-tauri\Cargo.toml`
  - `cargo test codex_route --manifest-path src-tauri\Cargo.toml`
  - `cargo fmt --manifest-path src-tauri\Cargo.toml --check`
  - `pnpm typecheck`
  - Qwen upstream `/v1/models` returned `qwen3.6`.
- Latest artifacts were built into an isolated target to avoid overwriting the currently running old portable instance:
  - Target dir: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503`.
  - Portable zip: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503\release\bundle\portable\CC Switch_3.16.1_x64-portable.zip`
    - SHA256 `41D9FA3DB194F299F79772E5BABFF72D79AE9262332DD98142E90DDE802BCFDB`
  - Portable exe: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503\release\bundle\portable\cc-switch.exe`
    - SHA256 `9D921B3122CB8FE436974F10DF8BAF1ABF2628812D66E12A7A3A7070727B9B26`
  - NSIS installer: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503\release\bundle\nsis\CC Switch_3.16.1_x64-setup.exe`
    - SHA256 `EC9936E4987985ABA8A2B066831AE1D853FD1BF972FE32CE38590615622FA146`
  - MSI: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target-router-fix-20260608_172503\release\bundle\msi\CC Switch_3.16.1_x64_en-US.msi`
    - SHA256 `38D4E2F7AAC10F27801E5BBDAEFB8B7DB6AE3D33658020DE27ACFA2E155C32D8`
- Packaging note:
  - `pnpm tauri build` produced the release exe, NSIS, and MSI but exited 1 at updater artifact signing because `TAURI_SIGNING_PRIVATE_KEY` is not set. The portable zip was manually generated from the new release exe, matching the existing local portable maintenance pattern.
  - To test the new portable build, close the old local modified CC Switch window first; the single-instance plugin can otherwise bring the old process to front. Codex official does not need to be stopped.

## 2026-06-08 DeepSeek Key Local Configuration

- User provided a DeepSeek key and asked to configure it locally. Do not commit or document the full key; only use masked form `sk-b931...b870` in notes.
- Backup directory before the write: `C:\Users\sunda\.cc-switch\backups\codex-deepseek-key-20260608_203307`.
- Updated local DB fields:
  - `codex-deepseek.settings_config.auth.OPENAI_API_KEY`.
  - `codex-openai-router.settings_config.auth.OPENAI_API_KEY`.
  - `codex-openai-router.settings_config.codexRouting.routes[id=deepseek].upstream.apiKey`.
- Current provider was left as `codex-official`; no switch/takeover was performed.
- Lightweight verification against `https://api.deepseek.com/v1/models` succeeded and returned `deepseek-v4-flash` and `deepseek-v4-pro`.

## 2026-06-08 Packaging And Maintenance

- Current local build artifacts:
  - NSIS installer: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target\release\bundle\nsis\CC Switch_3.16.1_x64-setup.exe`
  - Portable zip: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target\release\bundle\portable\CC Switch_3.16.1_x64-portable.zip`
  - Portable exe: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target\release\bundle\portable\cc-switch.exe`
  - Raw release exe: `C:\Users\sunda\Documents\LLMservice\cc-switch\src-tauri\target\release\cc-switch.exe`
- Local verification before packaging:
  - `pnpm run typecheck`
  - `cargo test codex --lib` from `src-tauri`
- Recommended local packaging command:
  - Create temp config `C:\Users\sunda\AppData\Local\Temp\cc-switch-tauri-no-updater.json` with `{"bundle":{"createUpdaterArtifacts":false}}`.
  - Run `pnpm tauri build --bundles nsis --config "$env:TEMP\cc-switch-tauri-no-updater.json"`.
- Do not use plain `pnpm run build` as the final local handoff command unless `TAURI_SIGNING_PRIVATE_KEY` is available and MSI/WiX is intentionally required.
  - Current `tauri.conf.json` has updater public key plus `createUpdaterArtifacts=true`, so local builds without a private key fail after bundle generation.
  - Full target builds also invoke MSI/WiX; `light.exe` has previously made the command exit 1 even when `cc-switch.exe` and installer files were produced.
  - Treat the NSIS no-updater command above as the reliable local packaging path.
- Portable package maintenance:
  - Copy `src-tauri\target\release\cc-switch.exe` to `src-tauri\target\release\bundle\portable\cc-switch.exe`.
  - Zip only that exe into `CC Switch_3.16.1_x64-portable.zip`.
  - Portable and installed builds share user data in `~/.cc-switch` and `~/.codex`; do not run them concurrently with the official production app.
- Official production app safety:
  - Do not stop or restart the installed official process during local diagnosis/build work.
  - Last verified official process path: `C:\Users\sunda\AppData\Local\Programs\CC Switch\cc-switch.exe`.

## 2026-06-08 Local Codex Provider Cleanup

- User restored historical `~/.cc-switch` config and explicitly said future cleanup must not use that DB content as a template.
- Canonical Codex provider writes should follow latest repo schema:
  - Pure official fallback: `codex-official`, `settings_config={"auth":{},"config":""}`, no `model_provider`, no `base_url`, no `model_catalog_json`, no `codexRouting`.
  - New router providers must use `settings_config.codexRouting`; legacy `codexModelRoutes` / `modelRoutes` are read-only compatibility paths.
  - `meta.apiFormat` and route `upstream.apiFormat` are the explicit API-format source for proxy conversion.
  - Chat-compatible DeepSeek/Qwen providers should use `meta.apiFormat="openai_chat"` and TOML `wire_api="chat"`.
  - Do not put router TOML, `model_catalog_json`, or `127.0.0.1:15721/15722` into `settings.common_config_codex`.
- Local machine cleanup performed 2026-06-08 15:10:
  - Kept only `codex-official`, `codex-openai-router`, `codex-qwen-local`, and `codex-deepseek`.
  - Set `currentProviderCodex="codex-official"`, `enableLocalProxy=false`, cleared `common_config_codex`, disabled Codex takeover flags, and removed Codex `proxy_live_backup`.
  - Backup path: `C:\Users\sunda\.cc-switch\backups\codex-clean-20260608_150944`.

## 2026-06-08 Codex Local Model Routing

### Product Direction Update

- User clarified that the main UI should be a separate Model Router workspace, not only an embedded route editor inside `CodexFormFields`.
- Desired flow: configure or import multiple model sources first, then select sources and merge them into one router provider that Codex reaches through CC Switch local proxy.
- Prototype artifacts:
  - `docs/prototypes/codex-router-workspace-prototype.html`
  - `docs/guides/codex-model-router-workspace-prototype.md`
- Existing `CodexFormFields` Local model routing editor should be treated as an advanced/generated-config surface unless the prototype review decides otherwise.
- Prototype v2 decision: the Model Router workspace must follow the existing CCSwitch header/AppSwitcher/provider-card style, not a generic SaaS dashboard or left-sidebar layout.
- Prototype v2 entry/exit rules: users can enter from the Codex Provider list, the Codex provider form, or Universal Provider; after publish they return to the Codex Provider list with the generated router provider highlighted.
- Prototype v2 source library rules: source setup must guide provider creation/import, base URL/auth/API format setup, connection test, model fetch, capability query, manual capability edit, and real route testing.
- Prototype v2 catalog rules: one provider/source may expose many upstream models, so UI must support fetched model lists and user-controlled visible models before writing Codex model catalog.
- Prototype v2 publish rule: route success must be tested through the CC Switch Rust local proxy before final publish; static config validation alone is not enough.
- Proposed UI component split for real implementation: `src/components/codex-router/ModelRouterWorkspace.tsx`, `RouterSourceLibrary.tsx`, `RouterSourceEditorDialog.tsx`, `RouterModelCatalogPanel.tsx`, `RouterSummaryPanel.tsx`, `RouteTestPanel.tsx`, and a draft/publish adapter.
- Prototype v3 visual correction: the static prototype must use CCSwitch's dark desktop-app style, wide 16:10 window proportions, top toolbar/app switcher, orange circular add button, blue active borders, and long horizontal provider cards.
- Prototype v3 information architecture: split the router workspace into multiple pages (`Overview`, `Sources`, `Models`, `Routes`, `Test & Publish`) using left-side step navigation; do not stack all router content into one vertical long page.

### Branch And Sync

- Feature branch: `feat/codex-local-model-routing`.
- Created from latest `origin/main` after stashing the old local WIP.
- Protective stash kept for now: `stash@{0}` named `wip-codex-local-routing-before-upstream-sync-20260608-005258`.
- Untracked `run-release-and-check.bat` existed after applying the stash; do not delete it unless the owner confirms it is disposable.

### Canonical Config

- New route config lives under `settings_config.codexRouting`.
- Shape:
  - `enabled`: enables/disables the resolver.
  - `defaultRouteId`: fallback route id when no exact/prefix rule matches.
  - `routes[]`: user-defined route list.
- Route fields:
  - `id`, `label`, `enabled`.
  - `match.models` for exact model ids.
  - `match.prefixes` for model id prefixes.
  - `upstream.baseUrl`.
  - `upstream.apiFormat`: `openai_responses`, `openai_chat`, or `openai_messages`.
  - `upstream.auth.source`: first version supports `provider_config`, `managed_codex_oauth`, and `managed_account`.
  - `upstream.apiKey` for provider-config key material when needed.
  - `upstream.modelMap` for Codex model id to upstream model id mapping.
  - `capabilities.textOnly`, `capabilities.inputModalities`, `capabilities.supportsReasoning`.
- Legacy fields `settings_config.codexModelRoutes` and `settings_config.modelRoutes` are read-only fallbacks. The UI may load them and save back to `codexRouting`.
- `reuse_provider:<id>` is intentionally not supported in the first version.

### Rust Entry Points

- Route resolver and effective provider construction:
  - `src-tauri/src/proxy/providers/codex.rs`
  - Main entry: `resolve_codex_model_routed_provider`.
  - Effective routed provider id format: `{outer_provider_id}::route::{route_id}`.
  - Managed Codex OAuth routes must remove inherited provider `auth` / `apiKey`; otherwise stale Bearer keys can override the managed account chain.
- Forwarding and protocol selection:
  - `src-tauri/src/proxy/forwarder.rs`
  - Reuses existing forwarder flow after route resolution.
  - Supports Responses passthrough, Responses -> Chat, and Responses -> Messages endpoint handling.
- Responses to Chat conversion:
  - `src-tauri/src/proxy/providers/transform_codex_chat.rs`
  - Text-only route capability prevents emitting Chat `image_url` blocks.
- Model catalog capability generation:
  - `src-tauri/src/codex_config.rs`
  - Route capabilities override hardcoded text-only model-name fallbacks.

### Frontend Entry Points

- Shared types:
  - `src/types.ts`
  - `CodexRoutingConfig`, `CodexRoutingRoute`, `CodexRoutingAuth`, `CodexRoutingCapabilities`.
- Codex config state:
  - `src/components/providers/forms/hooks/useCodexConfigState.ts`
  - Reads `codexRouting`; migrates `codexModelRoutes` / `modelRoutes` into UI state.
- Provider save path:
  - `src/components/providers/forms/ProviderForm.tsx`
  - Saves `settings_config.codexRouting` when routing is enabled or routes exist.
- Codex UI:
  - `src/components/providers/forms/CodexFormFields.tsx`
  - Adds **Local model routing** controls as a route summary list plus an edit dialog for match rules, upstream API format, auth, mapping, and capabilities.
  - The Local model routing panel is independent of endpoint speed-test visibility; it should show whenever the Codex form has routing state.
  - Switching a route from `provider_config` to a managed auth source should clear route `apiKey` so stale keys are not persisted.
- i18n keys live under `codexConfig` in:
  - `src/i18n/locales/en.json`
  - `src/i18n/locales/zh.json`
  - `src/i18n/locales/zh-TW.json`
  - `src/i18n/locales/ja.json`

### Docs

- Existing DeepSeek guide paths are now generic Codex Local Model Routing guides:
  - `docs/guides/codex-deepseek-routing-guide-en.md`
  - `docs/guides/codex-deepseek-routing-guide-zh.md`
  - `docs/guides/codex-deepseek-routing-guide-ja.md`
- The filenames still contain `deepseek` for link compatibility, but the content is generic and UTF-8.

### Validation Commands Used

- Rust focused validation:
  - `cargo fmt`
  - `cargo test codex --lib`
- Frontend type validation:
  - `pnpm run typecheck`
- Frontend route UI validation:
  - `pnpm vitest run tests/components/CodexFormFields.test.tsx tests/components/ProviderForm.codexCatalog.test.ts`
- Renderer build validation:
  - `pnpm run build:renderer`

### Maintenance Notes

- When fixing route bugs, update this file if the schema, resolver behavior, or capability semantics change.
- If text-only/image behavior changes, update both catalog generation and Responses -> Chat conversion tests.
- Keep Codex connected to the CC Switch Rust local proxy for this design; route selection should depend on `body.model`, not the GUI's currently selected upstream provider.

## 2026-06-08 Codex v2 DeepSeek v4 Local Proxy Fix

- Canonical user-facing model spelling for this workspace is `deepseekv4`, while configured aliases may include `deepseek-v4-pro`, `deepseek-v4-flash`, or display names such as `DeepSeek V4 Pro`.
- The intended Codex path is still v2 through the CC Switch Rust local proxy: Codex sends `/responses` to `http://127.0.0.1:<proxy>/v1`, CC Switch selects a route, then translates to the route upstream format when needed.
- The DeepSeek v4 failure was not caused by the old user script. It came from the built-in Rust Responses -> Chat conversion emitting Chat `content[]` image blocks for a text-only upstream. DeepSeek rejected this with `unknown variant image_url, expected text`.
- Text-only detection for DeepSeek v4 must use compact model-id normalization so `deepseekv4`, `deepseek-v4-*`, and spaced display aliases are all treated the same.
- Keep DeepSeek v4 text-only behavior aligned across `src-tauri/src/proxy/providers/transform_codex_chat.rs`, `src-tauri/src/codex_config.rs`, and `src-tauri/src/proxy/media_sanitizer.rs`.
- GUI route creation should not persist default `capabilities: { textOnly:false, inputModalities:["text","image"], supportsReasoning:false }` for new routes, because that can create a false explicit image-capability override.
- Route-level `codexChatReasoning.minOutputTokens` is supported for Chat upstreams that need a larger minimum output budget to avoid reasoning consuming tiny Codex probe responses.
- Validation commands used for this fix: `cargo fmt`, `cargo test transform_codex_chat --lib`, `cargo test media_sanitizer --lib`, `cargo test codex_model_catalog --lib`, `cargo test codex --lib`, and `node node_modules\typescript\bin\tsc --noEmit`.

## 2026-06-08 Codex Multi-Model Router Detail Fix

- The working router provider is the patched CC Switch Rust local proxy path, not native provider switching alone. Codex connects to CC Switch, the proxy reads `body.model`, resolves `settings_config.codexRouting`, and forwards to OpenAI official, DeepSeek, or Qwen.
- Stable Codex history bucket for this local router is `codex_model_router_v2`. Avoid reintroducing `cc_switch_codex_router`; it splits Codex Desktop history into another provider bucket. On this machine, old `codex_model_router` rows were merged into `codex_model_router_v2` with backup at `%USERPROFILE%\.codex\backups\router-provider-v2-merge-20260608_225952`.
- Router provider DB config currently uses `model_provider = "codex_model_router_v2"` with `[model_providers.codex_model_router_v2] base_url = "http://127.0.0.1:15721/v1"` and `wire_api = "responses"`.
- Route/candidate catalog currently exposes 7 models: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `qwen3.6`.
- `src-tauri/src/codex_config.rs` must preserve `additional_speed_tiers` and `service_tiers` for OpenAI official `gpt-*` entries, except `codex-spark`; third-party/local models should still clear these fields so the UI does not show official service tiers on DeepSeek/Qwen.
- Existing on-disk catalog was manually refreshed after the code fix; old file backup is `%USERPROFILE%\.codex\backups\catalog-speed-tiers-20260608_231320`.
- `src-tauri/src/proxy/codex_router_log.rs` writes compact diagnostics to `%USERPROFILE%\.cc-switch\logs\codex-router.log`. It logs route, auth, request preparation, upstream send/status/error, and response readiness by trace id without raw prompt, token, header, or SSE content.
- `src-tauri/src/lib.rs` should not delete `%USERPROFILE%\.cc-switch\logs\cc-switch.log` on startup; early router cutover errors must survive restart.
- Avoid raw request/SSE logs in normal Debug/Trace. `forwarder.rs` should log request bytes plus body hash; `response_processor.rs` should only parse SSE when usage collection requires it.

## 2026-06-09 CCSwitchMulti Config Preservation And Packaging

- Current local modified build is branded `CCSwitchMulti` to distinguish it from the official `CC Switch` binary. The app still uses the existing `.cc-switch` data directory so provider DB/config history remains shared; do not rename the config directory unless deliberately doing a clean-room install.
- Package identity for the modified installer is `com.ccswitchmulti.desktop`; deep-link scheme is `ccswitchmulti`. This prevents the local installer from being treated as the same app identity as official `com.ccswitch.desktop`.
- MSI packaging rejects prerelease ids like `multi.1`; use numeric prerelease `3.16.1-1` for this local build line. The visible distinction comes from `productName = "CCSwitchMulti"` plus the numeric local build suffix.
- Current delivery directory: `src-tauri/target-ccswitchmulti-20260609_001033/`.
  - Portable zip: `CCSwitchMulti_3.16.1-1_x64-portable.zip`.
  - Portable exe: `CCSwitchMulti.exe`.
  - NSIS installer: `CCSwitchMulti_3.16.1-1_x64-setup.exe`.
  - MSI installer: `CCSwitchMulti_3.16.1-1_x64_en-US.msi` copied from `src-tauri/target/release/wix/x64/output.msi` after Tauri's MSI final copy failed.
- Build cleanup on 2026-06-09 removed stale local modified targets `src-tauri/target-router-fix-20260608_172503`, `src-tauri/target-router-ui-fix-20260608_210732`, and `src-tauri/target-router-detail-fix-20260608_230505`, the default build cache `src-tauri/target`, and the old root release artifacts `cc-switch-release` / `cc-switch-release.zip`. A stale portable process from `target-router-detail-fix-20260608_230505` had to be stopped to unlock that old directory; the official backup instance was not stopped.
- After cleanup, only `src-tauri/target-ccswitchmulti-20260609_001033` should be used for current delivery artifacts. Do not hand users any old `target-router-*`, default `target`, or root `cc-switch-release*` artifact paths.
- In this environment `pnpm` may be absent from PATH, while local `node_modules` exists. `tauri.conf.json` now uses `node ./node_modules/vite/bin/vite.js build` for `beforeBuildCommand`; frontend validation can use `.\node_modules\.bin\tsc.CMD --noEmit`.
- Tauri NSIS bundling can return exit code 1 after successfully producing setup.exe when updater signing has a public key but no `TAURI_SIGNING_PRIVATE_KEY`. Treat the generated setup file as usable if it exists and hashes cleanly; record this caveat in handoff.
- Codex history reality on this machine: `state_5.sqlite` had 445 threads during the 2026-06-09 check, with 432 under `codex_model_router_v2` and only 13 under `openai`. Full history is not mostly in `openai`.
- Codex `thread/list` defaults to filtering by current `model_provider` when `modelProviders` is omitted. Passing `modelProviders: []` means no provider filter. Optional `cwd` filters are exact-path filters and can make history appear limited to the current workspaces.
- Do not create another router provider id. Keep router provider config at `model_provider = "codex_model_router_v2"` so the Codex Desktop history bucket stays stable.
- Provider switching must never write provider `config.toml` snapshots verbatim over the current live Codex config. `src-tauri/src/codex_config.rs` now merges provider config with live config: provider top-level scalar fields and `[model_providers.<active-id>]` override, while live `[features]`, `[desktop]`, `[memories]`, `[projects]`, `[mcp_servers]`, plugins, and other user tables are preserved.
- Common config snippets still need to add missing table entries. The merge behavior is "live wins on conflicts, provider/common config fills missing table keys." This preserves user MCP entries while allowing CC Switch common config to add new MCP servers.
- Proxy takeover placeholder branches in `src-tauri/src/services/proxy.rs` must also merge before `write_codex_live_config_atomic`; otherwise switching router during takeover can clear context-window display, memories, MCP, and project trust.
- Validation for this fix used `.\node_modules\.bin\tsc.CMD --noEmit` and `cargo test codex --lib` (318 passed).

## 2026-06-09 CCSwitchMulti History Visibility And Router Preservation Fix

- Live official state after the 2026-06-09 01:20 check: `codex-official` is current in `~/.cc-switch/cc-switch.db`, `currentProviderCodex` is `codex-official`, Codex proxy flags are disabled, and `~/.codex/config.toml` has no local router/proxy lines. If the UI still feels like it did not switch back, first distinguish live config from Codex history filtering.
- Runtime DB repair restored `codex-openai-router.settings_config.codexRouting` with three routes:
  - `openai-official`: `gpt-*` via `https://chatgpt.com/backend-api/codex`, `openai_responses`, `managed_codex_oauth`.
  - `deepseek`: `deepseek-v4-flash` / `deepseek-v4-pro` via `https://api.deepseek.com`, `openai_chat`, provider_config key.
  - `qwen-local`: `qwen3.6` via `https://www.matrixminecraft.cn:24443/vllm/v1`, `openai_chat`, `minOutputTokens=2048`.
- Backup before runtime repair: `%USERPROFILE%\.cc-switch\backups\codex-history-official-router-fix-20260609_012627`.
- `src/components/providers/EditProviderDialog.tsx` now preserves both DB-private Codex fields, `modelCatalog` and `codexRouting`, when editing the current provider after reading live settings. This prevents saving a current router provider from erasing its route table.
- `src-tauri/src/codex_config.rs` now preserves OpenAI speed/service tiers only for `gpt-5.5` and `gpt-5.4`. `gpt-5.4-mini`, `gpt-5.3-codex-spark`, DeepSeek, Qwen, and other generated catalog entries must have empty `additional_speed_tiers` and `service_tiers`.
- Current on-disk `~/.codex/cc-switch-model-catalog.json` was repaired to match that rule: `gpt-5.5` and `gpt-5.4` keep `fast/priority`; mini, spark, DeepSeek, and Qwen have no service tiers.
- History visibility analysis from the read-only subagent:
  - `state_5.sqlite` has 448 threads. `session_index.jsonl` has 426 unique ids; sqlite has 24 ids not in the jsonl index and jsonl has 2 ids not in sqlite.
  - Provider buckets: `codex_model_router_v2=433`, `openai=15`.
  - Source buckets: `vscode=223`, `exec=26`, `subagent=199`; archived threads total 142.
  - Visible history is mostly a view/filtering problem, not data loss. Default `thread/list` behavior filters by active provider when `modelProviders` is omitted, hides non-interactive sources when `sourceKinds` is omitted/empty, excludes archived items, applies exact `cwd` filters, and paginates.
  - To surface hidden history safely, prefer fixing the query/view: pass `modelProviders: []`, include non-interactive `sourceKinds`, avoid default exact `cwd`, expose archived separately, and page through `nextCursor`. Do not rewrite sqlite buckets just to make old sessions visible.
- Latest packaged delivery for this fix:
  - Directory: `src-tauri/target-ccswitchmulti-historyfix-20260609_013447/`.
  - Portable exe: `CCSwitchMulti.exe` SHA256 `909933223A40D6AECA5396F3D1B2A2104C22ECD86EF68DB7DF5B493B1D1DD65F`.
  - Portable zip: `CCSwitchMulti_3.16.1-1_x64-portable.zip` SHA256 `8985C3F5B5C8D5C54C8DA70E4B3D5D1E444C25454794D9DDD7B959FCDD4111FA`.
  - NSIS installer: `CCSwitchMulti_3.16.1-1_x64-setup.exe` SHA256 `3E7C668881D7B7E0EB61F8D754D95971A59046FA6C7EB8C07260B3E11CB2D3CE`.
  - MSI installer: `CCSwitchMulti_3.16.1-1_x64_en-US.msi` SHA256 `D15EAC130332CA0717001630E334C32D2FB9895A14BE47D23866612908906DE7`.
- Validation: `vitest` for `EditProviderDialog` and `CodexFormFields` passed 5 tests; `cargo test codex_model_catalog --lib` passed 5 tests; `.\node_modules\.bin\tsc.CMD --noEmit`, `cargo fmt --check`, and `cargo test codex --lib` passed 319 tests; Tauri no-updater build succeeded.
- The older `src-tauri/target-ccswitchmulti-20260609_001033/CCSwitchMulti.exe` was still running during packaging. Do not delete that old directory until the old process is closed or replaced by the new build.

## 2026-06-09 CCSwitchMulti Rootfix For Codex Official Fallback And Router Pollution

- Supersedes the previous history-bucket assumption: `codex_model_router_v2` is not a universal fix for history visibility. It only described one old local router bucket. Do not rewrite sqlite/jsonl buckets as the default fix for missing history.
- Do not treat the user's current official/default state as proof that the modified build works. The user had to roll back to official release/default config to keep chatting.
- Confirmed root causes:
  - `CodexAdapter::extract_base_url` previously scanned for the first `base_url` string in TOML, so inactive `[model_providers.*]` and `[mcp_servers.*]` entries could contaminate the active provider.
  - Provider/live merge kept stale provider-owned fields. Official fallback with empty config could retain old `model_provider`, `model_catalog_json`, `experimental_bearer_token`, or old `[model_providers.<router>]`, leaving DeepSeek/Qwen candidates visible after switching backup official.
  - Codex common config could deep-merge provider-private router TOML into arbitrary providers.
  - Proxy takeover official switching needed to exit takeover and restore/write live official config instead of trying to hot-switch through the local proxy.
  - The old `preserve_codex_mcp_servers_from_existing_config` path only preserved MCP servers, not full Codex user sections like `[projects]`, `[features]`, `[desktop]`, `[memories]`.
- Implemented fixes:
  - `src-tauri/src/proxy/providers/codex.rs`: base URL extraction uses `crate::codex_config::extract_codex_base_url`, which prefers the active `model_provider`.
  - `src-tauri/src/services/provider/mod.rs`: Codex credential extraction uses the same active TOML parser; switching an official provider during takeover calls `disable_takeover_for_app_after_switch_lock`, sets current provider, writes official live config, and syncs MCP.
  - `src-tauri/src/codex_config.rs`: official empty config now clears provider-owned top-level fields, removes CC Switch-owned `model_catalog_json`, and removes the active custom `[model_providers.<id>]` table while preserving user sections.
  - `src-tauri/src/services/provider/live.rs`: Codex common config strips `model`, `model_provider`, `model_context_window`, `model_catalog_json`, `experimental_bearer_token`, and `[model_providers]`.
  - `src-tauri/src/services/proxy.rs`: backup/live preservation now uses full Codex provider/live merge rather than MCP-only merge. Added regression test for router takeover -> official fallback cleanup.
- Validation commands passed:
  - `.\node_modules\.bin\tsc.CMD --noEmit`
  - `cargo test codex_switch_to_official_during_takeover_exits_proxy_and_cleans_router_fields --lib`
  - `cargo test test_extract_base_url_uses_active_model_provider_only --lib`
  - `cargo test codex_config --lib` (46 passed)
  - `cargo test codex_common_config --lib` (6 passed)
  - `cargo test provider_switch_with_restored_codex_backup_refreshes_catalog_and_common_config --lib`
  - `cargo test codex_restore_from_backup_projects_inline_model_catalog --lib`
  - `.\node_modules\.bin\tauri.CMD build --no-bundle`
- Latest delivery artifacts:
  - Directory: `src-tauri/target-ccswitchmulti-rootfix-20260609_032709/`
  - `CCSwitchMulti.exe` SHA256 `D764449F06FEEEA7FED052693AB55EE26200C2609B1001DBD56EE993F4186123`
  - `CCSwitchMulti_3.16.1-1_x64-rootfix-portable.zip` SHA256 `46BB69EB96FD811B945152EC2672C6220E0FC545DE47AD6326CE69E8C31C5AB9`
  - `CCSwitchMulti_3.16.1-1_x64-setup.exe` SHA256 `73F7E05581E35278936420CF5F5E13229A383D08F26FB960E689336395B67635`
  - `CCSwitchMulti_3.16.1-1_x64_en-US.msi` SHA256 `9E093D8C493E52337DD1811B8081A8187372C17CF384AC605C7EE4BA0DCFB132`
- Packaging notes:
  - Full `tauri build` produced NSIS/MSI but returned 1 because updater signing has a public key and no `TAURI_SIGNING_PRIVATE_KEY`; use `tauri build --no-bundle` to verify portable exe without signing.
  - Old timestamp package dirs `target-ccswitchmulti-20260609_001033` and `target-ccswitchmulti-historyfix-20260609_013447` were removed after creating the rootfix package. Only the rootfix directory should be handed out now.
  - The current running official app remained `C:\Users\sunda\AppData\Local\Programs\CC Switch\cc-switch.exe`; this rootfix pass did not stop it and did not mutate live `%USERPROFILE%\.cc-switch` or `%USERPROFILE%\.codex` config.

## 2026-06-09 Rootfix DB Provider Write

- After packaging rootfix, the current `%USERPROFILE%\.cc-switch\cc-switch.db` still only had `codex-official` and stale `default`; the package fix alone did not write the user's Codex provider config.
- DB backup before writing: `%USERPROFILE%\.cc-switch\backups\db_backup_before_codex_rootfix_config_20260609_145601.db`.
- Current Codex provider set written to DB:
  - `codex-official` / `OpenAI Official Backup`: official fallback, current provider, empty config/auth.
  - `codex-openai-router` / `OpenAI Multi-Model Router`: local proxy provider with `model_provider="codex_model_router_v2"`, base URL `http://127.0.0.1:15721/v1`, catalog models `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `qwen3.6`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `codexRouting` routes `openai-official`, `qwen-local`, `deepseek`.
  - `codex-qwen-local` / `Qwen Local vLLM`: direct optional provider for `qwen3.6`, base URL `https://www.matrixminecraft.cn:24443/vllm/v1`, Chat upstream metadata.
  - `codex-deepseek` / `DeepSeek`: direct optional provider for `deepseek-v4-flash` and `deepseek-v4-pro`, base URL `https://api.deepseek.com`, Chat upstream metadata.
- Removed stale provider `default`; it was an imported old router config under a misleading name.
- Cleaned `common_config_codex` by removing provider-owned lines `model_catalog_json`, `model_context_window`, `model_provider`, and `model`; preserved user MCP/plugin/windows/reasoning/auto-compact settings.
- Left Codex proxy disabled and current provider as `codex-official`: `enabled=0`, `proxy_enabled=0`, `live_takeover_active=0`. This avoids disrupting official fallback until the user explicitly enables/switches router.
- UI caveat: already-open CCSwitchMulti windows cache the provider list. Restart/refresh CCSwitchMulti after this DB write to show the four providers.

## 2026-06-09 Current Good Routing State And History Thread Reaudit

- User has now verified this build's Codex routing and OpenAI official fallback configuration are working. Preserve that as the known-good baseline during future debugging.
- Known-good provider layout:
  - `codex-official` / `OpenAI Official Backup`: pure official fallback, empty provider config, safe current provider.
  - `codex-openai-router` / `OpenAI Multi-Model Router`: local proxy provider using active Codex `model_provider = "codex_model_router_v2"` and catalog entries for GPT, Codex Spark, Qwen, and DeepSeek routes.
  - `codex-qwen-local` and `codex-deepseek`: optional direct providers, not replacements for the official fallback.
- Remaining unresolved bug: Codex history threads still do not display/sync as expected. The user says this is related to provider and bucket, and the previous memory around this may be wrong.
- Do not assume `codex_model_router_v2` is a universal history fix and do not rewrite sqlite/jsonl buckets by default. Re-verify Codex Desktop, CCSwitch, and Codex++ behavior around history indexes, provider buckets, accounts, sources, cwd/project filters, archived state, and pagination before implementing a fix.

## 2026-06-09 OpenAI Bucket Semantics And Responses WebSocket Fallback

- Verified against OpenAI Codex docs and local Codex v0.137.0 source: `openai` is a reserved built-in provider id. `model_providers.openai` does not override the built-in provider; `merge_configured_model_providers` keeps the built-in entry. To point built-in OpenAI at a proxy/router, use user-level top-level `openai_base_url`, not `[model_providers.openai].base_url`.
- Built-in `openai` provider semantics that matter for cc-switch:
  - `requires_openai_auth = true`.
  - `wire_api = responses`.
  - `supports_websockets = true`.
  - Normal turns prefer Responses WebSocket before HTTP Responses.
- Root cause of previous `openai` bucket failures/slowness: cc-switch served HTTP `POST /responses` but did not explicitly handle Codex's WebSocket handshake `GET /responses`. Codex switches immediately to HTTP only when the WS connect returns `426 Upgrade Required`; generic 404/405/network failures can cause retries, delay, or timeout.
- Implemented compatibility fix:
  - `src-tauri/src/proxy/server.rs` maps Codex `/responses`, `/v1/responses`, `/v1/v1/responses`, and `/codex/v1/responses` as `GET -> handle_responses_websocket_fallback` and `POST -> handle_responses`.
  - `src-tauri/src/proxy/handlers.rs` adds `handle_responses_websocket_fallback`, returning 426 with a small JSON error. This is an intentional signal to the official Codex client to disable WS for the session and use HTTP.
  - `src/utils/providerConfigUtils.ts` no longer treats `openai_base_url` as a `wire_api` value. Added a regression unit test.
  - `src-tauri/src/codex_history_migration.rs` now gates old v1 helper wrappers behind `#[cfg(test)]`.
- Current DB provider state checked read-only with secrets redacted:
  - `codex-official` / `OpenAI Official Backup` is current and pure official fallback.
  - `codex-openai-router` uses `model_provider = "openai"`, top-level `openai_base_url`, `model_catalog_json`, no `[model_providers.openai]`, routes `openai-official`, `qwen-local`, `deepseek`, and catalog models `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `qwen3.6`, `deepseek-v4-flash`, `deepseek-v4-pro`.
- Validation commands passed:
  - `pnpm test:unit tests/utils/providerConfigUtils.codex.test.ts` (26 tests).
  - `cargo test --manifest-path .\src-tauri\Cargo.toml openai_for_v2 --lib` (2 tests).
  - `cargo test --manifest-path .\src-tauri\Cargo.toml responses_websocket_fallback_returns_upgrade_required --lib` (1 test).
  - Focused Rust regressions for `openai_base_url`, router merge, settings migration preservation, and Codex common-config stripping all passed.
- Latest package:
  - Directory: `src-tauri/target-ccswitchmulti-openaibucket-wsfix-20260609_163308/`.
  - Portable exe: `release/bundle/portable/CCSwitchMulti.exe`, SHA256 `DE348E685A03A522B4A2066FD0CAEA900EDE0B50A0433E959897ED4771DFDCC8`.
  - Portable zip: `release/bundle/portable/CCSwitchMulti_3.16.1-1_x64-openai-bucket-wsfix-portable.zip`, SHA256 `0085BAC5C731763D352757A295CC3CEBFF15BFDBCE32FA7BFD0341D56CCD587A`.
  - NSIS installer: `release/bundle/nsis/CCSwitchMulti_3.16.1-1_x64-setup.exe`, SHA256 `3DDD9F93DEF8020CAE12097CCAAFA89807A41C510C40F61696D92353BE2B58BF`.
- Build cleanup: removed default `src-tauri/target` and old `target-ccswitchmulti-rootfix-20260609_032709`. The old rootfix directory was locked by a stale local modified `CCSwitchMulti.exe`, so that stale local process was stopped before deletion. The official installed CC Switch stayed running at `%LOCALAPPDATA%\Programs\CC Switch\cc-switch.exe`.
- Operational note: only `src-tauri/target-ccswitchmulti-openaibucket-wsfix-20260609_163308/` should be handed out now. Launching/testing the new portable no longer has an older CCSwitchMulti process competing via single-instance; it is not necessary to stop the user's official Codex/official backup chat process.

## 2026-06-11 Third-party Agent API Public Access Check

- External OpenAI-compatible Agent API is intentionally separated from the Codex/Multi Router main proxy: current external listener is `0.0.0.0:15722`; main proxy `15721` is not listening in the checked runtime.
- Local and trusted-network reachability passed:
  - `http://127.0.0.1:15722/health` returned HTTP 200.
  - LAN addresses `192.168.31.206:15722` and `192.168.31.152:15722` returned HTTP 200 from this host.
  - Tailscale address `100.118.73.52:15722` returned HTTP 200 from this host.
- Public Internet reachability failed from this host:
  - Public IP discovery returned inconsistent exits (`185.151.146.146` from ipify and `117.133.83.107` from ipinfo), indicating proxy/multi-exit/NAT behavior.
  - `http://185.151.146.146:15722/health` and `http://117.133.83.107:15722/health` both timed out.
- Interpreted cause: CC Switch is bound correctly and Windows has enabled inbound `cc-switch.exe` allow rules for Private/Public profiles, so the remaining blocker is likely upstream of the app: router port forwarding, carrier-grade NAT, public IP not mapped to this machine, or external firewall/NAT policy.
- Do not treat公网 timeout as an application regression unless LAN/Tailscale/localhost also fail. For real public exposure, configure router/NAT port forwarding to the machine's active LAN IP or use a tunnel/VPN endpoint, and keep `ccsw_` keys private.
- Added `docs/guides/external-openai-api-relay-domain-guide-zh.md` as the operational handoff guide for exposing the External OpenAI-compatible API through a public relay/domain. The preferred topology is public relay Caddy/Nginx -> private Tailscale or SSH tunnel -> Windows CC Switch `15722`; use route/NAT forwarding only when a real inbound public IP exists.

## 2026-06-12 Codex DeepSeek Direct Provider Local Routing Fix

- Root cause for the reported standalone DeepSeek Codex provider failure: the UI's "需要本地路由映射" intent was stored as `meta.apiFormat = "openai_chat"`, but `ProviderService::switch` only hot-switched when takeover was already active. In normal mode it still wrote the DeepSeek provider directly into Codex live config, so Codex called `https://api.deepseek.com/responses` and DeepSeek returned 404.
- This is not a Third-party Agent API issue and not a DeepSeek documentation issue. DeepSeek's official endpoint is Chat Completions style; Codex still speaks Responses to CC Switch, so the local proxy must sit between Codex and DeepSeek.
- Regression source audit:
  - `1c82b8a3 Add Chat Completions routing for Codex providers` introduced `meta.apiFormat = "openai_chat"` and the proxy conversion path, while keeping generated Codex `wire_api = "responses"` so the Codex client can continue using Responses locally.
  - The same change only added a frontend warning in `useProviderActions`; it did not block normal switch or enable takeover.
  - Existing `ProviderService::switch` behavior from the older switch architecture still treated "not currently taken over" as permission to call `switch_normal -> write_live_with_common_config`, which direct-writes provider config to Codex live files.
  - Later local changes `8af568e4` / `24eca85c` made the UI present this as a first-class local routing / multi-route capability, which made the latent mismatch user-visible: users reasonably expected the switch/config to activate routing, but the backend still only routed if takeover was already active.
  - Official upstream is not able to make DeepSeek work by direct `/responses` either; it works only when Codex is already going through CC Switch proxy/takeover. The fix here is making that invariant backend-enforced instead of relying on user sequence or frontend warning.
- Implemented backend defense:
  - `ProviderService::codex_provider_requires_local_proxy` detects Codex providers that require local proxy because they are Chat Completions backends or contain `codexRouting`.
  - `ProviderService::switch` now auto-enables Codex takeover for such providers when takeover is not already active, instead of taking the normal direct live-write path.
  - `ProxyService::takeover_app_and_switch_provider_after_switch_lock` performs the locked transition: start proxy if needed, back up/sync existing live config, switch current provider, write Codex live config to local proxy `/v1`, update backup/current target, and set per-app takeover enabled.
- Regression test added: `switching_codex_chat_provider_auto_enables_local_proxy_takeover` asserts a DeepSeek `openai_chat` provider switch writes `http://127.0.0.1:<port>/v1` plus `PROXY_MANAGED` into Codex live config and does not leave `https://api.deepseek.com` in live config.
- Validation passed:
  - `cargo test switching_codex_chat_provider_auto_enables_local_proxy_takeover --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test test_codex_provider_uses_chat_completions --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test v1_responses --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test external_openai_api --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
  - `pnpm typecheck`

## 2026-06-12 Codex Takeover Model Picker Must Stay On Built-in OpenAI

- Follow-up root cause for the user's "GPT menu shows 自定义, where did the selectable models go" screenshot: after the DeepSeek auto-takeover fix, Codex live config correctly pointed at CC Switch, but it still projected the selected upstream provider id (`deepseek`, `aihubmix`, etc.) into live `model_provider`. Codex then treated the session as a custom provider and the model picker collapsed into the custom-model bucket instead of showing the intended GPT/router catalog choices.
- Correct invariant: during proxy takeover, Codex live `config.toml` should expose the stable built-in OpenAI provider:
  - `model_provider = "openai"`
  - top-level `openai_base_url = "http://127.0.0.1:<port>/v1"`
  - `model_catalog_json = "cc-switch-model-catalog.json"` when CC Switch has a model catalog
  - `auth.json` uses `OPENAI_API_KEY = "PROXY_MANAGED"`
  - no upstream `[model_providers.<deepseek/qwen/...>]` table should be exposed in live takeover config.
- Real upstream provider identity and API keys stay in CC Switch DB/backup/provider settings. The proxy resolves the current provider or `codexRouting` by request model and injects upstream credentials internally.
- Implemented fix:
  - `ProxyService::apply_codex_proxy_toml_config_for_provider` now projects takeover TOML to built-in `openai` plus `openai_base_url`, preserving the selected model but stripping upstream provider tables/tokens from live config.
  - `codex_config::merge_codex_provider_config_texts` now removes the active custom provider table when the provider projection targets built-in `openai`, so stale live `[model_providers.*]` tables do not survive the merge.
- Regression coverage:
  - `apply_codex_proxy_toml_config_uses_builtin_openai_proxy_provider`
  - `hot_switch_codex_chat_provider_updates_live_provider_display`
  - `merge_openai_router_config_uses_builtin_openai_history_bucket`
  - `switching_codex_chat_provider_auto_enables_local_proxy_takeover`

## 2026-06-12 CCSwitchMulti v3.16.2-2 Release Export Rule

- Release tag for this fix train is `v3.16.2-2`; do not reuse `v3.16.2-1` because it already exists on `BigStrongSun/cc-switch`.
- Fixed local export directory remains `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`.
- GitHub Release assets cannot safely upload two different files both named `BUILD_ON_PLATFORM.md`; the export script now also writes root-level `linux-build-note.md` and `macos-build-note.md` with unique names for release upload.
- `SHA256SUMS.txt` should be generated after those root-level note files are copied, so the checksum list matches the final export directory.

## 2026-06-12 Codex DeepSeek Routing Crash And Legacy Wire API Fix

- User-reported crash: CCSwitchMulti v3.16.2-2 flashed/crashed when enabling Codex routing or switching to the DeepSeek provider.
- Windows/WER plus `%USERPROFILE%\.cc-switch\crash.log` showed the real root cause: `there is no reactor running, must be called from the context of a Tokio 1.x runtime`, followed by `panic in a function that cannot unwind`. This happened because the synchronous Tauri `switch_provider` command called `futures::executor::block_on` and then started the proxy TCP listener outside a Tokio reactor.
- Fix invariant: synchronous provider commands that wait for async proxy/db work must use a Tauri-runtime-aware helper. If a Tokio handle is already present, continue polling in the current context; otherwise enter `tauri::async_runtime::block_on`.
- Implemented helper: `services::provider::block_on_tauri_runtime`, used by provider switch/update/sync paths that call proxy async methods.
- Regression test added: `switching_codex_chat_provider_from_sync_command_has_tokio_reactor`, which simulates the desktop synchronous command path and verifies switching a Codex Chat provider starts local proxy without the missing-reactor panic.
- Second root cause found in current user DB (read-only, secrets redacted): `codex-deepseek` had `base_url = "https://api.deepseek.com"` and model catalog entries, but `wire_api = "responses"` and no `meta.api_format`. The old detector returned false as soon as it saw `wire_api = "responses"`, so DeepSeek was treated like a Responses provider and Codex could call `/responses` directly.
- Fix invariant: explicit `meta.api_format` still wins, but known Chat-Completions-only upstream URLs such as `api.deepseek.com`, `api.moonshot.cn`, DashScope, GLM, SiliconFlow, OpenRouter, and vLLM must be detected before trusting stale `wire_api = "responses"` from historical configs.
- Regression tests added:
  - `test_codex_provider_uses_chat_completions_for_legacy_deepseek_responses_wire_api`
  - `test_codex_provider_keeps_openai_responses_wire_api`
- This bug is not caused by the Third-party Agent API. It is the Codex provider/takeover path plus stale provider wire metadata.

## 2026-06-12 Codex Router Official GPT-5.5 URL Normalization Fix

- User clarified that the failed high-demand/reconnect case happened after selecting `gpt-5.5` from the Codex model list, while `OpenAI Official Backup` could use `gpt-5.5` successfully.
- Root cause: the Codex multi-model router's managed OAuth route builds a temporary `codex_oauth` provider that uses `CodexAdapter`. `CodexAdapter.build_url` treated `https://chatgpt.com/backend-api/codex` like a generic custom prefix, so a local Codex request to `/v1/responses` could become `https://chatgpt.com/backend-api/codex/v1/responses`. ChatGPT's Codex backend expects `https://chatgpt.com/backend-api/codex/responses` without `/v1`.
- Why official backup worked: non-router official requests were already observed in `codex-router.log` as `upstream_url=https://chatgpt.com/backend-api/codex/responses`. The bug lived in the router/effective-provider URL construction path, not in the user's official subscription, model availability, or DeepSeek conversion.
- Fix invariant: any Codex OAuth provider targeting `https://chatgpt.com/backend-api/codex` must strip the OpenAI-compatible `/v1/` prefix before forwarding to ChatGPT Codex backend. `/v1/responses` maps to `/responses`; `/v1/responses/compact?...` maps to `/responses/compact?...`.
- Regression tests added/strengthened:
  - `test_build_url_chatgpt_codex_backend_strips_openai_v1_prefix`
  - `test_codex_adapter_supports_routed_codex_oauth_provider` now asserts routed OAuth URL construction as well as auth strategy.

## 2026-06-12 Codex Multi Router 首个 SSE 错误触发 Failover

- 用户继续反馈 CCSwitchMulti 的 Codex multi 选择多路路由后仍出现 `We're currently experiencing high demand` / `stream disconnected before completion`；恢复 `OpenAI Official Backup` 也可能报同类错误。
- 追根因后确认：这类错误不一定表现为 HTTP 5xx。ChatGPT/Codex OAuth 可能返回 HTTP 200 + `text/event-stream`，但首个 SSE block 就是 `event: error` 或 `event: response.failed`。此前 `RequestForwarder::prime_streaming_response` 只等到首个 chunk 就把 provider 记为成功并把响应交给 Codex；一旦响应头已发给客户端，同一个请求就不能再 failover 到下一路。
- 修复规则：在首包预读阶段解析首个完整 SSE block；如果明确是 `error` / `response.failed` / payload 中含 `error` 或 `response.status=failed`，在响应交给客户端前转换为 `ProxyError::UpstreamError { status: 503 }`。这样现有 retry/failover 分类会把它当作可重试上游失败，multi 路由/故障转移才有机会换下一家。
- 正常 `response.created`、delta、`response.completed` 仍必须原样 replay 给客户端，不能为了吞错而破坏正常流。
- 已加回归测试：
  - `streaming_first_sse_error_event_is_retryable_before_response_is_returned`
  - `streaming_first_normal_sse_event_is_replayed_to_client`
- 已验证：
  - `cargo test streaming_first --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test forwarder --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test test_build_url_chatgpt_codex_backend_strips_openai_v1_prefix --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test test_codex_adapter_supports_routed_codex_oauth_provider --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
  - `cargo check --manifest-path src-tauri/Cargo.toml`（仅既有 `commands/misc.rs` 两个 unused warning）

## 2026-06-12 Codex Official 也报 high demand 的根因修正

- 用户指出“official 也出现 high demand，说明上游返回 error 本身就不对，前一刀没修到点上”。这个判断成立：上一条 `prime_streaming_response` 修复只解决“首个 SSE error 交给客户端前还能 failover”的边界，不解释为什么 official/official backup 会拿到同类错误。
- 本机排查结论：恢复到 official backup 后，`~/.codex/config.toml` 已没有 `model_provider/openai_base_url/cc-switch` takeover 字段，主代理也已停止；纯 official 路径不经过 CC Switch。此时仍出现 high demand，只能是官方 Codex/ChatGPT 后端或 official 客户端重试后仍失败，CC Switch 不能在纯直连 official 路径里修上游容量错误。
- 对比 `codex-source-rust-v0.137.0` official 源码后确认：official Codex 会使用 `session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id = {thread_id}:{generation}`，并通过 `responses_retry::handle_retryable_response_stream_error` 对可重试 stream 错误循环重试，必要时 WebSocket fallback 到 HTTPS。
- CC Switch 的 official/managed OAuth 代理路径此前不够 official：`extract_codex_session` 只认 `session_id/x-session-id` 并给值加 `codex_` 前缀；`build_codex_oauth_session_headers` 注入 `session_id` 下划线头，且会覆盖已有 header。这会让“OpenAI Official Backup / router official route”在代理路径中和 official 客户端的身份/缓存/路由信号不一致，可能放大 high-demand/stream-failed 问题。
- 根因修复：Codex session 提取现在识别 `session-id/thread-id/x-client-request-id/x-codex-window-id/session_id/x-session-id`，从 `x-codex-window-id` 提取 thread_id，并保留原始值不加前缀；ChatGPT Codex OAuth 转发补齐 `session-id/thread-id/x-client-request-id/x-codex-window-id`，且只在原请求缺失时补，不覆盖 official 客户端已有值。
- 回归测试新增/更新：
  - `test_codex_official_session_id_header_is_preserved`
  - `test_codex_window_id_header_extracts_thread_identity`
  - `codex_oauth_session_headers_match_codex_cache_identity`
- 已验证：
  - `cargo test codex --manifest-path src-tauri/Cargo.toml --lib`（357 tests）
  - `cargo test forwarder --manifest-path src-tauri/Cargo.toml --lib`（52 tests）
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
  - `cargo check --manifest-path src-tauri/Cargo.toml`（仅既有 `commands/misc.rs` 两个 unused warning）

## 2026-06-12 Codex Multi Router 从“模型分流”升级为“路由内故障转移”

- 用户继续指出“选择多路路由仍报 high demand，说明上游返回 error 本身就不对，之前没修到点上”。再次追根因后确认：当前 `codex-openai-router` 配置里，`gpt-5.5` 只匹配 `openai-official` route；Qwen/DeepSeek route 只匹配各自模型名前缀。旧逻辑的“多路路由”只是按请求模型选一路，不是同一个请求在官方失败后自动尝试其它 route。
- 因此即使首个 SSE `event:error` 已能在响应交给客户端前变成 retryable error，外层 failover 也只有一个 router provider 可尝试；实际不会落到 Qwen/DeepSeek。要真正解决“官方高负载时多路路由继续跑”，必须把 router provider 在转发前展开成 route provider 候选链。
- 修复规则：Codex 请求进入 `RequestForwarder::forward_with_retry_inner` 后，如果当前 provider 是 Codex router，就按请求模型解析候选 route：匹配 route 放第一位；其它 enabled route 作为后备追加。外层 provider retry/failover 会逐个尝试这些 effective provider。
- 跨模型后备必须改写上游模型名：例如用户请求 `gpt-5.5` 时，第一路 official 仍发 `gpt-5.5`；若 official 首包失败并切到 DeepSeek route，发给 DeepSeek 的模型必须改成 route 自己的默认模型（如 `deepseek-v4-flash`），不能把 `gpt-5.5` 原样发给 DeepSeek/Qwen。
- 为避免展开后的 route provider 再次被解析回官方 route，resolved route 会带 `codexResolvedRouteId`；`forward` 看到该标记后直接使用该 effective provider。
- 回归测试新增：
  - `test_codex_router_returns_fallback_route_candidates_after_primary`
  - `test_apply_codex_chat_upstream_model_forces_unmatched_fallback_route_model`
- 已验证：
  - `cargo test test_apply_codex_chat_upstream_model_forces_unmatched_fallback_route_model --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test codex_router_returns_fallback_route_candidates_after_primary --manifest-path src-tauri/Cargo.toml --lib`
  - `cargo test forwarder --manifest-path src-tauri/Cargo.toml --lib`（52 tests）
  - `cargo test codex --manifest-path src-tauri/Cargo.toml --lib`（359 tests）
  - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
  - `cargo check --manifest-path src-tauri/Cargo.toml`（仅既有 `commands/misc.rs` 两个 unused warning）

## 2026-06-12 Codex Multi Router official route 与 official backup 不等价

- 用户继续追问“为什么 Multi Router 用 official 会失败，这才是本质”。排查结论：Multi Router 的 official route 不是纯 official backup；它是 Codex built-in `openai` bucket -> `openai_base_url=http://127.0.0.1:<port>/v1` -> CC Switch HTTP/SSE proxy -> `https://chatgpt.com/backend-api/codex/responses`。
- 官方 Codex 源码 `model-provider-info/src/lib.rs::create_openai_provider` 对 built-in `openai` 设置 `supports_websockets = true`；`client.rs` 会优先走 Responses WebSocket，失败后才通过 `responses_retry::handle_retryable_response_stream_error` fallback 到 HTTPS/SSE。CC Switch 当前主代理没有实现 Codex Responses WebSocket，只在 `/responses` 的 GET 上返回 426 让客户端降级。
- 因此“Multi Router official”比“official backup”少了官方 WebSocket 直连能力，更容易落到 GitHub issue 中大量用户也报错的 HTTPS/SSE `/backend-api/codex/responses` 路径。外部 issue 覆盖 `stream disconnected before completion`、`high demand`、remote compaction、Azure/rate-limit/context 等场景；这说明 high demand 文案是 Codex 对多类后端/传输失败的泛化提示，不一定只表示真实排队高峰。
- 之前保留 `model_provider="openai"` 是为了维持官方 history bucket 和模型菜单；但这个选择天然启用 built-in OpenAI WebSocket 语义。若要让 Multi Router official 真正等价 official backup，根修方向不是再补 HTTP retry，而是实现 Codex Responses WebSocket relay/proxy，至少覆盖 prewarm、response.create、`x-codex-turn-state` sticky routing、`response.processed` 等官方协议。
- 可选降级方案：改回自定义 provider 并显式 `supports_websockets=false` 可避免 WS fallback 抖动，但会重新带来模型菜单/历史 bucket 变成自定义的问题；这是产品取舍，不是根治。

## 2026-06-12 Codex Responses WebSocket official relay

- 用户强调“尽量复用官方，不然永远会有 bug”。本轮修复原则：CC Switch 不实现自己的 Codex 事件协议解释器，只在本地 `/responses` GET 接受 WebSocket 后做透明中继；官方事件流、`response.create`、`response.processed`、prewarm 完成事件、错误事件都由 Codex 官方客户端和 ChatGPT Codex 后端继续按原协议处理。
- 新增 `src-tauri/src/proxy/codex_ws.rs`：首帧只解析 `response.create` 的 JSON 以获取 `model`，复用现有 `resolve_codex_model_routed_providers` 和 `CodexAdapter` 判定真实 route；只有 route 上游是 `https://chatgpt.com/backend-api/codex` 且不是 Chat Completions-only 时，才连接 `wss://chatgpt.com/backend-api/codex/responses`。
- WebSocket upstream 鉴权复用现有 Codex OAuth 托管账号：从 `CodexOAuthState` / `CodexOAuthManager` 取真实 access token，再通过 `CodexAdapter::get_auth_headers` 生成 `authorization` / `originator`；同时透传 official 相关 header：`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-state`、`chatgpt-account-id` 等。
- 非 official WS 路线不能在升级后直接断流，否则 official Codex 会报 `stream disconnected before completion`。正确做法是发送官方源码 `responses_websocket.rs` 能解析的 `{"type":"error","status_code":426,...}`，让 `client.rs` 命中 `WebsocketStreamOutcome::FallbackToHttp`，再走现有 HTTP Responses -> Chat bridge 给 Qwen/DeepSeek 等第三方 API。
- 路由变更：`/responses`、`/v1/responses`、`/v1/v1/responses`、`/codex/v1/responses` 的 GET 进入 `handle_responses_websocket`；非升级 GET 仍返回旧 426 JSON，POST HTTP Responses 路径不变。External OpenAI API 独立端口的 `/v1/responses` GET 也复用同一官方 fallback/relay handler，POST 仍走 external profile。
- 新增依赖：`axum` 开启 `ws` feature，新增 `tokio-tungstenite` 的 rustls/webpki TLS feature。
- 已验证：
  - `cargo test proxy::codex_ws`
  - `cargo test proxy::providers::codex`
  - `cargo test proxy::server`
  - `cargo fmt --check`
  - `cargo check`（仅既有 `commands/misc.rs` 两个 unused warning）

## 2026-06-12 Codex WS close normally after Multi Router

- 用户反馈新 WS relay 后 Multi Router 报 `stream disconnected before completion: failed to send websocket request: Connection closed normally`。这说明本地 `/responses` WS 已被 official Codex 命中，且到 ChatGPT Codex upstream 的 WebSocket 握手成功，但上游在首个 `response.create` 发送前/发送时正常关闭。
- 对照官方源码确认：`core/src/client.rs::build_websocket_headers` 会构造 `openai-beta: responses-websockets-v2`、`x-codex-beta-features`、`x-codex-turn-state`、`x-codex-turn-metadata`、`x-client-request-id`、`session-id`、`thread-id`、`x-codex-window-id`、attestation 等；随后 `codex_login::default_client::default_headers()` 补 `originator` 和真实 `user-agent`。上一版 relay 只手写少数头，并通过 `CodexAdapter::get_auth_headers` 把 `originator: cc-switch` 发给 upstream WS，不够 official。
- 修复规则：上游 WS 握手应优先复用客户端发给本地代理的官方 headers；只过滤 hop-by-hop/WebSocket 握手头、本地占位 `authorization`、content headers，然后替换为真实 Codex OAuth `Authorization`。不要覆盖客户端提供的 `originator`、`user-agent`、`openai-beta`、`x-codex-*`、attestation 等官方头。
- 代码位置：`src-tauri/src/proxy/codex_ws.rs::copy_official_client_headers` 与 `should_skip_client_ws_header`。`codex_auth_headers` 仍负责取托管 OAuth token，但插入 upstream headers 时跳过 adapter 生成的 `originator`，避免把官方 originator 改成 `cc-switch`。
- 已验证：
  - `cargo fmt --check`
  - `cargo test proxy::codex_ws`
  - `cargo check`
  - `pnpm typecheck`
  - `pnpm release:export`
- 新 raw exe 已导出并启动：`C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\windows\raw-exe\CCSwitchMulti.exe`，SHA256 `6A14F9627A87DBFA274D28D8A45703B7B05511145DA431D30F4B1E15770D3D11`。

## 2026-06-12 Codex WS Connection closed normally diagnostics

- 用户继续反馈开启 Multi Router 后仍报：`stream disconnected before completion: failed to send websocket request: Connection closed normally`。本轮先查日志：`%USERPROFILE%\.cc-switch\logs\cc-switch.log` 只有代理启停，`codex-router.log` 只有旧 HTTP forwarder 事件，缺少 Responses WebSocket relay 的握手、首帧、close code、fallback event 发送结果，因此无法判断是本地代理提前关、官方 upstream policy close，还是 fallback event 没送到 Codex 客户端。
- 外部交叉验证：Codex built-in web search 与用户 `matrix-websearch` 均搜到 openai/codex 同类问题；典型 issue 包括 `openai/codex#13039` / `#13041`，证据是 `wss://chatgpt.com/backend-api/codex/responses` 握手 `101 Upgrade` 成功后，官方 upstream 立即发 close code `1008 Policy`，Codex 客户端显示同样的 `failed to send websocket request: Connection closed normally` 并 fallback 到 HTTPS。因此本地日志必须记录 close code/reason length 和是否收到上游首帧，不能只记录 relay done。
- 诊断增强：`src-tauri/src/proxy/codex_ws.rs` 新增 `ws_*` 事件写入 `codex-router.log`，包含 accepted/client*first_frame/route_resolved/upstream_connect_start/upstream_connect_ok/upstream_first_send_start/upstream_first_send_ok/upstream_first_frame/upstream_close/client_close/relay*\*\_done/error/fallback_event_send_ok/error/fallback_close_ok/error 等。日志只写 header 名、帧类型、字节数、close code、reason_len 和 JSON error 摘要，不记录 token、header value、完整首帧、完整 upstream text、完整 close reason。
- 行为修正：若 upstream 首帧发送失败，不能直接 close 本地 WS；现在会先记录 `ws_upstream_first_send_error` 和 500ms upstream probe，再向本地 Codex 发送协议内 `status_code=426` error event，触发官方客户端按自身逻辑 fallback 到 HTTP Responses，而不是让用户只看到 `Connection closed normally`。
- Relay 可观测性增强：`upstream_first_send_ok` 之后的透明转发阶段会统计两侧 frames/bytes；如果 upstream 正常 close，会记录 `ws_upstream_close code=<code> reason_len=<n> before_first_upstream_frame=<bool>`；如果没有任何 upstream frame 就结束，会记录 `ws_upstream_ended_without_frames`。这正是后续区分“官方上游 policy close 1008”和“本地 relay/fallback 未送达”的关键证据。
- 本轮验证：
  - `cargo fmt --check`
  - `cargo test proxy::codex_ws`
  - `cargo check`（仅既有 `commands/misc.rs` 两个 unused warning）
  - `pnpm typecheck`
  - `pnpm release:export`
- 新 raw exe 已导出并启动：`C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\windows\raw-exe\CCSwitchMulti.exe`，SHA256 `4AC80A8E65784438957618568F7C1547B56BBD9381EF9B8FC7849CD87F4EDE1C`。启动后 `http://127.0.0.1:15722/health` 正常；`15721` 在未启用 Codex takeover 时不监听，符合预期。

## 2026-06-12 Codex Multi Router not being hit runtime check

- 用户再次反馈同样 `Connection closed normally`，但检查结果显示这次请求没有进入 CC Switch 的 Codex Multi Router：`%USERPROFILE%\.cc-switch\logs\codex-router.log` 最后更新时间仍是 `2026-06-12 06:16:39 UTC`，没有任何新 `event=ws_*`；`~/.codex/config.toml` 当前没有 `model_provider` / `openai_base_url` 指向 `127.0.0.1:15721`；`http://127.0.0.1:15721/health` 不通，而 `15722/health` 正常。
- `cc-switch.log` 显示用户在 `2026-06-12 16:45:20` 选择 `codex-openai-router` 后确实短暂启动了 Codex takeover 并写入 `http://127.0.0.1:15721/v1`，但 `16:46:17` 又执行了 Codex Live 配置恢复并停止 15721。用户说明这是因为不可用后切回 official，因此后续报错自然不会有 router 日志。
- 当前数据库状态：`providers` 里 `codex-official` 是 `is_current=1`，`codex-openai-router` 是 `is_current=0`；`proxy_config` 里 `codex.enabled=0`；`proxy_live_backup` 为空；第三方 OpenAI API 旁路 profile 仍指向 `codex-official`。因此现状是纯 official/旁路 official，不是 Multi Router takeover。
- 重要使用判据：Codex Multi Router 给 Codex 客户端用的是 `15721` takeover 端口；`15722` 是第三方 OpenAI-compatible Agent API 旁路端口，两者不是同一路。要验证 Multi Router，必须先在 CCSwitchMulti 选择 `OpenAI Multi-Model Router`，确认 `15721/health` 正常且 `~/.codex/config.toml` 指向 `127.0.0.1:15721/v1`，然后新开/重启 Codex 会话，因为已经运行的 Codex 会话通常不会重新读取刚改的 config。

## 2026-06-12 Codex Desktop App Multi Router activation diagnostics

- User clarified that "Codex" in this issue means the OpenAI Codex Desktop App, not a standalone CLI. The user's manual switch back to official/route-off was only to keep the current Codex conversation usable for debugging and must not be treated as the root cause.
- Local process evidence: the Desktop App runs `Codex.exe` from the WindowsApps package and an agent process `resources\codex.exe app-server --analytics-default-enabled`. In the current manual-official state, CCSwitch listens on `15722` only and `15721` is not listening, which is expected.
- Official documentation context: user-level `~/.codex/config.toml` supports `openai_base_url` as the built-in `openai` provider base URL override. The documentation warning that Codex ignores `openai_base_url` applies to project-local `.codex/config.toml`, not the user-level file.
- Code change: `ProxyService::takeover_app_and_switch_provider_after_switch_lock` now verifies the final activation state after starting the proxy, writing live config, setting DB enabled, and setting active target.
- New log event: `takeover_activation_check app=... provider=... proxy_running=... expected_proxy_url=... expected_codex_base_url=... live_matches_current_proxy=...`. Failure logs `takeover_activation_failed ... config_path=...` and rolls back provider/enabled/live config so the UI cannot show a false successful Multi Router activation.
- Next diagnostic rule: if Multi Router switch logs `proxy_running=true` and `live_matches_current_proxy=true` but `codex-router.log` still has no request, the remaining root cause is Codex Desktop app-server/thread not refreshing user config; if the activation check fails, follow the logged port/config evidence first.

## 2026-06-12 Codex Multi Router WS route/fallback root cause

- 完整追溯后确认链路：UI provider 卡片 -> `useProviderActions.switchProvider` -> `useSwitchProviderMutation` -> Tauri `switch_provider` -> `ProviderService::switch`。Codex router provider 因 `settings_config.codexRouting` 被判定为必须走本地代理，后端调用 `takeover_app_and_switch_provider_after_switch_lock`，启动 15721、备份 live config、写入 `openai_base_url=http://127.0.0.1:15721/v1`，并把当前 provider 设为 `codex-openai-router`。
- 能关闭 15721 的源码路径只有：切换到 category=official 的 provider 时走 `disable_takeover_for_app_after_switch_lock`；顶部/设置页关闭 takeover 时走 `set_takeover_for_app(false)`；总关闭代理时走 `stop_with_restore`。列表查询/provider 查询/get status 不会自动关闭 15721。
- 当前运行态证据：`15721/health` 不通，`15722/health` 正常；DB 中 `codex-official is_current=1`、`codex-openai-router is_current=0`、`proxy_config.codex.enabled=0`；`codex-router.log` 最后更新时间仍是 `2026-06-12 06:16:39 UTC`，因此这次用户看到的后续报错没有进入 15721。
- 中转根因修复：`codex_ws::resolve_official_ws_provider` 以前会遍历 router 展开的所有 fallback route，导致非 official/chat route 命中后仍可能扫描到后面的 official route 并错误进入 official WebSocket。现在只看本次模型解析出的第一条 effective route：如果它是 Chat Completions route 或不是 ChatGPT Codex official upstream，立即发送协议内 426 fallback，让官方 Codex 走 HTTP Responses -> Chat bridge。
- 中转根因修复：official upstream WS 在首帧后立即 close 或无任何数据结束时，旧 relay 只是把 close 原样转给 Codex，客户端显示 `Connection closed normally`。现在在 `upstream_close` 且 `before_first_upstream_frame=true` 或 `upstream_ended_without_frames` 时，向本地 Codex 发送 WebSocket 内 `status_code=426` error event 并关闭，尽量触发官方 HTTP fallback/failover。
- 中转兼容修复：upstream WS `origin` 现在强制覆盖为 `https://chatgpt.com`，避免客户端经本地代理留下非官方 origin 后被 upstream policy close。
- 可观测性修复：official switch 和手动关闭 takeover 现在都会在主日志显式记录 `source=official_switch` 或 `source=proxy_toggle_or_command`，后续能直接看出是谁关闭了 15721。
- UX 修复：Codex provider 切换成功后会刷新 `proxyStatus/proxyRunning/proxyTakeoverStatus/liveTakeoverActive`；即使之前弹过“需要代理”警告，Codex Multi Router 仍会明确提示“保持 CC Switch 运行，并完全重启或新开 Codex 会话后生效”。
- 联网交叉验证：内置 web search 与 matrix-websearch 都能找到 Codex `stream disconnected before completion` 同类问题；matrix 结果更偏中文代理/证书/长连接排障，GitHub 精确结果少。结论是 official 上游/网络确实可能断，但 CC Switch Multi Router 的责任是把可 fallback 的 WS 失败转成 HTTP/failover 路径。
- 已验证：`cargo fmt`、`cargo test proxy::codex_ws --lib`（5 tests）、`cargo check`（仅既有 `commands/misc.rs` 两个 unused warning）、`pnpm typecheck`、`pnpm release:export`。已启动新 raw exe：`C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\windows\raw-exe\CCSwitchMulti.exe`，SHA256 `BEC4C9F4B41736D26E0238EC5E77A79A9E1A5E3624280884FF42967D5C009C50`。启动后 `15722/health` 正常，未启用 Codex takeover 时 `15721` 不监听，符合预期。

## 2026-06-13 Codex MultiRouter custom runtime boundary

- 覆盖旧结论：MultiRouter 的 Codex live runtime 不能改回 `model_provider="openai"`。`openai` 是 Codex 内置保留 provider，会重新启用官方 OpenAI/WebSocket 语义；之前用它保历史桶和官方模型菜单的方案会把 `Connection closed normally` / WebSocket fallback 老问题带回来。
- 当前正确边界：MultiRouter takeover 写入 `model_provider="custom"`，`[model_providers.custom].base_url=http://127.0.0.1:<codex-port>/v1`，`wire_api="responses"`，`supports_websockets=false`，并移除 `openai_base_url`。真实 OpenAI/Qwen/DeepSeek 上游、API 格式和转换层都留在 `codexRouting` 与后端 route resolver 内处理。
- 模型菜单问题不要通过改回 `openai` 解决；应检查 `modelCatalog` 是否从 DB 投影到 `~/.codex/cc-switch-model-catalog.json`，以及 live config 顶层 `model_catalog_json="cc-switch-model-catalog.json"` 是否存在。Codex 官方只读取顶层 `model_catalog_json`，不是 `[model_providers.*]` 内字段。
- 历史记录问题本质是 Codex Desktop 按 `model_provider` provider bucket 过滤。使用 custom runtime 后，openai 历史不会天然显示在 custom 桶里；修复必须是用户显式触发的历史桶同步/迁移，不能为了历史把 runtime provider 改回 openai。
- MultiRouter 状态页流量统计不能只按真实 `targetProviderId` 聚合。Qwen/DeepSeek 等内联 route 可能没有外部 providerId，应按 route id/label 作为“子 Provider”统计，并可从 `codex-router.log` 的 `route_id` 或 `effective_provider=...::route::<id>` 回归属。

## 2026-06-13 Codex MultiRouter custom provider 候选模型显示修复

- 旧版能显示全量候选的真实路径不是单纯 `/v1/models`，而是 `model_provider="openai"` + `openai_base_url=http://127.0.0.1:<port>/v1` + 顶层 `model_catalog_json="cc-switch-model-catalog.json"`。因为它仍然伪装成 Codex built-in OpenAI provider，所以运行中模型管理器允许刷新 `/models`，能从 CC Switch 本地代理拿到完整 catalog。
- 当前 MultiRouter 不能改回 `openai`，否则会重新进入 built-in OpenAI/WebSocket 语义，带回 `Connection closed normally` / WebSocket fallback 老问题。正确 runtime 仍是 `model_provider="custom"`、`supports_websockets=false`、`base_url=127.0.0.1:<codex-port>/v1`。
- 对照 Codex official 源码确认：如果 Codex 进程启动时读到了顶层 `model_catalog_json`，会走 `StaticModelsManager`，完整 catalog 可直接显示；但如果是在运行中的 Codex 热切到 custom provider，旧的 OpenAI-compatible manager 不会主动刷新 `/models`，`OnlineIfUncached` 只会读 fresh `~/.codex/models_cache.json`。因此只写 `cc-switch-model-catalog.json` 不足以修复热切后的候选模型列表。
- 根因修复：CC Switch 在生成 `~/.codex/cc-switch-model-catalog.json` 后，同步写入 `~/.codex/models_cache.json`，复用现有 `client_version`，并用 `etag="cc-switch-model-catalog"` 标记所有权；退出 MultiRouter/切回 official 时，如果当前 cache 是 CC Switch 接管过的，就恢复 `models_cache.cc-switch-backup.json`，避免污染 official backup。
- 这次修复覆盖 Qwen/DeepSeek 候选缺失和 OpenAI GPT speed tier 不显示的同源问题：catalog 生成测试确认 speed tier 没丢，cache 同步测试确认 custom provider picker 能看到 `qwen3.6` / `deepseek-v4-flash`。如果之后还有候选缺失，优先检查 `models_cache.json` 的 `client_version` 是否和当前 Codex app-server 匹配，以及 Codex 是否仍拿旧进程内 catalog。

## 2026-06-13 Codex MultiRouter provider bucket correction

- Updated conclusion after comparing older 2026-06-09 backups: MultiRouter must not use the built-in `openai` provider, but it also should not be flattened into the generic `custom` provider. The old working shape used `model_provider="codex_model_router_v2"` plus `[model_providers.codex_model_router_v2].base_url=http://127.0.0.1:<codex-port>/v1`, top-level `model_catalog_json="cc-switch-model-catalog.json"`, `wire_api="responses"`, and `supports_websockets=false`.
- Root cause for the "only three OpenAI models" symptom: after the 2026-06-12 custom-runtime change, MultiRouter takeover wrote `model_provider="custom"`. That avoided built-in OpenAI WebSocket behavior but lost the router-specific provider bucket used by the old model/history path. Cache sync alone was too weak as a hot-switch repair if Codex kept using the official/openai picker state.
- Code rule: normal single upstream Codex providers still use `CC_SWITCH_CODEX_MODEL_PROVIDER_ID = "custom"`; only providers with enabled `settings_config.codexRouting.routes` use `CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID = "codex_model_router_v2"`. Do not fix this by reintroducing top-level `openai_base_url`; official Codex only applies `openai_base_url` to the built-in `openai` provider, which re-enables the old WebSocket semantics.
- Regression coverage added: router switch now asserts live config uses `codex_model_router_v2`, defines `[model_providers.codex_model_router_v2]`, removes `openai_base_url`, disables websockets, writes `cc-switch-model-catalog.json`, and replaces `models_cache.json` with seven slugs (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`, `qwen3.6`, `deepseek-v4-flash`, `deepseek-v4-pro`) while preserving `client_version`.

## 2026-06-14 Codex Desktop three-model picker runtime boundary

- Current live config/catalog evidence can be healthy while the visible Desktop picker remains stale. On this machine, `~/.codex/config.toml` pointed at `model_provider="cc_switch_codex_router"` with `model_catalog_json="cc-switch-model-catalog.json"`, local `base_url=http://127.0.0.1:15721/v1`, `wire_api="responses"`, `requires_openai_auth=false`, `supports_websockets=false`, and no `openai_base_url`; `cc-switch-model-catalog.json` contained seven models.
- Fresh `codex.exe debug models` reading the same disk config returned all seven slugs, proving the written TOML/catalog were parseable. Therefore the remaining "only three models" symptom is not explained by route config, DB modelCatalog generation, or 15721 reachability alone.
- Codex Desktop uses `codex.exe app-server --analytics-default-enabled`; app-server builds `ThreadManager.models_manager` from startup config. `model/list` goes through that in-memory manager, so a running app-server can keep an older three-model picker even after CCSwitch rewrites `config.toml` or `cc-switch-model-catalog.json`.
- Concrete runtime evidence from this machine: `cc-switch-model-catalog.json` had 7 models; catalog mtime was `2026-06-13T23:43:49+08:00`; Codex app-server started at `2026-06-13T23:44:11+08:00`; config was written again at `2026-06-13T23:44:34+08:00`. That ordering means Desktop may be holding a model manager created before the final live config write.
- New diagnostic rule: MultiRouter status must show Codex Desktop/app-server process count, app-server command line/start time, config mtime, catalog mtime, catalog model count, and a warning when app-server started before the latest config/catalog write. The corrective action is to fully exit all Codex Desktop/app-server processes and reopen Codex before judging the picker.

## 2026-06-14 Codex MultiRouter stable history bucket and 3.16.2-6 export

- Follow-up fix: `sync_codex_history_provider_bucket_to_multirouter` must target `CC_SWITCH_CODEX_ROUTER_MODEL_PROVIDER_ID` (`codex_model_router_v2`), not `custom`. `custom` is now treated as a legacy/source bucket along with `openai` and `cc_switch_codex_router`; otherwise explicit history sync can move sessions away from the current MultiRouter runtime bucket and make history disappear again.
- MultiRouter diagnostics now classify provider buckets as `stable_router`, `legacy_router`, `custom`, `builtin_openai_local_base`, or `other`; only `codex_model_router_v2` is pass, legacy/custom are warn, and built-in `openai` pointing at local base is fail.
- Version bumped from `3.16.2-5` to `3.16.2-6` to avoid overwriting a running `3.16.2-5` raw exe during export. New export artifacts: raw exe `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti\windows\raw-exe\CCSwitchMulti_3.16.2-6_x64.exe` SHA256 `B72790130A30692D2BB83BA68B12F4BE05DD2DEAA62F0327A49DF854E40C2231`; installer `...\installer\CCSwitchMulti_3.16.2-6_x64-setup.exe` SHA256 `70A2D0B1BF7772AF9F5D01EC7C934074577B61A64046D10D1B067D5B86CB2D2B`.

## 2026-06-14 Codex Desktop current history repair built into CCSwitchMulti

- Historical note now superseded by 2026-06-23 evidence: one 26.609 local repair succeeded against `~/.codex/sqlite/state_5.sqlite`, but that path must not be treated as the universal default. Current automatic detection prefers configured sqlite homes, then `~/.codex/state_5.sqlite`, with the sqlite subdir kept only as a compatibility fallback.
- CCSwitchMulti now exposes a full `repair_codex_history_visibility` Tauri command and a MultiRouter page button labeled "修复历史显示". The UI first runs `dryRun=true`, shows the active DB/provider/user-event/index/hints/projectless/focus/mtime counts, then asks for explicit confirmation before apply.
- The Rust repair path targets `codex_model_router_v2` by default, treats `openai`, `custom`, `cc_switch_codex_router`, `codex_model_router`, and collected trusted legacy ids as source buckets, and does not switch MultiRouter runtime back to built-in `openai`.
- The repair is broader than provider bucket sync: it resolves the active Desktop sqlite DB, rewrites provider buckets, updates rollout first-line metadata, backfills `has_user_event` from rollout user messages, appends/moves `session_index.jsonl`, repairs `.codex-global-state.json` workspace hints, removes repaired ids from `projectless-thread-ids`, optionally saves/focuses a project root, and touches focused rollout mtimes.
- Regression coverage: `active_state_db_prefers_codex_root_over_sqlite_subdir`, `active_state_db_falls_back_to_sqlite_subdir`, and `repairs_current_desktop_history_visibility_end_to_end` cover root-default detection, sqlite-subdir fallback, `\\?\` cwd normalization, provider/user-event repair, session index append/move, workspace hints/projectless cleanup, saved root insertion, rollout first-line rewrite, and mtime touch.

## 2026-06-14 Codex MultiRouter history repair UI module

- The history repair trigger is no longer only a hidden status-page action. `CodexRouterWorkspacePage` has a dedicated `history` tab labeled `历史修复`, plus a top header shortcut and a status-page shortcut that only navigate to that tab.
- The `历史修复` tab replaces the old `window.prompt` flow with an optional project-root input, `预览修复`, and `确认写入`. Apply is disabled until the current project path has a matching dry-run preview, so changing the path cannot accidentally reuse stale counts.
- The tab surfaces the real backend repair evidence: current MultiRouter plan, Codex takeover state, returned `targetProvider`, active DB path/kind, live config provider, source buckets, visible window counts, backup dir, skipped reason, and per-area counts for provider/user-event/session_index/workspace hints/projectless/focus/mtime/saved roots.
- MultiRouter route editing jitter/display cut-off was traced to the nested route editor dialog in `CodexFormFields.tsx`: content used scroll classes without a stable flex-height parent. The dialog now has `max-h-[90vh] overflow-hidden`, and its body is `flex-1 min-h-0 overflow-y-auto`, so long route forms scroll inside the modal instead of resizing the viewport.

## 2026-06-15 CCSwitchMulti 3.16.2-18 GitHub release

- After adding the dedicated history repair tab, do not reuse the existing `v3.16.2-17` release because that tag points at older commit `02bd8a2a`. The release commit for the history repair UI module is `257e4e54`, tagged and pushed as `v3.16.2-18` on `BigStrongSun/cc-switch`.
- Published GitHub Release: `https://github.com/BigStrongSun/cc-switch/releases/tag/v3.16.2-18`, marked Latest. Uploaded Windows assets: `CCSwitchMulti_3.16.2-18_x64-setup.exe`, `CCSwitchMulti_3.16.2-18_x64-portable.zip`, `CCSwitchMulti_3.16.2-18_x64.exe`, and `SHA256SUMS-v3.16.2-18.txt`.
- SHA256: setup exe `23A5D89CE4C80C78AFC5A55CD7EDA7EAF8DB22BA07B58F1FF8468A0C9FF6B707`; portable zip `C686C1048F5DE1000ABC1D553F6572C72490A09CA0ECB8CD5C0255D965D5B0B9`; raw exe `E0982F380BD44C45EFD1C22AB20208708A4DCDE6CC0AC562453F31999A489E36`.
- `pnpm release:export` succeeded for `3.16.2-18`, but the export root could not clear an old locked `CCSwitchMulti_3.16.2-17_x64.exe`. Future release uploads should stage only the exact target-version assets and a version-specific checksum file instead of uploading the export root wholesale.
- The fork currently shows no GitHub Actions runs after the tag push, so additional Linux/macOS assets will not appear automatically unless Actions are enabled/fixed or those platforms are built and uploaded separately.

## 2026-06-15 CCSwitchMulti 3.16.2-18 Linux release assets

- To match the existing `v3.16.2-17` release shape, Linux x86_64 packages were built in WSL from clean tag `v3.16.2-18` using `pnpm tauri build --bundles appimage,deb,rpm --config <no-updater-artifacts>`. The first attempt failed because the background PATH omitted `~/.cargo/bin`; after adding `/home/openclaw/.cargo/bin`, the build completed.
- Uploaded additional GitHub Release assets to `https://github.com/BigStrongSun/cc-switch/releases/tag/v3.16.2-18`: `CCSwitchMulti_3.16.2-18_amd64.AppImage`, `CCSwitchMulti_3.16.2-18_amd64.deb`, and `CCSwitchMulti-3.16.2-18-1.x86_64.rpm`. `SHA256SUMS-v3.16.2-18.txt` was replaced with a combined Windows+Linux checksum file.
- Linux SHA256: AppImage `011B242C77A870086F684F96842755877E824D57D2C7A1F8B78AA4781C9EBC7A`; deb `730DDD58EA2D72347E7E2CAA987443D5390B43FC6C03D523433B4E95B9DDDDD8`; rpm `232D9CF6E4376BE315B332D06C90661F723C2B24152B0222DCFCD2366B01AF0B`.
- GitHub release verification after upload shows 7 assets total: Windows setup/portable/raw exe, Linux AppImage/deb/rpm, and the combined checksum file. macOS was not produced in this Windows/WSL pass because it needs a macOS runner plus Apple signing/notarization credentials, and the fork still does not expose runnable Actions via `gh workflow list`.

## 2026-06-15 README fork-positioning update

- `README.md` now opens as `CCSwitchMulti` instead of plain upstream `CC Switch`, and the top version/download badges point to the fork release page `BigStrongSun/cc-switch`.
- A new front matter section, `CCSwitchMulti Branch Notice`, explains that this repository is a downstream branch of official CC Switch and that the remaining README still contains inherited upstream documentation.
- The branch notice documents the fork-specific Codex features: `OpenAI Multi-Model Router`, `settings_config.modelCatalog`, `settings_config.codexRouting`, stable `codex_model_router_v2` runtime bucket, Codex Desktop picker unlock/Statsig filtering diagnostics, history visibility repair, and the external OpenAI-compatible API sidecar.
- The usage notes intentionally warn that catalog visibility is not the same as upstream request success, Codex Desktop may need a full restart or CCSwitchMulti unlock flow, picker unlock is runtime renderer injection rather than an on-disk `app.asar` patch, router-owned TOML must not be placed in shared Codex common config, MultiRouter must not be routed through built-in `openai`/`openai_base_url`, and the Codex takeover port is distinct from the sidecar API port.

## 2026-06-15 CCSwitchMulti 3.16.2-19 fork updater and standalone Codex history repairer

- The updater must use the fork release feed, not upstream `farion1231/cc-switch`: `src-tauri/tauri.conf.json` now points to `https://github.com/BigStrongSun/cc-switch/releases/latest/download/latest.json`, and the fallback update page plus About links point to `BigStrongSun/cc-switch`.
- The standalone Codex history repairer is a Windows GUI binary declared as `codex-history-repairer` in `src-tauri/Cargo.toml` behind the `history-repairer` feature. Keep `autobins = false`, otherwise Tauri can accidentally bundle the helper as the main app.
- The GUI calls `repair_codex_history_visibility_standalone`, which reads the live `~/.codex/config.toml` top-level `model_provider` when the target provider field is empty, falls back to `codex_model_router_v2`, auto-detects the active state DB with configured sqlite homes before the default `~/.codex/state_5.sqlite` and legacy sqlite-subdir fallback, and uses source buckets `openai`, `custom`, `codex_model_router_v2`, `cc_switch_codex_router`, and `codex_model_router`.
- Write mode blocks while Codex Desktop/app-server is running unless the GUI force option is enabled. This is intentional because current Desktop can rewrite `.codex-global-state.json` and SQLite WAL state during repair.
- Export script `scripts/export-latest-ccswitchmulti.ps1` now builds the helper with `cargo build --bin codex-history-repairer --features history-repairer --release`, copies it under `tools/codex-history-repairer`, manually signs the NSIS setup with `~/.ccswitchmulti/tauri-update.key`, writes `latest.json`, and stages release assets from the versioned export directory.
- Published release: `https://github.com/BigStrongSun/cc-switch/releases/tag/v3.16.2-19`. Required assets are present: Windows setup, setup signature, portable zip, raw exe, standalone `CodexHistoryRepairer_3.16.2-19_x64.exe`, `latest.json`, notes, and `SHA256SUMS.txt`.
- Verification performed for this release line: `pnpm typecheck`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, `cargo test --manifest-path src-tauri\Cargo.toml standalone_repair_defaults_target_to_live_config_provider --lib`, `cargo test --manifest-path src-tauri\Cargo.toml repairs_current_desktop_history_visibility_end_to_end --lib`, and `cargo build --manifest-path src-tauri\Cargo.toml --bin codex-history-repairer --features history-repairer --release`.

## 2026-06-15 Codex history repair latest-script parity

- User screenshot showed `v3.16.2-19` still did not surface all repaired sessions. Root cause: the built-in Rust repair and `repair-codex-history-current-desktop.ps1` reproduced active DB/provider/user-event/index/hints/focus/mtime, but missed the later successful `balance-codex-history-recent-window.ps1 -MaxPerProject 10 -MaxTotal 300 -SourceFilter vscode -SyncRolloutMtime` step. Codex Desktop first takes a limited global recent thread window and only then groups by workspace, so current-project focus alone can still leave sessions outside the sidebar window.
- The repair backend now supports `balance_recent_window`, `max_per_project`, `max_total`, and `source_filter`. Visibility filtering uses the provider after planned bucket migration, so rows currently under `openai/custom/legacy` are counted before the write instead of disappearing from the preview.
- The balanced repair keeps the current project focus count as a floor, then round-robins remaining visible rows by normalized `cwd` with per-project and total caps. The MultiRouter history tab and standalone GUI default to `sourceFilter="vscode"`, `maxPerProject=10`, and `maxTotal=300` to match the successful Desktop-sidebar repair path.
- The rollout metadata repair now scans all JSONL lines with `payload.model_provider`, not only the first `session_meta` line, and restores the previous rollout file mtime after provider metadata rewrite; only the explicit focus/balanced mtime step changes sidebar ordering.
- `session_index.jsonl` repair now overwrites stale `thread_name` for selected rows and reports `sessionIndexTitles*` counts. Regression tests cover provider-after visibility, multi-project recent-window balancing, source filter behavior, stale title overwrite, and multi-line rollout provider rewrite.
- Verification passed: `cargo test --manifest-path src-tauri\Cargo.toml codex_history_migration::tests --lib -- --nocapture`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, `pnpm typecheck`, and `cargo build --manifest-path src-tauri\Cargo.toml --bin codex-history-repairer --features history-repairer --release` (existing unrelated `commands/misc.rs` dead_code warnings only).

## 2026-06-15 CCSwitchMulti 3.16.2-20 history repair productization

- The current productized history-repair baseline is the latest successful balanced-window flow, not the older provider-only repair: active DB resolution must auto-detect configured sqlite homes, then default `~/.codex/state_5.sqlite`, then legacy `~/.codex/sqlite/state_5.sqlite`; repair targets must follow live `config.toml` or `codex_model_router_v2`, and the default visibility path is `sourceFilter="vscode"`, `maxPerProject=10`, `maxTotal=300`, with rollout mtime sync.
- CCSwitchMulti now adds `list_codex_history_sessions` and extends `repair_codex_history_visibility` with `codexHome`, `stateDbPath`, and `sessionIds`. The history tab can set Codex home, list active SQLite session summaries, search/filter records, select specific sessions for targeted recovery, or leave selection empty to run the balanced project/global recent-window repair.
- The Rust repair runtime treats nonempty `sessionIds` as an explicit focus set: provider/user-event repair still covers visible candidates, but focus movement, session_index move, workspace hints, and rollout mtime touch only apply to selected sessions; balanced recent-window reporting is disabled in that targeted mode. Regression coverage: `selected_session_ids_focus_only_requested_rows`.
- Standalone delivery is no longer a Windows GUI exe in the export pipeline. `scripts/codex-history-tool/codex_history_tool.py` is a standard-library Python tool with `list` and `repair` subcommands, exported under `tools/codex-history-tool` with README; `scripts/export-latest-ccswitchmulti.ps1` no longer builds or copies `codex-history-repairer.exe` and excludes `__pycache__`/`.pyc`.
- Version bumped to `3.16.2-20`; `pnpm release:export` produced `CCSwitchMulti_3.16.2-20_x64-setup.exe`, `.sig`, portable zip, raw exe, `latest.json`, and the Python history tool in `C:\Users\sunda\Documents\LLMservice\最新版ccswitchmulti`. The export still warned that an old `CCSwitchMulti_3.16.2-17_x64.exe` was locked, but the target-version artifacts and tool checksums were written.
- Verification passed: `python -m py_compile scripts\codex-history-tool\codex_history_tool.py`, Python `list --limit 3 --json`, Python repair dry-run for `C:\Users\sunda\Documents\LLMservice`, `cargo check --manifest-path src-tauri\Cargo.toml --lib`, `cargo test --manifest-path src-tauri\Cargo.toml codex_history_migration::tests --lib -- --nocapture`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, `pnpm typecheck`, `pnpm history:tool:check`, and `pnpm release:export`.

## 2026-06-16 CCSwitchMulti Codex history repair moved into Session Manager

- Supersedes the 2026-06-14 MultiRouter history tab placement: the product UI for Codex history repair now belongs in `src/components/sessions/SessionManagerPage.tsx` behind the Codex-only FileClock toolbar button, not in `CodexRouterWorkspacePage.tsx`. The MultiRouter workspace page no longer exposes a history repair tab/button and its old inline repair component was removed to prevent reviving stale provider-only UI.
- The built-in repair flow is implemented by `src/components/sessions/CodexHistoryRepairPanel.tsx`. It keeps the latest successful baseline defaults (`sourceFilter="vscode"`, `maxPerProject=10`, `maxTotal=300`, balanced recent window, auto-detected active state DB, rollout mtime sync), adds light default path hints, source/provider count panels, target-provider dropdown candidates, and SQLite-backed session selection.
- The Tauri backend now exposes `read_codex_history_session` so the Session Manager repair panel can inspect a selected SQLite session by following `threads.rollout_path` and parsing the local Codex JSONL into existing `SessionMessage` rows. `list_codex_history_sessions` also returns `sourceCounts`, `providerCounts`, and `targetProviderCandidates`.
- Built-in `repair_codex_history_visibility_for_multirouter` now matches the standalone/Python behavior when `targetProvider` is empty: prefer live `~/.codex/config.toml` top-level `model_provider`, then fall back to `codex_model_router_v2`. This avoids repairing the active third-party provider's history back into official `openai`.
- Regression coverage added: `multirouter_repair_defaults_target_to_live_config_provider`, `list_history_sessions_returns_provider_source_candidates_and_all_sources`, and `read_history_session_loads_rollout_messages_from_sqlite_path`. Verification passed: `cargo test --manifest-path src-tauri\Cargo.toml codex_history_migration::tests --lib -- --nocapture`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, targeted Prettier check for changed frontend files, `pnpm typecheck`, and `pnpm build:renderer`.

## 2026-06-16 CCSwitchMulti 3.16.2-21 provider edit route stability

- MultiRouter provider edit page route rows disappearing/jittering was traced to frontend state timing, not backend route persistence: `useCodexConfigState` initialized Codex catalog/routing to empty and only filled them in an effect, while `CodexFormFields` could echo the first-frame empty child rows back to the parent and overwrite loaded routes.
- The fix initializes auth/config/baseUrl/catalog/spawnAgent/routing synchronously from `initialData`, keeps prop-change keys for catalog/routing, and skips child-to-parent echo during external provider loads until local rows match the incoming state. The route list now keeps a stable empty-state container instead of collapsing, and the duplicate local-routing toggle was removed from Advanced Options.
- The wrong MultiRouter-page history-repair link remains removed; Codex history repair stays in Session Manager behind the Codex-only FileClock entry, using the 2026-06-15 balanced recent-window repair baseline.
- Export script hardening: `scripts/export-latest-ccswitchmulti.ps1` now copies only the current setup artifact's `.sig`, so stale signatures from older bundle outputs cannot leak into `SHA256SUMS.txt` or release staging.
- Version `3.16.2-21` was built/exported. Clean export path: `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.2-21`. The normal `最新版ccswitchmulti` export path also received target-version artifacts, but an already running `CCSwitchMulti_3.16.2-20_x64.exe` kept old files locked, so the clean release handoff should use the versioned export directory.
- Verification passed: `pnpm typecheck`, `pnpm build:renderer`, `cargo check --manifest-path src-tauri\Cargo.toml --lib`, `cargo fmt --manifest-path src-tauri\Cargo.toml --check`, locale JSON parse check, `git diff --check`, and full `pnpm release:export` plus clean `-SkipBuild` export. Browser dev-mode UI inspection confirmed the Codex add-provider form has the new route empty state, no old Advanced hint, no visible MultiRouter history-repair link, and the expected local routing control; true desktop v21 UI inspection was blocked by Tauri single-instance because v20 was still running.

## 2026-06-17 MultiRouter spawn_agent candidate ordering placement

- `settingsConfig.modelCatalog.spawnAgentModels` is route/catalog configuration, so the MultiRouter candidate ordering UI belongs in `CodexRouterWorkspacePage` RoutesTab, not StatusTab.
- The route-rule panel copy should state that the first 5 models are the Codex `spawn_agent` visible models and can be drag-sorted. Both the preview window and the sortable draft list should visually highlight those first five candidates.
- StatusTab should not expose candidate editing controls (`保存排序`, `校验候选`, drag list, candidate source tabs). Keep it focused on link readiness, diagnostics, provider targets, traffic, router logs, and model-picker unlock evidence.

## 2026-06-17 MultiRouter workbench dedupe and External API multi-key credentials

- The MultiRouter top workbench should stay compact and action-oriented. Keep only the short positioning text plus create/manage/status navigation buttons there; link readiness, local listener, Codex takeover, enabled rules, diagnostics, traffic attribution, router logs, and picker evidence belong in StatusTab.
- Do not revive the removed "操作记录" tab, and do not move `modelCatalog.spawnAgentModels` editing back into StatusTab. Candidate ordering remains route/catalog configuration under RoutesTab after commit `057b43f7`.
- External OpenAI-compatible / third-party Agent API credentials now support multiple local `ccsw_` keys. New profile JSON stores key records in `apiKeys` with id, plaintext local sidecar key, prefix, and created_at so the UI can list, copy again later, and delete old keys.
- Compatibility boundary: `api_key_hash` / `api_key_prefix` are still maintained for the latest generated key and legacy hash-only profiles. A legacy profile with only hash material is shown as a non-copyable legacy key because plaintext was never stored; it can still be deleted. Deleting the last new-format key must also clear the compatibility hash so a removed key cannot continue authenticating.
- Security boundary: the reusable plaintext key is only the CCSwitchMulti-generated local `ccsw_` sidecar credential. Upstream OAuth tokens, refresh tokens, and real provider API keys are not exposed through the External API credentials page.

## 2026-06-16 CCSwitchMulti Session Manager history repair primary layout

- User feedback after the Session Manager move: the Codex history repair entry was still too hidden and the repair UI looked like an awkward utility panel. The product decision is now stronger: when `SessionManagerPage` is opened for Codex, history repair is the default primary workspace, with an explicit two-button switch for `历史修复` and `会话浏览` in the session list header.
- `CodexHistoryRepairPanel` now presents a single repair workbench instead of stacked cards: top action bar for load/preview/apply, status tiles for active DB / loaded-selected count / write state, a compact horizontal path-and-scope settings band, then SQLite history, session JSONL preview, and repair evidence columns. This keeps the latest balanced-window repair defaults visible without making the user hunt for the entry.
- The panel auto-loads active SQLite only when the Tauri runtime is present, so the real desktop app starts with useful history data while browser/dev preview does not show a false `invoke` error.
- Verification passed: targeted Prettier check, `pnpm typecheck`, `pnpm build:renderer`, and Browser dev-mode inspection at `http://127.0.0.1:3000/`. Browser DOM confirmed visible `历史修复` / `会话浏览` buttons, default Codex history repair main area, no development `invoke` error, and no horizontal overflow at 1280 px.

## 2026-06-16 CCSwitchMulti 3.16.2-22 release

- Version bumped to `3.16.2-22` for the Session Manager history-repair layout release. Export root: `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.2-22`.
- Release export verification: `latest.json` reports `3.16.2-22`, `SHA256SUMS.txt` contains only v22 Windows binaries, and the export includes setup exe/signature, portable zip, raw exe alias/versioned exe, platform build notes, README, and `tools/codex-history-tool`.
- Verification before release: targeted Prettier check, `pnpm typecheck`, `pnpm history:tool:check`, `cargo check --manifest-path src-tauri\Cargo.toml --lib`, and `scripts\export-latest-ccswitchmulti.ps1 -ReleaseRoot ...3.16.2-22`. Rust still only reports the existing `commands/misc.rs` dead_code warnings.

## 2026-06-21 MultiRouter route-rule picker

- `CodexRouterWorkspacePage` RoutesTab must not route “编辑匹配规则” into the generic Provider edit form. That form exposes the low-level `codexRouting.routes` editor and the old “添加 route” path can freeze or produce an unusable workflow for MultiRouter rule editing.
- Route-rule editing in the MultiRouter workspace is now an in-page candidate router picker: it merges existing routes with all non-routing Codex model sources, lets the user directly select/enable candidate routers, and writes only `settingsConfig.codexRouting.routes` through `providersApi.update(nextProvider, "codex")`.

## 2026-06-21 MultiRouter provider edit entry

- Codex MultiRouter providers in the main provider list must not open `EditProviderDialog` / generic `ProviderForm`. The generic form is only for normal upstream providers and can still expose the legacy route editor path where “添加 route” freezes.
- Main-list edit, and any workspace edit action for a routing plan, should navigate to `CodexRouterWorkspacePage` with that provider selected and `initialTab="routes"`. The dedicated workspace owns route selection, enabled state, model catalog, and spawn-agent candidate persistence.

## 2026-06-21 WebDAV/S3 sync portability

- WebDAV/S3 database sync must not blindly upload machine-specific absolute paths or keys when sharing a profile across devices. Sync export rewrites the current user home path to `${CC_SWITCH_HOME}` and import localizes that token, plus common `C:\Users\<other>` / `/Users/<other>` / `/home/<other>` paths, to the receiving machine.
- `includeKeysOnUpload` controls whether provider/API/MCP keys remain in the uploaded SQL snapshot. When disabled, key/token/password values are stripped while auth mode and routing structure are preserved so the receiving user can fill their own credentials.
- New route candidates should reference `targetProviderId` and `auth.source="provider_config"` instead of copying API keys or Base URLs. This preserves model-source ownership and keeps the workspace from scattering provider credentials into route rows.
- Verification passed for this change: targeted Prettier write/check on `src/components/codex/CodexRouterWorkspacePage.tsx`, `pnpm typecheck`, `git diff --check`, and `pnpm build:renderer`. Build still reports the existing browserslist/baseline staleness and large chunk warnings only.

## 2026-06-22 CCSwitchMulti v3.16.3-8 merge release preparation

- Purpose: make the next release a full successor by merging the `v3.16.3-5` release line into the `v3.16.3-7` MultiRouter/context-window line, instead of treating `v3.16.3-7` as a standalone targeted prerelease.
- Merge strategy: use a real git merge so the history records both parents. This preserves the official v3.16.3 merge, takeover restore preservation fix, unified history repair safeguards, and the newer MultiRouter/WebDAV/context-window changes.
- Version surfaces for the merged release must be `3.16.3-8` in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.
- Release rule: do not retag or force-update `v3.16.3-7`; publish the merged successor as a new tag/release.

## 2026-06-24 CCSwitchMulti v3.16.3-14 follow-up product fixes

- MultiRouter official/Codex fallback model catalog must carry explicit context windows. When an OpenAI/Codex OAuth provider has no real model catalog, fallback entries should be `gpt-5.5=272000`, `gpt-5.4=272000`, `gpt-5.4-mini=128000`, and `gpt-5.3-codex-spark=128000`; otherwise Codex Desktop can fall back to its 128k-ish display budget and users report GPT-5.5 as only about 122k context.
- The usage dashboard historically had rollup/prune maintenance but no user-triggered "clear logs" product path. The correct clear operation deletes `proxy_request_logs` and `usage_daily_rollups` only, preserving provider records, pricing rows, auth material, and app config.
- Port conflicts on 15721/15722 are real multi-instance/old-process failure modes. The low-risk product fix is to surface an actionable `AddrInUse` diagnostic naming CCSwitchMulti/old process/alternate port; a stronger cross-process singleton lock is separate work and should not be mixed into takeover restore logic casually.
- Codex Desktop model-picker unlock should not treat the CLI `codex.exe` as Desktop. Desktop executable discovery may include WindowsApps package layouts (`app/Codex.exe`, `app/resources/Codex.exe`, package root `Codex.exe`) and `%LOCALAPPDATA%\OpenAI\Codex`, but should avoid launching lowercase CLI paths. Launch should re-check whether Codex Desktop is already running before starting with CDP flags.
- OAuth token dual-store remains a risk boundary, not a solved low-risk fix: `~/.codex/auth.json` and CCSwitchMulti `codex_oauth_auth.json` can diverge. Do not blindly copy managed refresh tokens into Codex Desktop auth as a "sync" fix without proving rotation/account semantics; prefer preserving Codex login material and using managed OAuth only for proxy forwarding/quota paths.

## 2026-06-25 CCSwitchMulti v3.16.3-20 prerelease for MultiRouter model-refresh hang

- User screenshot with "候选 provider 模型列表刷新" cards stuck at "正在读取模型列表..." was a release-boundary issue first: public `v3.16.3-19` points at `6a1cf4e1` and does not include `ddfeed42` / `33a0bc58`, while the fixed local line is `4f1f911c` after `ddfeed42`, `33a0bc58`, and `272d02a3`. Future reports with the same UI should first check installed version/tag before debugging official Responses routing or upstream `/models`.
- Published prerelease `https://github.com/BigStrongSun/ccswitchmulti/releases/tag/v3.16.3-20`. Annotated tag `v3.16.3-20` dereferences to `4f1f911cae3ea13f78412c720854ab87201ee7c7`; release is non-draft and prerelease=true. Release notes are Chinese and explicitly describe the model-list loading hang, per-provider attempt tracking, API-key-sensitive stale request suppression, 30 second frontend timeout, and visible-model vs upstream-model split.
- Windows assets came from the local export pipeline at `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-20` and flat upload staging at `C:\Users\sunda\Documents\LLMservice\ccswitchmulti-release-v3.16.3-20-assets`. Raw exe `CCSwitchMulti_3.16.3-20_x64.exe` reports ProductVersion/FileVersion `3.16.3-20`; `RELEASE-METADATA.md` records commit `4f1f911c`.
- Linux assets were built locally in WSL distro `openclaw` from `/home/openclaw/ccswitchmulti-linux-build-v3.16.3-20`, after cloning the fork tag and verifying HEAD equals `4f1f911c`. Commands used Linux Node path `/home/openclaw/.local/node-v22.22.2-linux-x64/bin`, `pnpm install --frozen-lockfile --prefer-offline`, `cargo build --manifest-path src-tauri/Cargo.toml --bin codex-history-repairer --features history-repairer --release`, and `pnpm tauri build --bundles appimage,deb,rpm --config <createUpdaterArtifacts=false>`. The build succeeded; only the final `sha256sum` list command failed from CRLF glob input after artifacts had already been copied to Windows staging.
- macOS universal assets were produced by GitHub Actions run `28169469534` (`supplemental-macos-release.yml`) against `v3.16.3-20`; it completed successfully and uploaded `CCSwitchMulti_3.16.3-20_universal.tar.gz`, `.tar.gz.sig`, and `.app.zip`. This workflow also refreshed `SHA256SUMS.txt`.
- Final release has 12 assets: Windows setup/signature/portable/raw exe, Linux AppImage/deb/rpm, macOS universal tar/signature/app zip, `latest.json`, and `SHA256SUMS.txt`. Final `SHA256SUMS.txt` covers all release assets except itself; GitHub asset digests matched the local Windows/Linux checksums and workflow-produced macOS digests.
- Known non-blocking warnings in this release remain the existing Vite baseline/browserslist/chunk warnings, Rust unused/dead_code warnings, and Tauri `__TAURI_BUNDLE_TYPE variable not found` bundler warning. Fork push still triggers failing generic CI/release workflows, but manual local/WSL build plus supplemental macOS workflow are the verified publishing path for this prerelease.

## 2026-06-28 MultiRouter duplicate visible model semantics

- If OpenAI official and a third-party relay both expose the same visible model id such as `gpt-5.5`, MultiRouter does not infer quality, provider type, price, or freshness. Route order is the control surface.
- Frontend catalog generation in `CodexRouterWorkspacePage::buildModelCatalogForRoutes` uses a `Map` keyed by visible `model`; while iterating routes in order, the first route/source that contributes `gpt-5.5` wins and later same-id entries are skipped. The picker and `spawn_agent` catalog therefore show one `gpt-5.5`, not one per upstream.
- Runtime route resolution in `src-tauri/src/proxy/providers/codex.rs` uses `routes.iter().find(...)` over enabled routes. Exact `match.models` and prefix matches are case-insensitive, but duplicate exact matches still choose the first matching route in the saved `codexRouting.routes` array.
- `defaultRouteId` is only used when no enabled route matches the requested visible model. It does not override a duplicate exact match and does not choose between two `gpt-5.5` routes.
- The public helper `resolve_codex_model_routed_providers` can produce a primary route plus other enabled route candidates for future fallback use, but current forwarder code calls the single-provider wrapper `resolve_codex_model_routed_provider`, which takes `.next()`. Current HTTP routing therefore uses only the first resolved route inside the selected MultiRouter provider; it is not round-robin or automatic same-model failover.
- Upstream model rewriting is separate from route selection. Route `modelMap` / `upstreamModel` / `model` writes `codexResolvedUpstreamModelOverride` and takes priority; otherwise the catalog model's `upstreamModel` can rewrite the outbound body model. If neither exists, the visible request model is preserved for matched routes. For an unmatched fallback-style routed provider, Chat conversion forces the route/provider's own configured model so `gpt-5.5` is not blindly sent to DeepSeek/Qwen.
- Recommended configuration when a third-party relay provides an upstream named `gpt-5.5`: use a distinct visible alias such as `gpt-5.5-relay` with `upstreamModel="gpt-5.5"` if users need both official and relay selectable at the same time. If both are intentionally the same visible `gpt-5.5`, put the desired primary route first and treat the duplicate as shadowed unless the route order is changed.
- Live diagnosis on 2026-06-28: both `codex-multirouter` and `codex-openai-router` had official GPT routes before aggregate-platform routes, with broad prefixes (`gpt` or `gpt-`). A request for `gpt-5.5-pro` therefore matched the official route by prefix and was sent to ChatGPT Codex OAuth, producing "model is not supported when using Codex with a ChatGPT account" instead of using a third-party relay. The locally configured aggregate provider `yansd666带gpt官方模型` did not expose `gpt-5.5-pro` in `/models`; direct `/responses` and `/chat/completions` calls with `model=gpt-5.5-pro` both returned HTTP 503 "无可用渠道", so that provider currently supports `gpt-5.5` but not `gpt-5.5-pro`.
- When a MultiRouter route references `targetProviderId`, `materialize_codex_routed_provider_from_target` deliberately follows the target provider's `base_url`, auth, and `apiFormat`; the route row only carries route identity/capabilities/model override. For an aggregate platform that mixes native Responses-compatible GPT models with Chat-Completions-only third-party models, use separate provider entries or route-level inline upstreams per protocol. Do not rely on one global "需要本地路由映射" switch to represent both protocols at once.

## 2026-06-28 MultiRouter route-rule picker duplicate provider fix

- Editing an old MultiRouter after adding new normal providers can show duplicate Qwen/DeepSeek rows when the saved route is legacy/inline and the new provider-backed candidate has the same semantic model source. The root is not backend routing: the workspace candidate builder only deduped by `targetProviderId`, while legacy routes may have no target or may have lost `route.provider` during `normalizeLegacyCodexRoutingRoute`.
- The frontend fix is to preserve legacy `route.provider` / `upstream.provider` as `targetProviderId`, and to dedupe routes by semantic provider before rendering route entries, building candidate picker rows, and saving `codexRouting.routes`. Semantic matching falls back to normalized provider name/id and model/prefix overlap only when no explicit target provider exists.
- New provider candidates in `RouteCandidatePicker` should be directly actionable: clicking the right-side `启用` button on an unchecked candidate now selects and enables it in one step. Do not reintroduce `disabled={!checked || isSaving}` for that button, or users will again need to click `全选并启用` before adding one provider.
- Regression coverage lives in `src/components/codex/CodexRouterWorkspacePage.test.ts`: legacy provider references are preserved/deduped, and a new provider candidate can be enabled and saved without using global select-all. Verified with `.\node_modules\.bin\vitest.cmd run src/components/codex/CodexRouterWorkspacePage.test.ts`, `.\node_modules\.bin\tsc.cmd --noEmit`, and targeted Prettier check.

## 2026-06-28 MultiRouter gpt-5.5-pro source boundary

- When investigating a report that `gpt-5.5-pro` was "fetched", first distinguish model catalog acquisition from Codex runtime request input. The user screenshot of the yansd666 provider's model mapping showed `gpt-5`, `gpt-5-codex`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.3-codex-spark`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, and `gpt-image-2`; it did not show `gpt-5.5-pro`.
- For a new empty yansd666 Codex provider, clicking "获取模型列表" can still populate those official-looking GPT ids because `https://yansd666.com/v1/models` itself returns exactly those 9 ids for the configured account/key. Direct checks with default UA and a browser-like Mozilla UA both returned the same 9 ids and did not return `gpt-5.5-pro`.
- Live DB verification on `~/.cc-switch/cc-switch.db` found no `gpt-5.5-pro` string in current providers, including `yansd666带gpt官方模型` and the active `codex-openai-router`. `~/.codex/cc-switch-model-catalog.json` and `~/.codex/models_cache.json` also did not contain `gpt-5.5-pro`; the only live `~/.codex/state_5.sqlite` hits were Codex thread/task text created while debugging the screenshot.
- The model fetch path is literal: `fetchModelsForConfig` calls Tauri `fetch_models_for_config`, which calls `src-tauri/src/services/model_fetch.rs::fetch_models`; the backend parses OpenAI-compatible `/models` entries into `FetchedModel.id` and sorts them, without synthesizing `-pro` suffixes. Frontend merge paths in `CodexFormFields` and `CodexRouterWorkspacePage::providerWithFetchedModelCatalog` add fetched ids as `{ model: id, upstreamModel: id, displayName: id }`, and also do not generate `gpt-5.5-pro`.
- `providerWithFetchedModelCatalog` is additive: it updates context windows and appends new remote ids but does not prune models that disappeared from `/models`. Therefore a stale `gpt-5.5-pro` can persist on another user's machine if their provider catalog previously contained it or they manually added it, but that was not the state on this machine during the 2026-06-28 check.
- The observed toast saying `model: gpt-5.5-pro` was a runtime request boundary: Codex Desktop sent `/responses` with `model=gpt-5.5-pro`; the then-current router matched broad official GPT prefixes before the later aggregate route and sent it to ChatGPT Codex OAuth. After commit `bbe9d93d`, exact route matches take precedence globally over earlier prefixes, but if no exact `gpt-5.5-pro` route/catalog exists, a broad prefix can still be the intended fallback behavior.

## 2026-06-28 Codex official login preservation on provider switch

- The user-facing bug "switch provider, then official Codex asks to log in again" is a non-takeover `auth.json` overwrite problem, not an official-login bypass problem. Before this fix, `codex_config::write_codex_live_for_provider` still wrote non-official provider `auth.OPENAI_API_KEY` into `~/.codex/auth.json` when `preserve_codex_official_auth_on_switch=false`, and switching back to official could write a stale DB OAuth snapshot over the current live OAuth auth.
- Correct rule: third-party Codex provider switches should always leave `~/.codex/auth.json` alone and place the provider/API/proxy bearer in `config.toml` as `experimental_bearer_token`. Official switches should only write `auth.json` when live auth does not already contain real OAuth login material; if live auth has OAuth tokens, only refresh `config.toml`.
- Keep `codex_auth_has_oauth_login_material` separate from `codex_auth_has_login_material`: `OPENAI_API_KEY` is a provider token, not official login material. Do not treat third-party bearer keys as a reason to preserve/overwrite official OAuth auth.
- Regression coverage: `third_party_live_write_preserves_existing_codex_oauth_auth`, `official_live_write_preserves_current_oauth_auth_over_stale_db_snapshot`, updated `codex_custom_provider_live_write_preserves_oauth_auth_even_when_preserve_disabled`, plus existing takeover official return test `codex_switch_to_official_during_takeover_exits_proxy_and_cleans_router_fields`. Verified with targeted `cargo test --manifest-path src-tauri\Cargo.toml ... --lib` and `cargo fmt --manifest-path src-tauri\Cargo.toml --check`.
