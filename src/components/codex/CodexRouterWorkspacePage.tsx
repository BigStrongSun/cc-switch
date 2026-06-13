import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bug,
  CheckCircle2,
  Clipboard,
  Database,
  FileClock,
  GitFork,
  GitBranch,
  Info,
  Layers3,
  Pencil,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Route,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { proxyApi } from "@/lib/api/proxy";
import { useRequestLogs } from "@/lib/query/usage";
import { cn } from "@/lib/utils";
import type { Provider } from "@/types";
import type { RequestLog } from "@/types/usage";
import type {
  CodexDiagnosticCheck,
  CodexDiagnosticStatus,
  CodexHistoryProviderBucketSyncOutcome,
  CodexMultiRouterDiagnostics,
  CodexRouterLogEvent,
  ProxyStatus,
} from "@/types/proxy";

type WorkspaceTab =
  | "overview"
  | "sources"
  | "routes"
  | "status"
  | "test"
  | "records";

type StatusView = "link" | "debug" | "providers" | "traffic";

type CodexRoute = {
  id?: string;
  label?: string;
  enabled?: boolean;
  targetProviderId?: string;
  target_provider_id?: string;
  providerId?: string;
  provider_id?: string;
  upstreamProviderId?: string;
  upstream_provider_id?: string;
  provider?: string;
  match?: {
    models?: string[];
    prefixes?: string[];
  };
  upstream?: {
    baseUrl?: string;
    base_url?: string;
    apiFormat?: string;
    wireApi?: string;
    wire_api?: string;
    targetProviderId?: string;
    target_provider_id?: string;
    providerId?: string;
    provider_id?: string;
    upstreamProviderId?: string;
    upstream_provider_id?: string;
    provider?: string;
    auth?: {
      source?: string;
    };
  };
  capabilities?: {
    textOnly?: boolean;
    supportsReasoning?: boolean;
    inputModalities?: string[];
  };
};

type CodexRouting = {
  enabled?: boolean;
  defaultRouteId?: string;
  routes?: CodexRoute[];
};

type RouteRecord = {
  id: string;
  action: string;
  detail: string;
  time: string;
};

type RouteEntry = {
  provider: Provider;
  route: CodexRoute;
  index: number;
};

type RouteTrafficRow = {
  providerId: string;
  providerName: string;
  model: string;
  requestCount: number;
  successCount: number;
  failedCount: number;
  totalTokens: number;
  avgLatencyMs: number;
};

type RouteTrafficTarget = {
  providerId: string;
  providerName: string;
};

/// 从 Provider 私有配置里读取 Codex 多模型路由配置；没有配置时返回 null，避免把普通模型源误判成路由方案。
function readCodexRouting(provider: Provider): CodexRouting | null {
  const routing = provider.settingsConfig?.codexRouting;
  if (!routing || typeof routing !== "object") return null;
  return routing as CodexRouting;
}

/// 判断一个 Provider 是否已经承载 Codex 多模型路由；即使暂时关闭，只要有规则也归为路由方案方便继续编辑。
function isRoutingPlan(provider: Provider): boolean {
  const routing = readCodexRouting(provider);
  return Boolean(
    routing && (routing.enabled !== false || (routing.routes?.length ?? 0) > 0),
  );
}

/// 提取 route 的上游协议名，兼容历史字段和 UI 字段。
function routeApiFormat(route: CodexRoute): string {
  return (
    route.upstream?.apiFormat ??
    route.upstream?.wireApi ??
    route.upstream?.wire_api ??
    "openai_chat"
  );
}

/// 提取 route 引用的真实目标 Provider ID。
function routeTargetProviderId(route: CodexRoute): string | undefined {
  return [
    route.targetProviderId,
    route.target_provider_id,
    route.providerId,
    route.provider_id,
    route.upstreamProviderId,
    route.upstream_provider_id,
    route.provider,
    route.upstream?.targetProviderId,
    route.upstream?.target_provider_id,
    route.upstream?.providerId,
    route.upstream?.provider_id,
    route.upstream?.upstreamProviderId,
    route.upstream?.upstream_provider_id,
    route.upstream?.provider,
  ]
    .map((value) => value?.trim())
    .find(Boolean);
}

/// 查找 route 引用的真实目标 Provider。
function routeTargetProvider(
  route: CodexRoute,
  providersById: Map<string, Provider>,
): Provider | undefined {
  const targetProviderId = routeTargetProviderId(route);
  return targetProviderId ? providersById.get(targetProviderId) : undefined;
}

/// 提取 route 的上游地址；引用真实 Provider 时展示目标 Provider 的配置。
function routeBaseUrl(
  route: CodexRoute,
  providersById?: Map<string, Provider>,
): string {
  const target = providersById
    ? routeTargetProvider(route, providersById)
    : undefined;
  if (target) {
    const config = target.settingsConfig ?? {};
    return (
      config.base_url ??
      config.baseURL ??
      config.baseUrl ??
      `复用供应商配置：${target.name}`
    );
  }
  return (
    route.upstream?.baseUrl ?? route.upstream?.base_url ?? "继承模型源地址"
  );
}

/// 把内部认证枚举翻译成页面可理解的中文说明，避免把 provider_config 这类工程词直接丢给用户。
function authSourceLabel(source?: string): string {
  switch (source) {
    case "managed_codex_oauth":
      return "托管 Codex OAuth";
    case "managed_account":
      return "托管账号";
    case "provider_config":
      return "使用路由 API Key";
    default:
      return "继承模型源凭据";
  }
}

/// 把内部协议枚举翻译成用户能识别的接口类型。
function apiFormatLabel(format: string): string {
  switch (format) {
    case "openai_responses":
      return "OpenAI Responses";
    case "openai_messages":
      return "OpenAI Messages";
    case "openai_chat":
      return "OpenAI Chat";
    default:
      return format;
  }
}

/// 汇总 route 可匹配的模型名和前缀，用于列表和测试页展示。
function routeMatchSummary(route: CodexRoute): string {
  const models = route.match?.models?.filter(Boolean) ?? [];
  const prefixes = route.match?.prefixes?.filter(Boolean) ?? [];
  const parts = [
    models.length > 0 ? `精确模型：${models.join(", ")}` : "",
    prefixes.length > 0 ? `模型前缀：${prefixes.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join("；") || "尚未设置匹配条件";
}

/// 收集所有可被 Codex 请求命中的模型名，测试页会优先使用这些真实规则生成候选项。
function collectRouteModels(routes: RouteEntry[]): string[] {
  const modelNames = routes.flatMap(({ route }) => [
    ...(route.match?.models ?? []),
    ...(route.match?.prefixes ?? []).map((prefix) => `${prefix}*`),
  ]);
  return Array.from(new Set(modelNames.filter(Boolean)));
}

/// 判断请求模型是否命中某条 route；状态页用它把外层 router 日志重新归属到子 provider。
function routeMatchesModel(route: CodexRoute, model: string): boolean {
  const normalized = model.trim();
  if (!normalized) return false;
  const models = route.match?.models ?? [];
  const prefixes = route.match?.prefixes ?? [];
  return (
    models.includes(normalized) ||
    prefixes.some((prefix) => normalized.startsWith(prefix))
  );
}

/// 收集当前多路方案引用到的子 provider，避免状态页把普通 Codex provider 和 route target 混在一起。
function collectTargetProviderIds(
  routes: RouteEntry[],
  selectedPlan?: Provider | null,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of routes) {
    if (selectedPlan && entry.provider.id !== selectedPlan.id) continue;
    const targetProviderId = routeTargetProviderId(entry.route);
    if (targetProviderId) ids.add(targetProviderId);
  }
  return ids;
}

/// 为内联 route 生成稳定统计 ID。内联 route 没有真实 providerId，但在状态页里
/// 仍然应该作为一个“子 Provider”展示，否则 Qwen/DeepSeek 会被统计成 0。
function routeTrafficId(entry: RouteEntry): string {
  const routeId =
    entry.route.id?.trim() ||
    entry.route.label?.trim() ||
    `route-${entry.index + 1}`;
  return `route:${entry.provider.id}:${routeId}`;
}

/// 把 route 映射成状态页可聚合的流量目标；优先使用真实 target provider，
/// 没有 targetProviderId 时退化为内联 route 自身。
function routeTrafficTarget(
  entry: RouteEntry,
  providersById: Map<string, Provider>,
): RouteTrafficTarget {
  const targetProviderId = routeTargetProviderId(entry.route);
  const targetProvider = targetProviderId
    ? providersById.get(targetProviderId)
    : undefined;
  if (targetProviderId) {
    return {
      providerId: targetProviderId,
      providerName: targetProvider?.name ?? targetProviderId,
    };
  }
  return {
    providerId: routeTrafficId(entry),
    providerName:
      entry.route.label?.trim() ||
      entry.route.id?.trim() ||
      `Route ${entry.index + 1}`,
  };
}

/// 从 router 日志反推 route id，兼容旧日志只写 effective_provider 的情况。
function routeIdFromRouterEvent(event: CodexRouterLogEvent): string | null {
  if (event.routeId?.trim()) return event.routeId.trim();
  const provider = event.effectiveProvider ?? event.provider ?? "";
  const marker = "::route::";
  const index = provider.indexOf(marker);
  return index >= 0
    ? provider.slice(index + marker.length).trim() || null
    : null;
}

/// 根据 route_id 或 model 匹配 router 日志对应的 route。
function routeEntryForRouterEvent(
  event: CodexRouterLogEvent,
  routes: RouteEntry[],
): RouteEntry | undefined {
  const routeId = routeIdFromRouterEvent(event);
  if (routeId) {
    const byId = routes.find(
      ({ route }) => route.id?.trim().toLowerCase() === routeId.toLowerCase(),
    );
    if (byId) return byId;
  }
  const model = event.model?.trim();
  return model
    ? routes.find(({ route }) => routeMatchesModel(route, model))
    : undefined;
}

/// router 诊断事件没有完整 token 和 latency 信息，只把可确认的 route/model
/// 请求计入请求数和失败数，避免把“没有外部 targetProviderId”误报为无流量。
function routerEventStatusCode(event: CodexRouterLogEvent): number {
  const parsed = Number.parseInt(event.status ?? "", 10);
  if (Number.isFinite(parsed)) return parsed;
  return event.event.includes("error") ? 500 : 0;
}

/// 从请求日志聚合 MultiRouter 子 provider / model 流量；无法归属的日志留给状态页单独提示。
function buildRouteTrafficRows({
  logs,
  routerEvents = [],
  routes,
  selectedPlan,
  providersById,
}: {
  logs: RequestLog[];
  routerEvents?: CodexRouterLogEvent[];
  routes: RouteEntry[];
  selectedPlan: Provider | null;
  providersById: Map<string, Provider>;
}): RouteTrafficRow[] {
  const selectedRoutes = selectedPlan
    ? routes.filter((entry) => entry.provider.id === selectedPlan.id)
    : routes;
  const targetProviderIds = collectTargetProviderIds(routes, selectedPlan);
  const buckets = new Map<
    string,
    RouteTrafficRow & { latencyTotalMs: number }
  >();

  function addTrafficSample(
    target: RouteTrafficTarget,
    model: string,
    statusCode: number,
    tokens: number,
    latencyMs: number,
  ) {
    const key = `${target.providerId}::${model}`;
    const current =
      buckets.get(key) ??
      ({
        providerId: target.providerId,
        providerName: target.providerName,
        model,
        requestCount: 0,
        successCount: 0,
        failedCount: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        latencyTotalMs: 0,
      } satisfies RouteTrafficRow & { latencyTotalMs: number });

    current.requestCount += 1;
    if (statusCode >= 200 && statusCode < 400) {
      current.successCount += 1;
    } else if (statusCode >= 400) {
      current.failedCount += 1;
    }
    current.totalTokens += tokens;
    current.latencyTotalMs += latencyMs;
    current.avgLatencyMs = Math.round(
      current.latencyTotalMs / current.requestCount,
    );
    buckets.set(key, current);
  }

  for (const log of logs) {
    if (log.appType !== "codex") continue;
    if ((log.dataSource ?? "proxy") !== "proxy") continue;
    const requestedModel = log.requestModel || log.model;
    const matchedRoute = selectedRoutes.find(({ route }) =>
      routeMatchesModel(route, requestedModel),
    );
    const model = requestedModel || log.model || "unknown";
    const target = matchedRoute
      ? routeTrafficTarget(matchedRoute, providersById)
      : targetProviderIds.has(log.providerId)
        ? {
            providerId: log.providerId,
            providerName:
              providersById.get(log.providerId)?.name ??
              log.providerName ??
              log.providerId,
          }
        : undefined;
    if (!target) continue;

    addTrafficSample(
      target,
      model,
      log.statusCode,
      log.inputTokens +
        log.outputTokens +
        log.cacheReadTokens +
        log.cacheCreationTokens,
      log.latencyMs,
    );
  }

  const terminalRouterEvents = routerEvents.filter((event) =>
    ["upstream_status", "upstream_error", "upstream_send_error"].includes(
      event.event,
    ),
  );
  const countableRouterEvents =
    terminalRouterEvents.length > 0
      ? terminalRouterEvents
      : routerEvents.filter((event) =>
          ["route_resolved", "request_prepared"].includes(event.event),
        );

  for (const event of countableRouterEvents) {
    const matchedRoute = routeEntryForRouterEvent(event, selectedRoutes);
    if (!matchedRoute) continue;
    addTrafficSample(
      routeTrafficTarget(matchedRoute, providersById),
      event.model || matchedRoute.route.match?.models?.[0] || "unknown",
      routerEventStatusCode(event),
      0,
      0,
    );
  }

  return Array.from(buckets.values())
    .map(({ latencyTotalMs: _latencyTotalMs, ...row }) => row)
    .sort((a, b) => b.requestCount - a.requestCount);
}

/// 显示 Codex 多模型路由工作台；它只复用 Provider 配置，不创建第二套数据库。
/// 注意：要让 Codex 请求真正进入路由，仍然必须开启 Codex app takeover，把 Codex live 配置指向本地代理。
export function CodexRouterWorkspacePage({
  providers,
  proxyStatus,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
  onEditProvider,
  onCreateProvider,
}: {
  providers: Provider[];
  proxyStatus?: ProxyStatus;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
  onEditProvider: (provider: Provider) => void;
  onCreateProvider: () => void;
}) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("status");
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [testModel, setTestModel] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [records, setRecords] = useState<RouteRecord[]>([]);

  const routingPlans = providers.filter(isRoutingPlan);
  const modelSources = providers.filter((provider) => !isRoutingPlan(provider));
  const providersById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );
  const routeEntries = routingPlans.flatMap((provider) =>
    (readCodexRouting(provider)?.routes ?? []).map((route, index) => ({
      provider,
      route,
      index,
    })),
  );
  const enabledRoutes = routeEntries.filter(
    ({ route }) => route.enabled !== false,
  );
  const routeModels = collectRouteModels(routeEntries);
  const selectedPlan =
    routingPlans.find((provider) => provider.id === selectedPlanId) ??
    routingPlans[0] ??
    null;
  const selectedRouting = selectedPlan ? readCodexRouting(selectedPlan) : null;
  const selectedRoute =
    routeEntries.find(
      ({ provider, route, index }) =>
        `${provider.id}:${route.id ?? index}` === selectedRouteKey,
    ) ?? routeEntries[0];

  const visibleRecords = useMemo(
    () =>
      records.length > 0
        ? records
        : [
            {
              id: "initial-overview",
              action: "读取配置",
              detail: "已从现有 Provider 配置生成路由工作台视图",
              time: "当前会话",
            },
          ],
    [records],
  );

  /// 记录页面内的关键操作，帮助用户知道自己刚刚点过什么；真实持久化仍由 Provider 编辑表单负责。
  function pushRecord(action: string, detail: string) {
    setRecords((current) => [
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        action,
        detail,
        time: new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      },
      ...current,
    ]);
  }

  /// 新建路由方案会打开现有 Provider 创建流程，避免出现两套配置来源。
  function handleCreatePlan() {
    pushRecord("创建", "打开创建多路路由表单");
    onCreateProvider();
  }

  /// 编辑路由方案会进入现有 Provider 编辑表单；该表单里可以增删改具体 route。
  function handleEditPlan(provider: Provider, detail = "打开路由方案编辑表单") {
    pushRecord("编辑", `${provider.name}：${detail}`);
    onEditProvider(provider);
  }

  /// 选择方案只改变工作台焦点，不修改数据库。
  function handleSelectPlan(provider: Provider) {
    setSelectedPlanId(provider.id);
    setActiveTab("routes");
    pushRecord("查看", `切换到路由方案：${provider.name}`);
  }

  /// 选择规则后跳转到规则页，让卡片产生明确的可操作反馈。
  function handleSelectRoute(entry: RouteEntry) {
    setSelectedPlanId(entry.provider.id);
    setSelectedRouteKey(
      `${entry.provider.id}:${entry.route.id ?? entry.index}`,
    );
    setActiveTab("routes");
    pushRecord(
      "查看",
      `查看规则：${entry.route.label || entry.route.id || "未命名规则"}`,
    );
  }

  /// 页面内测试只做规则匹配预览，不发真实上游请求，避免误触发计费或账号请求。
  function handlePreviewRoute() {
    const model = testModel.trim();
    if (!model) {
      setTestResult(
        "请输入一个 Codex 请求里的 model，例如 gpt-5.4-mini 或 qwen3.6。",
      );
      pushRecord("测试", "未输入模型名，未执行匹配预览");
      return;
    }

    const matched = enabledRoutes.find(({ route }) => {
      const models = route.match?.models ?? [];
      const prefixes = route.match?.prefixes ?? [];
      return (
        models.includes(model) ||
        prefixes.some((prefix) => model.startsWith(prefix))
      );
    });

    if (matched) {
      const result = `${model} 会命中「${matched.route.label || matched.route.id || "未命名规则"}」，上游为 ${routeBaseUrl(matched.route, providersById)}。`;
      setTestResult(result);
      pushRecord("测试", result);
      return;
    }

    const fallback = selectedRouting?.defaultRouteId
      ? `没有精确命中，会走默认路由 ${selectedRouting.defaultRouteId}。`
      : "没有命中任何启用规则，且当前方案没有默认路由。";
    setTestResult(fallback);
    pushRecord("测试", `${model}：${fallback}`);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden px-6 py-4">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2">
        <HeaderPanel
          routingPlans={routingPlans}
          modelSources={modelSources}
          routeEntries={routeEntries}
          enabledRoutes={enabledRoutes}
          isProxyRunning={isProxyRunning}
          isCodexTakeoverActive={isCodexTakeoverActive}
          onCreatePlan={handleCreatePlan}
          onJump={(tab) => setActiveTab(tab)}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as WorkspaceTab)}
        >
          <div className="sticky top-0 z-10 -mx-1 bg-background/95 px-1 py-2 backdrop-blur">
            <TabsList className="grid w-full grid-cols-6 bg-slate-950/40 p-1">
              <WorkspaceTabTrigger
                value="overview"
                icon={Layers3}
                label="总览"
              />
              <WorkspaceTabTrigger
                value="sources"
                icon={Server}
                label="模型源"
              />
              <WorkspaceTabTrigger
                value="routes"
                icon={Route}
                label="路由规则"
              />
              <WorkspaceTabTrigger
                value="status"
                icon={Activity}
                label="状态"
              />
              <WorkspaceTabTrigger value="test" icon={Play} label="测试发布" />
              <WorkspaceTabTrigger
                value="records"
                icon={FileClock}
                label="操作记录"
              />
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-3">
            <OverviewTab
              routingPlans={routingPlans}
              routeEntries={routeEntries}
              modelSources={modelSources}
              onCreatePlan={handleCreatePlan}
              onSelectPlan={handleSelectPlan}
              onSelectRoute={handleSelectRoute}
              providersById={providersById}
              onJump={setActiveTab}
            />
          </TabsContent>

          <TabsContent value="sources" className="mt-3">
            <SourcesTab
              modelSources={modelSources}
              routingPlans={routingPlans}
              onCreatePlan={handleCreatePlan}
              onEditPlan={handleEditPlan}
              onSelectPlan={handleSelectPlan}
            />
          </TabsContent>

          <TabsContent value="routes" className="mt-3">
            <RoutesTab
              routingPlans={routingPlans}
              routeEntries={routeEntries}
              selectedPlan={selectedPlan}
              selectedRoute={selectedRoute}
              onCreatePlan={handleCreatePlan}
              onEditPlan={handleEditPlan}
              onSelectPlan={handleSelectPlan}
              onSelectRoute={handleSelectRoute}
              providersById={providersById}
            />
          </TabsContent>

          <TabsContent value="status" className="mt-3">
            <StatusTab
              selectedPlan={selectedPlan}
              selectedRouting={selectedRouting}
              routeEntries={routeEntries}
              providersById={providersById}
              proxyStatus={proxyStatus}
              isProxyRunning={isProxyRunning}
              isCodexTakeoverActive={isCodexTakeoverActive}
              activeProviderId={activeProviderId}
              onEditPlan={handleEditPlan}
            />
          </TabsContent>

          <TabsContent value="test" className="mt-3">
            <TestTab
              selectedPlan={selectedPlan}
              selectedRouting={selectedRouting}
              routeModels={routeModels}
              testModel={testModel}
              testResult={testResult}
              onModelChange={setTestModel}
              onPreviewRoute={handlePreviewRoute}
              onEditPlan={handleEditPlan}
            />
          </TabsContent>

          <TabsContent value="records" className="mt-3">
            <RecordsTab
              records={visibleRecords}
              onCreatePlan={handleCreatePlan}
              onClear={() => {
                setRecords([]);
                setTestResult(null);
              }}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/// 顶部工作台总览，使用更强的色块和按钮态区分“可点击动作”和“只读状态”。
function HeaderPanel({
  routingPlans,
  modelSources,
  routeEntries,
  enabledRoutes,
  isProxyRunning,
  isCodexTakeoverActive,
  onCreatePlan,
  onJump,
}: {
  routingPlans: Provider[];
  modelSources: Provider[];
  routeEntries: RouteEntry[];
  enabledRoutes: RouteEntry[];
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  onCreatePlan: () => void;
  onJump: (tab: WorkspaceTab) => void;
}) {
  const enabledPlanCount = routingPlans.filter(
    (provider) => readCodexRouting(provider)?.enabled !== false,
  ).length;
  const linkReady =
    isProxyRunning && isCodexTakeoverActive && enabledPlanCount > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-700/80 bg-slate-950/30">
      <div className="grid gap-4 border-b border-slate-700/70 bg-gradient-to-r from-blue-950/60 via-slate-900 to-emerald-950/40 p-5 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xl font-semibold">
            <GitBranch className="h-5 w-5 text-blue-300" />
            Codex 多模型路由工作台
          </div>
          <p className="max-w-4xl text-sm leading-6 text-slate-300">
            这里配置的是“Codex 自己怎么按 model 选择多个上游模型”。Codex
            仍然只连接一个 CC Switch 本地代理；路由规则负责把
            gpt、qwen、deepseek 等模型名分流到不同上游。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              创建多路路由
            </Button>
            <Button
              variant="outline"
              onClick={() => onJump("routes")}
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              管理路由规则
            </Button>
            <Button
              variant="outline"
              onClick={() => onJump("status")}
              className="gap-2"
            >
              <Activity className="h-4 w-4" />
              查看链路状态
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <MetricCard
            color="blue"
            icon={Layers3}
            label="路由入口"
            value={`${enabledPlanCount} / ${routingPlans.length}`}
            detail="已启用 / 已配置的 MultiRouter provider"
          />
          <MetricCard
            color={linkReady ? "emerald" : "rose"}
            icon={Activity}
            label="当前链路"
            value={linkReady ? "在线" : "未就绪"}
            detail="监听、Codex 接管、路由入口都通过才在线"
          />
          <MetricCard
            color={isProxyRunning ? "emerald" : "amber"}
            icon={RadioTower}
            label="本地监听"
            value={isProxyRunning ? "成功" : "未启动"}
            detail="CC Switch 本地代理服务"
          />
          <MetricCard
            color={isCodexTakeoverActive ? "emerald" : "rose"}
            icon={ShieldCheck}
            label="Codex 接管"
            value={isCodexTakeoverActive ? "已接管" : "未接管"}
            detail="未接管时 Codex 不会进入 MultiRouter"
          />
          <MetricCard
            color="amber"
            icon={Route}
            label="启用规则"
            value={`${enabledRoutes.length} / ${routeEntries.length}`}
            detail={`${modelSources.length} 个模型源可接入`}
          />
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-4">
        <FlowStep
          index="1"
          title="模型源"
          detail="准备 OpenAI、Qwen、DeepSeek 等上游"
        />
        <FlowStep
          index="2"
          title="多路路由"
          detail="把多个上游收进一个 Codex 代理入口"
        />
        <FlowStep
          index="3"
          title="接管 Codex"
          detail="让 Codex live 配置指向本地代理"
        />
        <FlowStep index="4" title="匹配规则" detail="按精确模型名或前缀分流" />
      </div>
    </div>
  );
}

/// 选项卡触发器封装，统一图标和可点击态。
function WorkspaceTabTrigger({
  value,
  icon: Icon,
  label,
}: {
  value: WorkspaceTab;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <TabsTrigger value={value} className="min-w-0 gap-2">
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{label}</span>
    </TabsTrigger>
  );
}

/// 总览页展示当前方案、关键规则和下一步动作，避免用户只看到一堆不可操作卡片。
function OverviewTab({
  routingPlans,
  routeEntries,
  modelSources,
  providersById,
  onCreatePlan,
  onSelectPlan,
  onSelectRoute,
  onJump,
}: {
  routingPlans: Provider[];
  routeEntries: RouteEntry[];
  modelSources: Provider[];
  providersById: Map<string, Provider>;
  onCreatePlan: () => void;
  onSelectPlan: (provider: Provider) => void;
  onSelectRoute: (entry: RouteEntry) => void;
  onJump: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
      <section className="rounded-lg border border-blue-700/40 bg-blue-950/15 p-4">
        <SectionHeader
          icon={Layers3}
          title="多路路由"
          detail="每个多路路由都是一个 Codex 可连接的本地代理入口。"
          action={
            <Button
              size="sm"
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              创建多路路由
            </Button>
          }
        />
        <div className="mt-3 grid gap-3">
          {routingPlans.length === 0 ? (
            <EmptyState
              icon={Wand2}
              title="还没有多路路由"
              detail="先创建一个多路路由，再把多个模型源挂到它下面。"
              actionLabel="创建多路路由"
              onAction={onCreatePlan}
            />
          ) : (
            routingPlans.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectPlan(provider)}
                className="group rounded-lg border border-blue-600/40 bg-slate-950/40 p-4 text-left transition hover:border-blue-400 hover:bg-blue-950/30 hover:shadow-[0_0_0_1px_rgba(96,165,250,0.35)]"
              >
                <PlanCardContent provider={provider} />
              </button>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-emerald-700/40 bg-emerald-950/10 p-4">
        <SectionHeader
          icon={Route}
          title="最近路由规则"
          detail="点击规则可以进入详情和测试。"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onJump("routes")}
              className="gap-2"
            >
              查看全部
              <ArrowRight className="h-4 w-4" />
            </Button>
          }
        />
        <div className="mt-3 grid gap-2">
          {routeEntries.slice(0, 4).map((entry) => (
            <RouteListButton
              key={`${entry.provider.id}-${entry.route.id ?? entry.index}`}
              entry={entry}
              providersById={providersById}
              onClick={() => onSelectRoute(entry)}
            />
          ))}
          {routeEntries.length === 0 && (
            <EmptyState
              icon={Route}
              title="还没有规则"
              detail="创建多路路由后，在编辑表单里添加模型匹配规则。"
              actionLabel="创建多路路由"
              onAction={onCreatePlan}
            />
          )}
        </div>
      </section>

      <section className="rounded-lg border border-amber-700/40 bg-amber-950/10 p-4 xl:col-span-2">
        <SectionHeader
          icon={Server}
          title="可接入模型源"
          detail="这些不是单独一类难懂的 Provider，而是可以被路由方案接入的上游模型源。"
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onJump("sources")}
            >
              选择模型源
            </Button>
          }
        />
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {modelSources.slice(0, 8).map((provider) => (
            <SourceMiniCard key={provider.id} provider={provider} />
          ))}
        </div>
      </section>
    </div>
  );
}

/// 模型源页展示可被纳入路由的上游，并把“编辑后接入”作为明确操作。
function SourcesTab({
  modelSources,
  routingPlans,
  onCreatePlan,
  onEditPlan,
  onSelectPlan,
}: {
  modelSources: Provider[];
  routingPlans: Provider[];
  onCreatePlan: () => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
  onSelectPlan: (provider: Provider) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <section className="rounded-lg border border-blue-700/40 bg-blue-950/15 p-4">
        <SectionHeader
          icon={Layers3}
          title="多路路由方案"
          detail="这是 Codex 最终连接的路由入口；选择后到“路由规则”里挂接模型源。"
          action={
            <Button
              size="sm"
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              创建多路路由
            </Button>
          }
        />
        <div className="mt-3 grid gap-2">
          {routingPlans.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => onSelectPlan(provider)}
              className="rounded-lg border border-blue-700/40 bg-slate-950/40 p-3 text-left transition hover:border-blue-400 hover:bg-blue-950/30"
            >
              <PlanCardContent provider={provider} compact />
            </button>
          ))}
          {routingPlans.length === 0 && (
            <EmptyState
              icon={Layers3}
              title="还没有多路路由"
              detail="先创建一个 Codex 多模型路由入口，再选择模型源接入。"
              actionLabel="创建多路路由"
              onAction={onCreatePlan}
            />
          )}
        </div>
      </section>

      <section className="rounded-lg border border-amber-700/40 bg-amber-950/10 p-4">
        <SectionHeader
          icon={Server}
          title="选择模型源"
          detail="这里选择要接入多路路由的上游模型源；点卡片进入模型源配置。"
        />
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {modelSources.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() =>
                onEditPlan(provider, "选择并编辑模型源，准备接入多路路由")
              }
              className="group rounded-lg border border-amber-700/40 bg-slate-950/40 p-4 text-left transition hover:border-amber-400 hover:bg-amber-950/20 hover:shadow-[0_0_0_1px_rgba(251,191,36,0.25)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-100">
                    {provider.name}
                  </div>
                  <div className="mt-1 truncate text-xs text-slate-400">
                    ID：{provider.id}
                  </div>
                </div>
                <Badge className="border-amber-500/50 bg-amber-500/15 text-amber-100">
                  可选
                </Badge>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-slate-400">选择这个模型源</span>
                <span className="inline-flex items-center gap-1 text-amber-200 opacity-80 group-hover:opacity-100">
                  选择
                  <Pencil className="h-3.5 w-3.5" />
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/// 路由规则页提供方案选择、规则列表和右侧详情，形成真实的“查/改/删入口”工作流。
function RoutesTab({
  routingPlans,
  routeEntries,
  selectedPlan,
  selectedRoute,
  providersById,
  onCreatePlan,
  onEditPlan,
  onSelectPlan,
  onSelectRoute,
}: {
  routingPlans: Provider[];
  routeEntries: RouteEntry[];
  selectedPlan: Provider | null;
  selectedRoute?: RouteEntry;
  providersById: Map<string, Provider>;
  onCreatePlan: () => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
  onSelectPlan: (provider: Provider) => void;
  onSelectRoute: (entry: RouteEntry) => void;
}) {
  const selectedPlanRoutes = selectedPlan
    ? routeEntries.filter(({ provider }) => provider.id === selectedPlan.id)
    : routeEntries;

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
      <section className="rounded-lg border border-blue-700/40 bg-blue-950/15 p-4">
        <SectionHeader
          icon={Layers3}
          title="选择多路路由"
          detail="每个多路路由可包含多条分流规则。"
          action={
            <Button
              size="sm"
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              创建多路路由
            </Button>
          }
        />
        <div className="mt-3 grid gap-2">
          {routingPlans.map((provider) => {
            const active = selectedPlan?.id === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectPlan(provider)}
                className={cn(
                  "rounded-lg border p-3 text-left transition",
                  active
                    ? "border-blue-400 bg-blue-600/20 shadow-[0_0_0_1px_rgba(96,165,250,0.35)]"
                    : "border-slate-700 bg-slate-950/40 hover:border-blue-500 hover:bg-blue-950/20",
                )}
              >
                <PlanCardContent provider={provider} compact />
              </button>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-950/10 p-4">
          <SectionHeader
            icon={Route}
            title="规则列表"
            detail="点击规则查看详情；每条规则的“启用”只表示参与匹配，不是启动服务。"
            action={
              selectedPlan ? (
                <Button
                  size="sm"
                  onClick={() =>
                    onEditPlan(selectedPlan, "添加、修改或删除路由规则")
                  }
                  className="gap-2 bg-emerald-600 hover:bg-emerald-500"
                >
                  <Pencil className="h-4 w-4" />
                  编辑匹配规则
                </Button>
              ) : null
            }
          />
          <div className="mt-3 grid gap-2">
            {selectedPlanRoutes.map((entry) => (
              <RouteListButton
                key={`${entry.provider.id}-${entry.route.id ?? entry.index}`}
                entry={entry}
                providersById={providersById}
                active={
                  selectedRoute?.provider.id === entry.provider.id &&
                  selectedRoute.index === entry.index
                }
                onClick={() => onSelectRoute(entry)}
              />
            ))}
            {selectedPlanRoutes.length === 0 && (
              <EmptyState
                icon={Route}
                title="这个方案还没有规则"
                detail="点击编辑规则，在配置表单里添加精确模型或前缀匹配。"
                actionLabel="编辑多路路由"
                onAction={() =>
                  selectedPlan ? onEditPlan(selectedPlan) : onCreatePlan()
                }
              />
            )}
          </div>
        </div>

        <RouteDetailPanel
          selectedRoute={selectedRoute}
          selectedPlan={selectedPlan}
          providersById={providersById}
          onEditPlan={onEditPlan}
        />
      </section>
    </div>
  );
}

/// 状态页把代理运行态、Codex 接管态、路由配置态和最近流量放在同一视图里。
function StatusTab({
  selectedPlan,
  selectedRouting,
  routeEntries,
  providersById,
  proxyStatus,
  isProxyRunning,
  isCodexTakeoverActive,
  activeProviderId,
  onEditPlan,
}: {
  selectedPlan: Provider | null;
  selectedRouting: CodexRouting | null;
  routeEntries: RouteEntry[];
  providersById: Map<string, Provider>;
  proxyStatus?: ProxyStatus;
  isProxyRunning: boolean;
  isCodexTakeoverActive: boolean;
  activeProviderId?: string;
  onEditPlan: (provider: Provider, detail?: string) => void;
}) {
  const range = useMemo(() => ({ preset: "today" as const }), []);
  const { data: requestLogs, isLoading } = useRequestLogs({
    filters: { appType: "codex" },
    range,
    page: 0,
    pageSize: 500,
    options: { refetchInterval: 5000 },
  });
  const [diagnostics, setDiagnostics] =
    useState<CodexMultiRouterDiagnostics | null>(null);
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [historySyncResult, setHistorySyncResult] =
    useState<CodexHistoryProviderBucketSyncOutcome | null>(null);
  const [historySyncError, setHistorySyncError] = useState<string | null>(null);
  const [isSyncingHistory, setIsSyncingHistory] = useState(false);
  const [statusView, setStatusView] = useState<StatusView>("link");
  const logs = requestLogs?.data ?? [];
  const proxyLogs = logs.filter(
    (log) => (log.dataSource ?? "proxy") === "proxy",
  );
  const sessionLogs = logs.filter(
    (log) => (log.dataSource ?? "proxy") !== "proxy",
  );
  const selectedRoutes = selectedPlan
    ? routeEntries.filter(({ provider }) => provider.id === selectedPlan.id)
    : routeEntries;
  const routerEvents = diagnostics?.routerLog.recentEvents ?? [];
  const routerRequestEvents = routerEvents.filter((event) =>
    [
      "route_resolved",
      "request_prepared",
      "upstream_send",
      "upstream_status",
      "upstream_error",
      "upstream_send_error",
    ].includes(event.event),
  );
  const routeTargetCount = new Set(
    selectedRoutes.map(
      (entry) => routeTrafficTarget(entry, providersById).providerId,
    ),
  ).size;
  const trafficRows = buildRouteTrafficRows({
    logs: proxyLogs,
    routerEvents,
    routes: routeEntries,
    selectedPlan,
    providersById,
  });
  const routerLogs = routerEvents;
  const routedLogs = proxyLogs.filter((log) =>
    trafficRows.some(
      (row) =>
        row.providerId === log.providerId ||
        row.model === (log.requestModel || log.model),
    ),
  );
  const latestLog = proxyLogs[0];
  const latestForwardOk = latestLog
    ? latestLog.statusCode >= 200 && latestLog.statusCode < 400
    : false;
  const listenAddress = proxyStatus
    ? `${proxyStatus.address}:${proxyStatus.port}`
    : "未启动";
  const activeTargetLabel =
    activeProviderId && providersById.get(activeProviderId)
      ? `${providersById.get(activeProviderId)?.name} (${activeProviderId})`
      : activeProviderId || "未命中";
  const routeEnabled = selectedRouting?.enabled !== false;
  const hasEnabledRoutes = selectedRoutes.some(
    ({ route }) => route.enabled !== false,
  );
  const configReady = Boolean(
    isProxyRunning &&
      isCodexTakeoverActive &&
      selectedPlan &&
      routeEnabled &&
      hasEnabledRoutes,
  );
  const trafficVerified =
    proxyLogs.length > 0 ||
    routerRequestEvents.length > 0 ||
    (proxyStatus?.total_requests ?? 0) > 0;
  const linkOnline = Boolean(configReady && trafficVerified);
  const readinessIssues = [
    !isProxyRunning ? "本地代理未监听" : "",
    !isCodexTakeoverActive ? "Codex live 配置未接管" : "",
    !selectedPlan ? "未选择 MultiRouter provider" : "",
    selectedPlan && !routeEnabled ? "MultiRouter 入口已关闭" : "",
    selectedPlan && routeEnabled && !hasEnabledRoutes
      ? "没有启用的匹配规则"
      : "",
  ].filter(Boolean);

  /// 一键诊断只读取本地现场和 router 日志，不向真实上游发起模型请求。
  async function runDiagnostics() {
    setStatusView("debug");
    setIsDiagnosing(true);
    setDiagnoseError(null);
    try {
      const result = await proxyApi.diagnoseCodexMultiRouter(
        selectedPlan?.id ?? null,
      );
      setDiagnostics(result);
    } catch (error) {
      setDiagnoseError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDiagnosing(false);
    }
  }

  /// 历史同步会改写 Codex 本机索引，因此必须由用户显式确认；它只解决
  /// custom MultiRouter 桶下看不到 openai 历史的问题，不参与请求路由。
  async function syncHistoryToMultiRouter() {
    const confirmed = window.confirm(
      "这会把 Codex 的 openai/旧 router 历史同步到 MultiRouter 使用的 custom 历史桶，并先创建本地备份。继续吗？",
    );
    if (!confirmed) return;
    setIsSyncingHistory(true);
    setHistorySyncError(null);
    try {
      const result = await proxyApi.syncCodexHistoryToMultiRouter();
      setHistorySyncResult(result);
    } catch (error) {
      setHistorySyncError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsSyncingHistory(false);
    }
  }

  return (
    <div className="space-y-4">
      <StatusViewSwitcher
        value={statusView}
        diagnostics={diagnostics}
        trafficCount={trafficRows.length}
        providerCount={selectedRoutes.length}
        onChange={setStatusView}
      />

      {statusView === "link" && (
        <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <SectionHeader
            icon={Activity}
            title="链路状态"
            detail="默认先看这里：只有监听、Codex 接管、路由入口和至少一条匹配规则都通过，Codex 请求才会进入 MultiRouter。"
            action={
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runDiagnostics}
                  disabled={isDiagnosing}
                  className="gap-2 border-amber-500/50 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
                >
                  {isDiagnosing ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Bug className="h-4 w-4" />
                  )}
                  Debug 检查
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={syncHistoryToMultiRouter}
                  disabled={isSyncingHistory}
                  className="gap-2 border-sky-500/50 bg-sky-500/10 text-sky-100 hover:bg-sky-500/20"
                >
                  {isSyncingHistory ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileClock className="h-4 w-4" />
                  )}
                  同步历史桶
                </Button>
                {selectedPlan ? (
                  <Button
                    size="sm"
                    onClick={() => onEditPlan(selectedPlan, "打开多路路由配置")}
                    className="gap-2 bg-blue-600 hover:bg-blue-500"
                  >
                    <Pencil className="h-4 w-4" />
                    编辑配置
                  </Button>
                ) : null}
              </div>
            }
          />
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatusCard
              ok={linkOnline}
              label="当前链路"
              value={
                linkOnline ? "在线" : configReady ? "待请求验证" : "未就绪"
              }
              detail={
                linkOnline
                  ? "Codex 请求会进入本地代理并按 model 分流"
                  : configReady
                    ? "配置和监听已就绪，但今天还没有真实代理转发日志"
                    : readinessIssues.join("；") || "等待状态刷新"
              }
            />
            <StatusCard
              ok={isProxyRunning}
              label="监听"
              value={isProxyRunning ? "成功" : "未启动"}
              detail={listenAddress}
            />
            <StatusCard
              ok={isCodexTakeoverActive}
              label="Codex 接管"
              value={isCodexTakeoverActive ? "已接管" : "未接管"}
              detail="Codex 请求需要指向本地代理才会进入路由"
            />
            <StatusCard
              ok={Boolean(selectedPlan && routeEnabled)}
              label="路由入口"
              value={
                selectedPlan ? (routeEnabled ? "已启用" : "已关闭") : "未选择"
              }
              detail={selectedPlan?.name ?? "暂无 MultiRouter provider"}
            />
            <StatusCard
              ok={Boolean(latestLog && latestForwardOk)}
              label="最近转发"
              value={
                latestLog
                  ? latestForwardOk
                    ? `成功 ${latestLog.statusCode}`
                    : `失败 ${latestLog.statusCode}`
                  : "暂无请求"
              }
              detail={
                latestLog?.errorMessage ||
                latestLog?.requestModel ||
                latestLog?.model ||
                "等待 Codex 请求"
              }
            />
          </div>
          {historySyncError ? (
            <div className="mt-3 rounded-lg border border-rose-700/50 bg-rose-950/30 p-3 text-xs text-rose-100">
              历史同步失败：{historySyncError}
            </div>
          ) : null}
          {historySyncResult ? (
            <div className="mt-3 rounded-lg border border-sky-700/50 bg-sky-950/25 p-3 text-xs leading-5 text-sky-100">
              历史同步完成：SQLite {historySyncResult.migratedStateRows}{" "}
              行，JSONL {historySyncResult.migratedJsonlFiles} 个文件，来源{" "}
              {historySyncResult.sourceProviderIds.join(", ") || "无"}
              {historySyncResult.skippedReason
                ? `，跳过原因：${historySyncResult.skippedReason}`
                : ""}
            </div>
          ) : null}
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
            <DetailRow label="当前代理目标" value={activeTargetLabel} />
            <DetailRow
              label="启用匹配规则"
              value={`${selectedRoutes.filter(({ route }) => route.enabled !== false).length} / ${selectedRoutes.length}`}
            />
            <DetailRow
              label="代理累计请求"
              value={`${proxyStatus?.total_requests ?? 0} 次，成功率 ${proxyStatus?.success_rate ?? 0}%`}
            />
          </div>
          <div className="mt-3">
            <DetailRow
              label="最近错误"
              value={proxyStatus?.last_error || latestLog?.errorMessage || "无"}
            />
          </div>
        </section>
      )}

      {statusView === "debug" && (
        <DiagnosticsPanel
          diagnostics={diagnostics}
          isLoading={isDiagnosing}
          error={diagnoseError}
          onRun={runDiagnostics}
        />
      )}

      {statusView === "providers" && (
        <section className="rounded-lg border border-blue-700/40 bg-blue-950/15 p-4">
          <SectionHeader
            icon={GitFork}
            title="分流子 Provider"
            detail="这些子 Provider 来自当前 MultiRouter 的 route target，转换层跟随各自供应商配置。"
          />
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {selectedRoutes.map((entry) => {
              const targetProviderId = routeTargetProviderId(entry.route);
              const targetProvider = routeTargetProvider(
                entry.route,
                providersById,
              );
              return (
                <div
                  key={`${entry.provider.id}-${entry.route.id ?? entry.index}`}
                  className="rounded-lg border border-slate-700 bg-slate-950/50 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-100">
                        {targetProvider?.name ?? targetProviderId ?? "内联上游"}
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-400">
                        {entry.route.label || entry.route.id || "未命名规则"}
                      </div>
                    </div>
                    <Badge
                      className={cn(
                        "border",
                        entry.route.enabled === false
                          ? "border-slate-500/50 bg-slate-500/10 text-slate-200"
                          : "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
                      )}
                    >
                      {entry.route.enabled === false
                        ? "规则停用"
                        : "规则已启用"}
                    </Badge>
                  </div>
                  <div className="mt-3 text-xs leading-5 text-slate-400">
                    {routeMatchSummary(entry.route)}
                  </div>
                </div>
              );
            })}
            {selectedRoutes.length === 0 && (
              <EmptyState
                icon={Route}
                title="还没有分流规则"
                detail="添加 route 后，这里会列出每个子 Provider 和它负责的模型。"
                actionLabel="编辑多路路由"
                onAction={() => selectedPlan && onEditPlan(selectedPlan)}
              />
            )}
          </div>
        </section>
      )}

      {statusView === "traffic" && (
        <section className="rounded-lg border border-emerald-700/40 bg-emerald-950/10 p-4">
          <SectionHeader
            icon={Database}
            title="今日子 Provider / Model 流量"
            detail="基于 Codex 请求日志聚合；若后端只记录外层 MultiRouter，页面会按 requestModel 尝试回归属到 route target。"
          />
          <div className="mt-3 overflow-hidden rounded-lg border border-slate-700">
            <div className="grid grid-cols-[1.2fr_1.2fr_0.7fr_0.7fr_0.8fr_0.8fr] gap-2 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-300">
              <span>Provider</span>
              <span>Model</span>
              <span className="text-right">请求</span>
              <span className="text-right">失败</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">延迟</span>
            </div>
            {isLoading ? (
              <div className="p-4 text-sm text-slate-400">正在读取统计...</div>
            ) : trafficRows.length > 0 ? (
              trafficRows.map((row) => (
                <div
                  key={`${row.providerId}-${row.model}`}
                  className="grid grid-cols-[1.2fr_1.2fr_0.7fr_0.7fr_0.8fr_0.8fr] gap-2 border-t border-slate-800 px-3 py-2 text-xs text-slate-300"
                >
                  <span className="truncate">{row.providerName}</span>
                  <span className="truncate font-mono">{row.model}</span>
                  <span className="text-right">{row.requestCount}</span>
                  <span className="text-right">{row.failedCount}</span>
                  <span className="text-right">
                    {row.totalTokens.toLocaleString()}
                  </span>
                  <span className="text-right">{row.avgLatencyMs}ms</span>
                </div>
              ))
            ) : (
              <div className="p-4 text-sm leading-6 text-slate-400">
                暂无可归属到子 Provider 的请求日志。今日 Codex 日志{" "}
                {logs.length} 条，其中真实代理转发 {proxyLogs.length} 条，Codex
                会话同步 {sessionLogs.length} 条，外层 MultiRouter 日志{" "}
                {routerLogs.length} 条，目标 Provider 数 {routeTargetCount} 个。
              </div>
            )}
          </div>
          <div className="mt-3 text-xs text-slate-500">
            已尝试归属真实代理日志 {routedLogs.length} 条、router 诊断事件{" "}
            {routerRequestEvents.length} 条；这里不把 codex_session
            历史同步当作转发。
          </div>
        </section>
      )}
    </div>
  );
}

/// 测试发布页只做本地匹配预览，并展示下一步如何发布到 Codex。
function TestTab({
  selectedPlan,
  selectedRouting,
  routeModels,
  testModel,
  testResult,
  onModelChange,
  onPreviewRoute,
  onEditPlan,
}: {
  selectedPlan: Provider | null;
  selectedRouting: CodexRouting | null;
  routeModels: string[];
  testModel: string;
  testResult: string | null;
  onModelChange: (value: string) => void;
  onPreviewRoute: () => void;
  onEditPlan: (provider: Provider, detail?: string) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <section className="rounded-lg border border-purple-700/40 bg-purple-950/10 p-4">
        <SectionHeader
          icon={Play}
          title="匹配预览"
          detail="输入 Codex 请求中的 model，先在本地预览会命中哪条规则。"
        />
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            value={testModel}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder="例如：gpt-5.4-mini、qwen3.6、deepseek-v4-flash"
            className="h-10 rounded-md border border-purple-700/50 bg-slate-950/70 px-3 text-sm outline-none transition placeholder:text-slate-500 focus:border-purple-400 focus:ring-2 focus:ring-purple-500/30"
          />
          <Button
            onClick={onPreviewRoute}
            className="gap-2 bg-purple-600 hover:bg-purple-500"
          >
            <Play className="h-4 w-4" />
            预览命中
          </Button>
        </div>
        {routeModels.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {routeModels.slice(0, 10).map((model) => (
              <button
                key={model}
                type="button"
                onClick={() => onModelChange(model.replace(/\*$/, ""))}
                className="rounded-full border border-purple-500/40 bg-purple-500/10 px-3 py-1 text-xs text-purple-100 transition hover:border-purple-300 hover:bg-purple-500/20"
              >
                {model}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 rounded-lg border border-purple-700/40 bg-slate-950/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-purple-300" />
            预览结果
          </div>
          <p className="text-sm leading-6 text-slate-300">
            {testResult ??
              "还没有执行预览。这里不会请求真实上游，也不会消耗额度。"}
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-emerald-700/40 bg-emerald-950/10 p-4">
        <SectionHeader
          icon={RadioTower}
          title="发布检查"
          detail="确认后再到配置表单保存。"
          action={
            selectedPlan ? (
              <Button
                size="sm"
                onClick={() => onEditPlan(selectedPlan, "打开发布前配置检查")}
                className="gap-2 bg-emerald-600 hover:bg-emerald-500"
              >
                <Pencil className="h-4 w-4" />
                编辑多路路由
              </Button>
            ) : null
          }
        />
        <div className="mt-4 space-y-3">
          <ChecklistItem ok={Boolean(selectedPlan)} label="已选择多路路由" />
          <ChecklistItem
            ok={selectedRouting?.enabled !== false}
            label="多路路由处于启用状态"
          />
          <ChecklistItem
            ok={Boolean(selectedRouting?.defaultRouteId)}
            label="已设置默认路由"
          />
          <ChecklistItem
            ok={(selectedRouting?.routes?.length ?? 0) > 0}
            label="至少有一条路由规则"
          />
          <ChecklistItem ok label="不会切换 Codex 当前 Provider" />
        </div>
      </section>
    </div>
  );
}

/// 操作记录页提供本次页面内的增删改查痕迹，让工作台不再像静态说明页。
function RecordsTab({
  records,
  onCreatePlan,
  onClear,
}: {
  records: RouteRecord[];
  onCreatePlan: () => void;
  onClear: () => void;
}) {
  return (
    <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
      <SectionHeader
        icon={FileClock}
        title="操作记录"
        detail="记录当前页面的查看、创建、编辑和测试动作；真实配置仍保存在模型源数据里。"
        action={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onClear}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              清空临时记录
            </Button>
            <Button
              size="sm"
              onClick={onCreatePlan}
              className="gap-2 bg-blue-600 hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" />
              创建多路路由
            </Button>
          </div>
        }
      />
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-700">
        {records.map((record) => (
          <div
            key={record.id}
            className="grid gap-2 border-b border-slate-800 bg-slate-950/40 p-3 text-sm last:border-b-0 md:grid-cols-[120px_120px_1fr]"
          >
            <div className="text-slate-400">{record.time}</div>
            <div className="font-semibold text-slate-100">{record.action}</div>
            <div className="text-slate-300">{record.detail}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/// 状态页内部的分段切换；一次只展开一个信息域，避免 Debug、Provider 和流量表挤在同一屏。
function StatusViewSwitcher({
  value,
  diagnostics,
  trafficCount,
  providerCount,
  onChange,
}: {
  value: StatusView;
  diagnostics: CodexMultiRouterDiagnostics | null;
  trafficCount: number;
  providerCount: number;
  onChange: (value: StatusView) => void;
}) {
  const failedCount =
    diagnostics?.checks.filter((check) => check.status === "fail").length ?? 0;
  const warnCount =
    diagnostics?.checks.filter((check) => check.status === "warn").length ?? 0;
  const debugBadge = diagnostics
    ? failedCount > 0
      ? `${failedCount} 阻塞`
      : warnCount > 0
        ? `${warnCount} 警告`
        : "已检查"
    : "未检查";

  const items: Array<{
    value: StatusView;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    detail: string;
  }> = [
    {
      value: "link",
      icon: Activity,
      label: "链路",
      detail: "监听 / 接管 / 入口",
    },
    {
      value: "debug",
      icon: Bug,
      label: "Debug",
      detail: debugBadge,
    },
    {
      value: "providers",
      icon: GitFork,
      label: "分流",
      detail: `${providerCount} 个目标`,
    },
    {
      value: "traffic",
      icon: Database,
      label: "流量",
      detail: `${trafficCount} 组统计`,
    },
  ];

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-2">
      <div className="grid gap-2 md:grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon;
          const active = value === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => onChange(item.value)}
              className={cn(
                "flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left transition",
                active
                  ? "border-blue-500/60 bg-blue-600/20 text-blue-100"
                  : "border-slate-700 bg-slate-950/40 text-slate-300 hover:border-blue-500/50 hover:bg-blue-950/20",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {item.label}
                </span>
                <span className="block truncate text-xs opacity-70">
                  {item.detail}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/// MultiRouter Debug 面板展示后端真实检查结果，重点区分“没进入本地路由”和“进入后上游失败”。
function DiagnosticsPanel({
  diagnostics,
  isLoading,
  error,
  onRun,
}: {
  diagnostics: CodexMultiRouterDiagnostics | null;
  isLoading: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const failedChecks =
    diagnostics?.checks.filter((check) => check.status === "fail") ?? [];
  const warningChecks =
    diagnostics?.checks.filter((check) => check.status === "warn") ?? [];

  return (
    <div className="rounded-lg border border-amber-600/40 bg-amber-950/10 p-4">
      <SectionHeader
        icon={Bug}
        title="Debug 检查"
        detail="只检查本机监听、Codex live config、WebSocket 回退、路由规则和 router 日志，不会向真实上游发送模型请求。"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={onRun}
            disabled={isLoading}
            className="gap-2 border-amber-500/50 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20"
          >
            {isLoading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            重新检查
          </Button>
        }
      />

      {error && (
        <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-100">
          {error}
        </div>
      )}

      {!diagnostics && !error && (
        <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-sm leading-6 text-slate-300">
          尚未运行 Debug 检查。点击按钮后会读取真实 Codex live
          配置和本地路由日志，用来确认请求是否进入 MultiRouter。
        </div>
      )}

      {diagnostics && (
        <div className="mt-4 space-y-4">
          <div
            className={cn(
              "rounded-lg border p-3",
              diagnostics.ready
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
                : "border-rose-500/40 bg-rose-500/10 text-rose-100",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">
                  {diagnostics.ready ? "关键链路通过" : "发现阻塞项"}
                </div>
                <div className="mt-1 text-xs leading-5 opacity-80">
                  {diagnostics.nextAction}
                </div>
              </div>
              <Badge
                className={cn(
                  "border",
                  diagnostics.ready
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-100"
                    : "border-rose-500/50 bg-rose-500/15 text-rose-100",
                )}
              >
                {diagnostics.generatedAt}
              </Badge>
            </div>
          </div>

          {(failedChecks.length > 0 || warningChecks.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {failedChecks.length > 0 && (
                <DebugIssueList
                  title="阻塞项"
                  tone="fail"
                  items={diagnostics.blockingIssues}
                />
              )}
              {warningChecks.length > 0 && (
                <DebugIssueList
                  title="警告"
                  tone="warn"
                  items={diagnostics.warnings}
                />
              )}
            </div>
          )}

          {diagnostics.desktopRuntime?.mayHaveStaleModelCatalog && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100">
              {diagnostics.desktopRuntime.staleReason ??
                "Codex app-server may still be using an older in-memory model catalog. Fully quit Codex Desktop/app-server, reopen Codex, and then check the model picker again."}
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {diagnostics.checks.map((check) => (
              <DiagnosticCheckCard key={check.id} check={check} />
            ))}
          </div>

          <div className="grid gap-3 text-sm xl:grid-cols-4">
            <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
              <div className="mb-3 flex items-center gap-2 font-semibold text-slate-100">
                <Settings2 className="h-4 w-4 text-blue-300" />
                Codex Live Config
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="配置文件"
                  value={diagnostics.liveConfig.path}
                />
                <DetailRow
                  label="model_provider"
                  value={diagnostics.liveConfig.modelProvider ?? "未设置"}
                />
                <DetailRow
                  label="active base_url"
                  value={diagnostics.liveConfig.activeBaseUrl ?? "未设置"}
                />
                <DetailRow
                  label="supports_websockets"
                  value={String(diagnostics.liveConfig.supportsWebsockets)}
                />
                <DetailRow
                  label="wire_api"
                  value={diagnostics.liveConfig.wireApi ?? "未设置"}
                />
                <DetailRow
                  label="model_catalog_json"
                  value={diagnostics.liveConfig.modelCatalogJson ?? "未设置"}
                />
                <DetailRow
                  label="catalog 模型数"
                  value={
                    diagnostics.liveConfig.modelCatalogModelCount == null
                      ? "未知"
                      : `${diagnostics.liveConfig.modelCatalogModelCount}`
                  }
                />
                <DetailRow
                  label="config 修改时间"
                  value={diagnostics.liveConfig.configModifiedAt ?? "未知"}
                />
                <DetailRow
                  label="catalog 修改时间"
                  value={diagnostics.liveConfig.modelCatalogModifiedAt ?? "未知"}
                />
              </div>
            </div>

            <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
              <div className="mb-3 flex items-center gap-2 font-semibold text-slate-100">
                <Server className="h-4 w-4 text-violet-300" />
                Codex Desktop
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="进程"
                  value={
                    diagnostics.desktopRuntime?.running
                      ? `${diagnostics.desktopRuntime.processCount} 个`
                      : "未检测到"
                  }
                />
                <DetailRow
                  label="app-server"
                  value={
                    diagnostics.desktopRuntime?.appServerRunning
                      ? `${diagnostics.desktopRuntime.appServerCount} 个`
                      : "未检测到"
                  }
                />
                <DetailRow
                  label="最新 app-server 启动"
                  value={
                    diagnostics.desktopRuntime?.newestAppServerStartedAt ??
                    "未知"
                  }
                />
                <DetailRow
                  label="stale catalog"
                  value={
                    diagnostics.desktopRuntime?.mayHaveStaleModelCatalog
                      ? "可能"
                      : "未发现"
                  }
                />
                <DetailRow
                  label="检测错误"
                  value={diagnostics.desktopRuntime?.detectionError ?? "无"}
                />
              </div>
            </div>

            <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
              <div className="mb-3 flex items-center gap-2 font-semibold text-slate-100">
                <Route className="h-4 w-4 text-emerald-300" />
                Route Plan
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="Provider"
                  value={
                    diagnostics.routePlan.providerName ??
                    diagnostics.routePlan.providerId ??
                    "未找到"
                  }
                />
                <DetailRow
                  label="入口状态"
                  value={diagnostics.routePlan.routingEnabled ? "启用" : "关闭"}
                />
                <DetailRow
                  label="启用规则"
                  value={`${diagnostics.routePlan.enabledRouteCount} / ${diagnostics.routePlan.routeCount}`}
                />
                <DetailRow
                  label="默认路由"
                  value={diagnostics.routePlan.defaultRouteId ?? "未设置"}
                />
              </div>
            </div>

            <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
              <div className="mb-3 flex items-center gap-2 font-semibold text-slate-100">
                <FileClock className="h-4 w-4 text-amber-300" />
                Router Log
              </div>
              <div className="space-y-2">
                <DetailRow
                  label="日志文件"
                  value={diagnostics.routerLog.exists ? "存在" : "不存在"}
                />
                <DetailRow
                  label="已扫描事件"
                  value={`${diagnostics.routerLog.totalScanned}`}
                />
                <DetailRow
                  label="匹配当前 Router"
                  value={`${diagnostics.routerLog.matchedScanned}`}
                />
                <DetailRow
                  label="最近请求"
                  value={diagnostics.routerLog.latestRequestAt ?? "无"}
                />
                <DetailRow
                  label="最近错误"
                  value={diagnostics.routerLog.latestError ?? "无"}
                />
              </div>
            </div>
          </div>

          {diagnostics.routePlan.routeSummaries.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-700">
              <div className="grid grid-cols-[1fr_1fr_0.8fr_0.8fr] gap-2 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-300">
                <span>规则</span>
                <span>目标 Provider</span>
                <span>接口</span>
                <span>模型</span>
              </div>
              {diagnostics.routePlan.routeSummaries.map((route, index) => (
                <div
                  key={`${route.id ?? index}-${route.targetProviderId ?? "inline"}`}
                  className="grid grid-cols-[1fr_1fr_0.8fr_0.8fr] gap-2 border-t border-slate-800 px-3 py-2 text-xs text-slate-300"
                >
                  <span className="truncate">
                    {route.label ?? route.id ?? `规则 ${index + 1}`}
                    {route.enabled ? "" : "（停用）"}
                  </span>
                  <span className="truncate">
                    {route.targetProviderName ??
                      route.targetProviderId ??
                      "内联配置"}
                    {route.targetProviderId && !route.targetExists
                      ? "（不存在）"
                      : ""}
                  </span>
                  <span className="truncate">{route.apiFormat ?? "跟随"}</span>
                  <span className="truncate">
                    {[
                      ...route.models,
                      ...route.prefixes.map((prefix) => `${prefix}*`),
                    ]
                      .slice(0, 3)
                      .join(", ") || "默认"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {diagnostics.routerLog.recentEvents.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-slate-700">
              <div className="grid grid-cols-[1fr_0.9fr_0.9fr_0.6fr_2fr] gap-2 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-300">
                <span>时间</span>
                <span>事件</span>
                <span>Provider</span>
                <span>状态</span>
                <span>摘要</span>
              </div>
              {diagnostics.routerLog.recentEvents.slice(0, 12).map((event) => (
                <div
                  key={`${event.timestamp}-${event.event}-${event.line}`}
                  className="grid grid-cols-[1fr_0.9fr_0.9fr_0.6fr_2fr] gap-2 border-t border-slate-800 px-3 py-2 text-xs text-slate-300"
                >
                  <span className="truncate">{event.timestamp}</span>
                  <span className="truncate font-mono">{event.event}</span>
                  <span className="truncate">
                    {event.outerProvider && event.effectiveProvider
                      ? `${event.outerProvider} -> ${event.effectiveProvider}`
                      : (event.provider ?? "-")}
                  </span>
                  <span className="truncate">{event.status ?? "-"}</span>
                  <span className="truncate" title={event.line}>
                    {event.error ?? event.model ?? event.line}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Debug 阻塞项/警告列表，避免用户在检查卡片里逐项翻找最关键结论。
function DebugIssueList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "fail" | "warn";
  items: string[];
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm",
        tone === "fail"
          ? "border-rose-500/40 bg-rose-500/10 text-rose-100"
          : "border-amber-500/40 bg-amber-500/10 text-amber-100",
      )}
    >
      <div className="mb-2 font-semibold">{title}</div>
      <div className="space-y-1 text-xs leading-5 opacity-85">
        {items.map((item) => (
          <div key={item}>{item}</div>
        ))}
      </div>
    </div>
  );
}

/// 单个 Debug 检查项卡片，展示状态、说明和后端返回的关键证据。
function DiagnosticCheckCard({ check }: { check: CodexDiagnosticCheck }) {
  const meta = diagnosticStatusMeta(check.status);
  const Icon = meta.icon;

  return (
    <div className={cn("rounded-lg border p-3", meta.className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{check.label}</div>
          <div className="mt-1 text-xs leading-5 opacity-80">
            {check.detail}
          </div>
        </div>
        <Icon className="h-4 w-4 shrink-0 opacity-85" />
      </div>
      {check.evidence.length > 0 && (
        <div className="mt-2 space-y-1 font-mono text-[11px] opacity-70">
          {check.evidence.slice(0, 3).map((item) => (
            <div key={item} className="truncate" title={item}>
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// 将后端诊断状态映射成 UI 颜色和图标。
function diagnosticStatusMeta(status: CodexDiagnosticStatus): {
  icon: React.ComponentType<{ className?: string }>;
  className: string;
} {
  switch (status) {
    case "pass":
      return {
        icon: CheckCircle2,
        className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-100",
      };
    case "warn":
      return {
        icon: AlertTriangle,
        className: "border-amber-500/40 bg-amber-500/10 text-amber-100",
      };
    case "fail":
      return {
        icon: XCircle,
        className: "border-rose-500/40 bg-rose-500/10 text-rose-100",
      };
    case "info":
    default:
      return {
        icon: Info,
        className: "border-blue-500/40 bg-blue-500/10 text-blue-100",
      };
  }
}

/// 状态卡用于表达在线/离线这类二值信号，避免用户在长文本里找关键状态。
function StatusCard({
  ok,
  label,
  value,
  detail,
}: {
  ok: boolean;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        ok
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
          : "border-amber-500/40 bg-amber-500/10 text-amber-100",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs opacity-80">{label}</span>
        <span className="h-2.5 w-2.5 rounded-full bg-current" />
      </div>
      <div className="mt-2 text-lg font-semibold text-white">{value}</div>
      <div className="mt-1 truncate text-xs opacity-75" title={detail}>
        {detail}
      </div>
    </div>
  );
}

/// 指标卡使用不同主题色，帮助用户快速区分状态而不是看到一片灰。
function MetricCard({
  color,
  icon: Icon,
  label,
  value,
  detail,
}: {
  color: "blue" | "emerald" | "amber" | "rose";
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
}) {
  const styles = {
    blue: "border-blue-500/40 bg-blue-500/10 text-blue-200",
    emerald: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    rose: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  }[color];

  return (
    <div className={cn("rounded-lg border p-3", styles)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs opacity-80">{label}</span>
        <Icon className="h-4 w-4 opacity-80" />
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
      <div className="mt-1 text-xs opacity-75">{detail}</div>
    </div>
  );
}

/// 流程步骤用于解释这套逻辑如何从模型源变成 Codex 可用的多模型入口。
function FlowStep({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-blue-600 text-xs font-bold text-white">
          {index}
        </span>
        <span className="text-sm font-semibold text-slate-100">{title}</span>
      </div>
      <div className="mt-2 text-xs leading-5 text-slate-400">{detail}</div>
    </div>
  );
}

/// 通用标题行，统一不同页面区块的操作按钮位置。
function SectionHeader({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <Icon className="h-4 w-4 text-blue-300" />
          {title}
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-400">{detail}</p>
      </div>
      {action}
    </div>
  );
}

/// 路由方案卡片内容；外层决定是按钮还是静态容器。
function PlanCardContent({
  provider,
  compact = false,
}: {
  provider: Provider;
  compact?: boolean;
}) {
  const routing = readCodexRouting(provider);
  const routes = routing?.routes ?? [];

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate font-semibold text-slate-100">
          {provider.name}
        </span>
        <Badge
          className={cn(
            "border",
            routing?.enabled === false
              ? "border-slate-500/50 bg-slate-500/10 text-slate-200"
              : "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
          )}
        >
          {routing?.enabled === false ? "入口已停用" : "入口已启用"}
        </Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
        <span>规则 {routes.length} 条</span>
        {routing?.defaultRouteId && <span>默认 {routing.defaultRouteId}</span>}
        {!compact && <span>ID {provider.id}</span>}
      </div>
    </div>
  );
}

/// 路由规则按钮，比普通卡片有更明显的 hover 和 active 态。
function RouteListButton({
  entry,
  providersById,
  active = false,
  onClick,
}: {
  entry: RouteEntry;
  providersById: Map<string, Provider>;
  active?: boolean;
  onClick: () => void;
}) {
  const format = routeApiFormat(entry.route);
  const targetProvider = routeTargetProvider(entry.route, providersById);

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group rounded-lg border p-3 text-left transition",
        active
          ? "border-emerald-400 bg-emerald-600/20 shadow-[0_0_0_1px_rgba(52,211,153,0.3)]"
          : "border-slate-700 bg-slate-950/40 hover:border-emerald-400 hover:bg-emerald-950/20",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-100">
            {entry.route.label || entry.route.id || "未命名规则"}
          </div>
          <div className="mt-1 truncate text-xs text-slate-400">
            所属多路路由：{entry.provider.name}
          </div>
        </div>
        <Badge
          className={cn(
            "border",
            entry.route.enabled === false
              ? "border-slate-500/50 bg-slate-500/10 text-slate-200"
              : "border-emerald-500/50 bg-emerald-500/15 text-emerald-100",
          )}
        >
          {entry.route.enabled === false ? "规则停用" : "规则已启用"}
        </Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-blue-100">
          {targetProvider ? "复用供应商配置" : apiFormatLabel(format)}
        </span>
        <span className="rounded-full border border-slate-600 bg-slate-900 px-2 py-0.5 text-slate-300">
          {targetProvider
            ? `目标：${targetProvider.name}`
            : authSourceLabel(entry.route.upstream?.auth?.source)}
        </span>
      </div>
      <div className="mt-2 truncate text-xs text-slate-400">
        {routeMatchSummary(entry.route)}
      </div>
    </button>
  );
}

/// 右侧规则详情，把“查看、编辑、删除入口、复制模型名”分开展示，减少不可操作感。
function RouteDetailPanel({
  selectedRoute,
  selectedPlan,
  providersById,
  onEditPlan,
}: {
  selectedRoute?: RouteEntry;
  selectedPlan: Provider | null;
  providersById: Map<string, Provider>;
  onEditPlan: (provider: Provider, detail?: string) => void;
}) {
  if (!selectedRoute) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
        <EmptyState
          icon={Route}
          title="请选择一条规则"
          detail="左侧点击规则后，这里会展示上游、匹配条件和操作入口。"
          actionLabel={selectedPlan ? "编辑多路路由" : "创建多路路由"}
          onAction={() => selectedPlan && onEditPlan(selectedPlan)}
        />
      </section>
    );
  }

  const route = selectedRoute.route;
  const matchedModels = route.match?.models ?? [];
  const targetProviderId = routeTargetProviderId(route);
  const targetProvider = routeTargetProvider(route, providersById);

  return (
    <section className="rounded-lg border border-emerald-700/40 bg-slate-950/50 p-4">
      <SectionHeader
        icon={Database}
        title={route.label || route.id || "规则详情"}
        detail="这里是当前规则的只读摘要；修改和删除会进入配置表单。"
        action={
          <Button
            size="sm"
            onClick={() =>
              onEditPlan(selectedRoute.provider, "编辑或删除当前路由规则")
            }
            className="gap-2 bg-emerald-600 hover:bg-emerald-500"
          >
            <Pencil className="h-4 w-4" />
            编辑
          </Button>
        }
      />
      <div className="mt-4 space-y-3 text-sm">
        <DetailRow label="匹配条件" value={routeMatchSummary(route)} />
        {targetProviderId ? (
          <DetailRow
            label="目标供应商"
            value={
              targetProvider
                ? `${targetProvider.name} (${targetProvider.id})`
                : `未找到目标供应商：${targetProviderId}`
            }
          />
        ) : null}
        <DetailRow
          label="上游地址"
          value={routeBaseUrl(route, providersById)}
        />
        <DetailRow
          label="接口类型"
          value={
            targetProvider
              ? "跟随目标供应商"
              : apiFormatLabel(routeApiFormat(route))
          }
        />
        <DetailRow
          label="认证方式"
          value={
            targetProvider
              ? "跟随目标供应商"
              : authSourceLabel(route.upstream?.auth?.source)
          }
        />
        <DetailRow
          label="能力"
          value={[
            route.capabilities?.textOnly ? "仅文本" : "图文",
            route.capabilities?.supportsReasoning ? "推理" : null,
          ]
            .filter(Boolean)
            .join(" / ")}
        />
      </div>
      <div className="mt-4 grid gap-2">
        <Button
          variant="outline"
          className="justify-start gap-2"
          onClick={() =>
            navigator.clipboard?.writeText(matchedModels.join(", "))
          }
          disabled={matchedModels.length === 0}
        >
          <Clipboard className="h-4 w-4" />
          复制精确模型名
        </Button>
        <Button
          variant="outline"
          className="justify-start gap-2 text-rose-200 hover:text-rose-100"
          onClick={() =>
            onEditPlan(selectedRoute.provider, "打开表单后可删除当前规则")
          }
        >
          <Trash2 className="h-4 w-4" />
          删除入口在编辑表单中
        </Button>
      </div>
    </section>
  );
}

/// 只读详情行，避免信息散落成难扫描的长段落。
function DetailRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 break-words text-slate-200">{value || "未配置"}</div>
    </div>
  );
}

/// 模型源迷你卡，仅用于总览页快速提示。
function SourceMiniCard({ provider }: { provider: Provider }) {
  return (
    <div className="rounded-lg border border-amber-700/30 bg-slate-950/40 p-3">
      <div className="truncate text-sm font-semibold text-slate-100">
        {provider.name}
      </div>
      <div className="mt-1 truncate text-xs text-slate-400">{provider.id}</div>
    </div>
  );
}

/// 发布检查项用色彩表达状态，避免所有信息都像普通文字。
function ChecklistItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border p-3 text-sm",
        ok
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
          : "border-amber-500/40 bg-amber-500/10 text-amber-100",
      )}
    >
      <CheckCircle2 className="h-4 w-4" />
      {label}
    </div>
  );
}

/// 空状态组件带明确动作按钮，让无数据场景仍可继续操作。
function EmptyState({
  icon: Icon,
  title,
  detail,
  actionLabel,
  onAction,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  actionLabel: string;
  onAction?: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 p-5">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 text-slate-400" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-100">{title}</div>
          <p className="mt-1 text-sm leading-6 text-slate-400">{detail}</p>
          {onAction && (
            <Button
              size="sm"
              variant="outline"
              onClick={onAction}
              className="mt-3"
            >
              {actionLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
