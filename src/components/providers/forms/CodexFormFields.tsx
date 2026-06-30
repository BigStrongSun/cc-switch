import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormLabel } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  Download,
  Loader2,
  Pencil,
  Plus,
  Route,
  Trash2,
} from "lucide-react";
import EndpointSpeedTest from "./EndpointSpeedTest";
import { ApiKeySection, EndpointField, ModelDropdown } from "./shared";
import {
  fetchModelsForConfig,
  probeCodexChatForConfig,
  probeCodexResponsesForConfig,
  showFetchModelsError,
  type CodexResponsesProbeResult,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { CustomUserAgentField } from "./CustomUserAgentField";
import { LocalProxyRequestOverridesField } from "./LocalProxyRequestOverridesField";
import { cn } from "@/lib/utils";
import { resolveFetchedCodexModelContextWindow } from "@/utils/codexModelContext";
import type {
  CodexApiFormat,
  CodexCatalogModel,
  CodexChatReasoning,
  CodexRoutingConfig,
  CodexRoutingRoute,
  CodexRoutingAuthSource,
  ProviderCategory,
} from "@/types";

interface EndpointCandidate {
  url: string;
}

interface CodexProtocolProbeOutcome {
  model: string;
  responses: CodexResponsesProbeResult;
  chat: CodexResponsesProbeResult;
}

// 把单模型双协议探测结果归类，供汇总文案和协议自动选择复用。
function classifyProtocolProbeOutcome(outcome: CodexProtocolProbeOutcome) {
  if (outcome.responses.ok && outcome.chat.ok) return "both";
  if (outcome.responses.ok) return "responses";
  if (outcome.chat.ok) return "chat";
  return "failed";
}

// 将模型名压缩成适合内联展示的列表，避免大量模型时把表单撑爆。
function summarizeProbeModels(
  outcomes: CodexProtocolProbeOutcome[],
  limit = 4,
) {
  if (outcomes.length === 0) return "";
  const names = outcomes.slice(0, limit).map((outcome) => outcome.model);
  return `${names.join("、")}${outcomes.length > limit ? ` 等 ${outcomes.length} 个` : ""}`;
}

// 生成每个协议探测分类的摘要，确保用户能同时看到其它模型是成功、部分成功还是失败。
export function summarizeCodexProtocolProbeOutcomes(
  outcomes: CodexProtocolProbeOutcome[],
) {
  const groups = {
    both: outcomes.filter(
      (outcome) => classifyProtocolProbeOutcome(outcome) === "both",
    ),
    responses: outcomes.filter(
      (outcome) => classifyProtocolProbeOutcome(outcome) === "responses",
    ),
    chat: outcomes.filter(
      (outcome) => classifyProtocolProbeOutcome(outcome) === "chat",
    ),
    failed: outcomes.filter(
      (outcome) => classifyProtocolProbeOutcome(outcome) === "failed",
    ),
  };

  const details = [
    groups.both.length > 0
      ? `双协议通过：${summarizeProbeModels(groups.both)}`
      : "",
    groups.responses.length > 0
      ? `仅 Responses 通过：${summarizeProbeModels(groups.responses)}`
      : "",
    groups.chat.length > 0
      ? `仅 Chat 通过：${summarizeProbeModels(groups.chat)}`
      : "",
    groups.failed.length > 0
      ? `双协议失败：${groups.failed
          .slice(0, 3)
          .map(
            (outcome) =>
              `${outcome.model}（Responses=${outcome.responses.detail}; Chat=${outcome.chat.detail}）`,
          )
          .join("；")}${groups.failed.length > 3 ? "；..." : ""}`
      : "",
  ].filter(Boolean);

  return {
    responsesPass: groups.both.length + groups.responses.length,
    chatPass: groups.both.length + groups.chat.length,
    failedCount: groups.failed.length,
    detail: details.length > 0 ? ` 结果明细：${details.join("；")}。` : "",
  };
}

// 根据真实探测结果生成拆分建议：双协议通过默认归入 Responses，只 Chat 通过归入 Chat，双失败不参与建议。
function buildSplitCodexProviderSuggestionForProbeOutcomes({
  providerName,
  outcomes,
}: {
  providerName?: string;
  outcomes: CodexProtocolProbeOutcome[];
}): CodexProviderSplitSuggestion | null {
  const responsesModels = outcomes
    .filter((outcome) => {
      const kind = classifyProtocolProbeOutcome(outcome);
      return kind === "both" || kind === "responses";
    })
    .map((outcome) => outcome.model);
  const chatModels = outcomes
    .filter((outcome) => classifyProtocolProbeOutcome(outcome) === "chat")
    .map((outcome) => outcome.model);

  if (responsesModels.length === 0 || chatModels.length === 0) return null;
  return {
    providerName: providerName?.trim() || "provider",
    responsesModels,
    chatModels,
  };
}

// 为模型行生成紧凑的协议状态 tag，用户不需要回读长摘要也能知道每个模型该走哪种协议。
function getProtocolProbeBadge(outcome?: CodexProtocolProbeOutcome) {
  if (!outcome) return null;
  const kind = classifyProtocolProbeOutcome(outcome);
  if (kind === "both") {
    return {
      label: "双协议",
      title: `Responses=${outcome.responses.detail}; Chat=${outcome.chat.detail}`,
      className:
        "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (kind === "responses") {
    return {
      label: "Responses",
      title: `Responses=${outcome.responses.detail}; Chat=${outcome.chat.detail}`,
      className:
        "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (kind === "chat") {
    return {
      label: "Chat",
      title: `Responses=${outcome.responses.detail}; Chat=${outcome.chat.detail}`,
      className:
        "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    };
  }
  return {
    label: "不可用",
    title: `Responses=${outcome.responses.detail}; Chat=${outcome.chat.detail}`,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  };
}

interface CodexFormFieldsProps {
  providerId?: string;
  // 当前表单里的 provider 名称；自动生成混合协议 route 标签时使用。
  providerName?: string;
  // API Key
  codexApiKey: string;
  onApiKeyChange: (key: string) => void;
  category?: ProviderCategory;
  shouldShowApiKeyLink: boolean;
  websiteUrl: string;
  isPartner?: boolean;
  partnerPromotionKey?: string;

  // Base URL
  shouldShowSpeedTest: boolean;
  codexBaseUrl: string;
  onBaseUrlChange: (url: string) => void;
  isFullUrl: boolean;
  onFullUrlChange: (value: boolean) => void;
  isEndpointModalOpen: boolean;
  onEndpointModalToggle: (open: boolean) => void;
  onCustomEndpointsChange?: (endpoints: string[]) => void;
  autoSelect: boolean;
  onAutoSelectChange: (checked: boolean) => void;

  // Local routing / takeover
  // takeoverEnabled gates model mapping + reasoning visibility; it is decoupled
  // from the wire format so a native Responses provider can use model mapping
  // without Chat Completions conversion.
  takeoverEnabled: boolean;
  onTakeoverEnabledChange: (enabled: boolean) => void;

  // API Format
  // Note: wire_api is always "responses" for Codex; apiFormat controls proxy-layer conversion
  apiFormat: CodexApiFormat;
  onApiFormatChange: (format: CodexApiFormat) => void;
  codexChatReasoning?: CodexChatReasoning;
  onCodexChatReasoningChange?: (value: CodexChatReasoning) => void;

  // Model Catalog
  catalogModels?: CodexCatalogModel[];
  onCatalogModelsChange?: (models: CodexCatalogModel[]) => void;
  spawnAgentModels?: string[];
  onSpawnAgentModelsChange?: (models: string[]) => void;
  codexRouting?: CodexRoutingConfig;
  onCodexRoutingChange?: (routing: CodexRoutingConfig) => void;
  onProviderSplitSuggestionChange?: (
    suggestion: CodexProviderSplitSuggestion | null,
  ) => void;

  // Speed Test Endpoints
  speedTestEndpoints: EndpointCandidate[];

  // Local proxy User-Agent override
  customUserAgent: string;
  onCustomUserAgentChange: (value: string) => void;
  localProxyHeadersOverride: string;
  onLocalProxyHeadersOverrideChange: (value: string) => void;
  localProxyBodyOverride: string;
  onLocalProxyBodyOverrideChange: (value: string) => void;
}

type CodexCatalogRow = CodexCatalogModel & { rowId: string };

type CodexRoutingRow = CodexRoutingRoute & { rowId: string };

export interface CodexProviderSplitSuggestion {
  providerName: string;
  responsesModels: string[];
  chatModels: string[];
}

function createCatalogRow(seed?: Partial<CodexCatalogModel>): CodexCatalogRow {
  return {
    rowId: crypto.randomUUID(),
    model: seed?.model ?? "",
    upstreamModel: seed?.upstreamModel ?? seed?.upstream_model ?? "",
    displayName: seed?.displayName ?? "",
    contextWindow: seed?.contextWindow ?? "",
  };
}

// 读取 catalog 行的真实上游模型名；为空时回退到可见模型名，兼容旧配置。
function catalogRowUpstreamModel(
  row: Pick<CodexCatalogModel, "model" | "upstreamModel" | "upstream_model">,
): string {
  return (row.upstreamModel ?? row.upstream_model ?? row.model ?? "").trim();
}

// 将逗号或换行分隔的字符串整理成 route 匹配列表。
function parseRoutingList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// 将 modelMap 的轻量文本编辑格式转成对象；格式为 `codexModel=upstreamModel`。
function parseModelMap(value: string): Record<string, string> | undefined {
  const entries = parseRoutingList(value)
    .map((item) => item.split("="))
    .map(([from, to]) => [from?.trim(), to?.trim()] as const)
    .filter(([from, to]) => from && to);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// 将 modelMap 对象转成表单里便于扫描和编辑的单行文本。
function formatModelMap(modelMap?: Record<string, string>): string {
  return modelMap
    ? Object.entries(modelMap)
        .map(([from, to]) => `${from}=${to}`)
        .join(", ")
    : "";
}

function createRoutingRow(seed?: Partial<CodexRoutingRoute>): CodexRoutingRow {
  return {
    rowId: crypto.randomUUID(),
    id: seed?.id ?? `route-${Math.random().toString(36).slice(2, 8)}`,
    label: seed?.label ?? "",
    enabled: seed?.enabled ?? true,
    targetProviderId: seed?.targetProviderId,
    match: {
      models: seed?.match?.models ?? [],
      prefixes: seed?.match?.prefixes ?? [],
    },
    upstream: {
      baseUrl: seed?.upstream?.baseUrl ?? "",
      apiFormat: seed?.upstream?.apiFormat ?? "openai_chat",
      auth: seed?.upstream?.auth ?? { source: "provider_config" },
      apiKey: seed?.upstream?.apiKey ?? "",
      modelMap: seed?.upstream?.modelMap,
    },
    capabilities: seed?.capabilities,
  };
}

// 比较路由数据时忽略 rowId，避免父子状态同步造成重复刷新。
function routingRowsMatchConfig(
  rows: CodexRoutingRow[],
  config?: CodexRoutingConfig,
): boolean {
  const routes = config?.routes ?? [];
  if (rows.length !== routes.length) return false;
  return rows.every((row, index) => {
    const { rowId: _rowId, ...route } = row;
    return JSON.stringify(route) === JSON.stringify(routes[index]);
  });
}

// Compares rows (with rowId) to incoming models (without) by data fields only,
// so both sync effects can use the same equality definition.
function catalogRowsMatchModels(
  rows: Array<
    Pick<
      CodexCatalogRow,
      | "model"
      | "upstreamModel"
      | "upstream_model"
      | "displayName"
      | "contextWindow"
    >
  >,
  models: CodexCatalogModel[],
): boolean {
  if (rows.length !== models.length) return false;
  return rows.every((row, i) => {
    const incoming = models[i];
    return (
      row.model === (incoming.model ?? "") &&
      catalogRowUpstreamModel(row) === catalogRowUpstreamModel(incoming) &&
      (row.displayName ?? "") === (incoming.displayName ?? "") &&
      String(row.contextWindow ?? "") === String(incoming.contextWindow ?? "")
    );
  });
}

// 将远端 /models 返回合并进 Codex 模型映射；已有行保留用户显示名，只补空上下文和新增模型。
function mergeFetchedModelsIntoCatalogRows(
  rows: CodexCatalogRow[],
  fetchedModels: FetchedModel[],
  source: {
    providerId?: string;
    providerName?: string;
    baseUrl?: string;
    websiteUrl?: string;
  } = {},
): CodexCatalogRow[] {
  const next = [...rows];
  const rowByFetchedModel = new Map<
    string,
    { row: CodexCatalogRow; index: number }
  >();
  next.forEach((row, index) => {
    const upstreamModel = catalogRowUpstreamModel(row);
    if (upstreamModel) {
      rowByFetchedModel.set(upstreamModel, { row, index });
    }
    const visibleModel = row.model.trim();
    if (visibleModel && !rowByFetchedModel.has(visibleModel)) {
      rowByFetchedModel.set(visibleModel, { row, index });
    }
  });

  for (const fetched of fetchedModels) {
    const model = fetched.id.trim();
    if (!model) continue;
    const contextWindow = resolveFetchedCodexModelContextWindow(fetched, {
      ...source,
      existingModels: rows,
    });
    const contextWindowText = contextWindow ? String(contextWindow) : undefined;
    const existing = rowByFetchedModel.get(model);
    if (existing) {
      if (!existing.row.contextWindow && contextWindowText) {
        next[existing.index] = {
          ...existing.row,
          contextWindow: contextWindowText,
        };
      }
      continue;
    }
    const row = createCatalogRow({
      model,
      upstreamModel: model,
      displayName: model,
      ...(contextWindowText ? { contextWindow: contextWindowText } : {}),
    });
    rowByFetchedModel.set(model, { row, index: next.length });
    next.push(row);
  }

  return next;
}

// 判断模型名是否大概率属于支持 Responses 的 OpenAI/GPT 系列。
// 这里故意只做保守启发式，避免把 qwen/deepseek 等中转模型误归到 Responses route。
export function isLikelyCodexResponsesModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  const lastSegment =
    normalized.split(/[/:]/).filter(Boolean).pop() ?? normalized;
  return /^(gpt-|gpt\d|o[1345](?:-|$)|chatgpt-|codex-)/.test(lastSegment);
}

// 将 /models 结果按“原生 Responses 候选”和“需要 Chat 转换候选”分组。
export function splitFetchedModelsByLikelyCodexProtocol(
  models: FetchedModel[],
): { responses: string[]; chat: string[] } {
  const responses: string[] = [];
  const chat: string[] = [];
  const seen = new Set<string>();

  for (const fetched of models) {
    const id = fetched.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (isLikelyCodexResponsesModel(id)) {
      responses.push(id);
    } else {
      chat.push(id);
    }
  }

  return { responses, chat };
}

// 为同一个中转 provider 生成“拆成两个 provider”的建议；GPT-like 走 Responses，非 GPT-like 走 Chat 转换。
export function buildSplitCodexProviderSuggestionForFetchedModels({
  providerName,
  models,
}: {
  providerName?: string;
  models: FetchedModel[];
}): CodexProviderSplitSuggestion | null {
  const split = splitFetchedModelsByLikelyCodexProtocol(models);
  if (split.responses.length === 0 || split.chat.length === 0) return null;

  const labelBase = providerName?.trim() || "provider";
  return {
    providerName: labelBase,
    responsesModels: split.responses,
    chatModels: split.chat,
  };
}

export function CodexFormFields({
  providerId,
  providerName,
  codexApiKey,
  onApiKeyChange,
  category,
  shouldShowApiKeyLink,
  websiteUrl,
  isPartner,
  partnerPromotionKey,
  shouldShowSpeedTest,
  codexBaseUrl,
  onBaseUrlChange,
  isFullUrl,
  onFullUrlChange,
  isEndpointModalOpen,
  onEndpointModalToggle,
  onCustomEndpointsChange,
  autoSelect,
  onAutoSelectChange,
  takeoverEnabled,
  onTakeoverEnabledChange,
  apiFormat,
  onApiFormatChange,
  codexChatReasoning = {},
  onCodexChatReasoningChange,
  catalogModels = [],
  onCatalogModelsChange,
  spawnAgentModels = [],
  onSpawnAgentModelsChange,
  codexRouting = { enabled: false, defaultRouteId: "", routes: [] },
  onCodexRoutingChange,
  onProviderSplitSuggestionChange,
  speedTestEndpoints,
  customUserAgent,
  onCustomUserAgentChange,
  localProxyHeadersOverride,
  onLocalProxyHeadersOverrideChange,
  localProxyBodyOverride,
  onLocalProxyBodyOverrideChange,
}: CodexFormFieldsProps) {
  const { t } = useTranslation();

  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isProtocolProbeConfirmOpen, setIsProtocolProbeConfirmOpen] =
    useState(false);
  const [isProbingProtocol, setIsProbingProtocol] = useState(false);
  const [protocolProbeSummary, setProtocolProbeSummary] = useState("");
  const [protocolProbeTone, setProtocolProbeTone] = useState<
    "muted" | "success" | "warning" | "error"
  >("muted");
  const [protocolProbeOutcomesByModel, setProtocolProbeOutcomesByModel] =
    useState<Record<string, CodexProtocolProbeOutcome>>({});
  const [shouldHighlightFetchModels, setShouldHighlightFetchModels] =
    useState(false);
  const [pendingSplitRouting, setPendingSplitRouting] =
    useState<CodexProviderSplitSuggestion | null>(null);
  const [editingRouteIndex, setEditingRouteIndex] = useState<number | null>(
    null,
  );
  // takeoverEnabled 控制模型映射/思考能力的显示；isChatFormat 仅在选了
  // Chat Completions 上游格式时为真（思考能力是 Chat 专属）。
  const isChatFormat = apiFormat === "openai_chat";
  const canEditCatalog = Boolean(onCatalogModelsChange);
  const canEditRouting = Boolean(onCodexRoutingChange);
  const canEditReasoning = Boolean(onCodexChatReasoningChange);
  const supportsThinking =
    codexChatReasoning.supportsThinking === true ||
    codexChatReasoning.supportsEffort === true;
  const supportsEffort = codexChatReasoning.supportsEffort === true;
  const selectedSpawnAgentModelSet = new Set(spawnAgentModels);

  // takeoverEnabled 取代了旧的 needsLocalRouting：上游格式已与路由解耦。
  // takeoverEnabled 为真说明预设/用户启用了本地路由；请求头/请求体覆盖也算高级值。
  const hasRequestOverrides = Boolean(
    localProxyHeadersOverride.trim() || localProxyBodyOverride.trim(),
  );
  const hasAnyAdvancedValue =
    !!customUserAgent || hasRequestOverrides || takeoverEnabled;
  const [advancedExpanded, setAdvancedExpanded] = useState(hasAnyAdvancedValue);

  // 预设/编辑加载填充高级值后自动展开（仅从折叠→展开，不会自动折叠）
  useEffect(() => {
    if (hasAnyAdvancedValue) {
      setAdvancedExpanded(true);
    }
  }, [hasAnyAdvancedValue]);

  const [catalogRows, setCatalogRows] = useState<CodexCatalogRow[]>(() =>
    catalogModels.map((m) => createCatalogRow(m)),
  );
  const catalogRowsRef = useRef<CodexCatalogRow[]>(catalogRows);
  const modelMappingSectionRef = useRef<HTMLDivElement | null>(null);
  const fetchModelsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [routingRows, setRoutingRows] = useState<CodexRoutingRow[]>(() =>
    (codexRouting.routes ?? []).map((route) => createRoutingRow(route)),
  );

  // 记录上次发送给父组件的数据，避免重复触发
  const lastSentModelsRef = useRef<CodexCatalogModel[]>(catalogModels);
  const lastSentRoutingRef = useRef<CodexRoutingConfig>(codexRouting);
  const catalogPropKeyRef = useRef(JSON.stringify(catalogModels));
  const routingPropKeyRef = useRef(JSON.stringify(codexRouting));
  const skipCatalogEchoRef = useRef(false);
  const skipRoutingEchoRef = useRef(false);

  // 保留最新的模型映射行给异步刷新回调用，避免点击“获取模型列表”时合并到旧闭包里的 catalogRows。
  useEffect(() => {
    catalogRowsRef.current = catalogRows;
  }, [catalogRows]);

  const revealModelCatalogFetchAction = useCallback(() => {
    setAdvancedExpanded(true);
    setProtocolProbeTone("warning");
    setProtocolProbeSummary(
      "请先在下方“模型映射”右上角点击“获取模型列表”，或手动添加模型后再测试。",
    );
    setShouldHighlightFetchModels(true);
    window.setTimeout(() => {
      modelMappingSectionRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      fetchModelsButtonRef.current?.focus({ preventScroll: true });
    }, 0);
    window.setTimeout(() => setShouldHighlightFetchModels(false), 3000);
  }, []);

  // 父 → 子：仅当 prop 数据真的变化（预设切换 / 编辑加载）时才重建 rowId；
  // 同 shape 时保留现有 rowId，避免编辑过程中焦点丢失。
  useEffect(() => {
    const incomingCatalogKey = JSON.stringify(catalogModels);
    const isExternalCatalogChange =
      incomingCatalogKey !== catalogPropKeyRef.current;
    catalogPropKeyRef.current = incomingCatalogKey;

    setCatalogRows((current) => {
      if (catalogRowsMatchModels(current, catalogModels)) return current;
      if (isExternalCatalogChange) {
        skipCatalogEchoRef.current = true;
      }
      return catalogModels.map((m) => createCatalogRow(m));
    });
    // 同步更新 ref，避免父组件传入新数据时子→父 effect 误判为本地修改
    lastSentModelsRef.current = catalogModels;
  }, [catalogModels]);

  // 父 → 子：外部加载或 preset 切换时同步 route 列表，保留编辑过程中的 rowId 稳定性。
  useEffect(() => {
    const incomingRoutingKey = JSON.stringify(codexRouting);
    const isExternalRoutingChange =
      incomingRoutingKey !== routingPropKeyRef.current;
    routingPropKeyRef.current = incomingRoutingKey;

    setRoutingRows((current) => {
      if (routingRowsMatchConfig(current, codexRouting)) return current;
      if (isExternalRoutingChange) {
        skipRoutingEchoRef.current = true;
      }
      return (codexRouting.routes ?? []).map((route) =>
        createRoutingRow(route),
      );
    });
    lastSentRoutingRef.current = codexRouting;
  }, [codexRouting]);

  // 子 → 父：route rowId 不进入持久化，只把真正配置写回父组件。
  useEffect(() => {
    if (!onCodexRoutingChange) return;
    // 外部 provider 刚加载时，本地 routingRows 仍可能是上一帧的空数组；
    // 这一帧必须跳过反向回写，避免把刚加载出的路由覆盖为空。
    if (skipRoutingEchoRef.current) {
      if (!routingRowsMatchConfig(routingRows, codexRouting)) return;
      skipRoutingEchoRef.current = false;
    }
    const next: CodexRoutingConfig = {
      enabled: codexRouting.enabled ?? false,
      defaultRouteId: codexRouting.defaultRouteId ?? "",
      routes: routingRows.map(({ rowId: _rowId, ...route }) => route),
    };
    if (JSON.stringify(next) === JSON.stringify(lastSentRoutingRef.current))
      return;
    lastSentRoutingRef.current = next;
    onCodexRoutingChange(next);
  }, [
    routingRows,
    codexRouting.enabled,
    codexRouting.defaultRouteId,
    codexRouting,
    onCodexRoutingChange,
  ]);

  // 子 → 父：rowId 是视图层概念，不应进入持久化数据；剥离后再回传。
  // 注意：依赖数组不包含 catalogModels，避免父→子更新触发子→父回调形成循环。
  useEffect(() => {
    if (!onCatalogModelsChange) return;
    // 外部 catalog 同步进来时先等本地 rowId 重建完成，再允许子组件回写。
    if (skipCatalogEchoRef.current) {
      if (!catalogRowsMatchModels(catalogRows, catalogModels)) return;
      skipCatalogEchoRef.current = false;
    }
    const next: CodexCatalogModel[] = catalogRows.map(
      ({ rowId: _rowId, ...rest }) => rest,
    );
    // 只有当数据真的变化时才通知父组件
    if (catalogRowsMatchModels(catalogRows, lastSentModelsRef.current)) return;
    lastSentModelsRef.current = next;
    onCatalogModelsChange(next);
  }, [catalogRows, catalogModels, onCatalogModelsChange]);

  const handleReasoningThinkingChange = useCallback(
    (checked: boolean) => {
      if (!onCodexChatReasoningChange) return;
      onCodexChatReasoningChange({
        ...codexChatReasoning,
        supportsThinking: checked,
        supportsEffort: checked ? codexChatReasoning.supportsEffort : false,
      });
    },
    [codexChatReasoning, onCodexChatReasoningChange],
  );

  const handleReasoningEffortChange = useCallback(
    (checked: boolean) => {
      if (!onCodexChatReasoningChange) return;
      onCodexChatReasoningChange({
        ...codexChatReasoning,
        supportsThinking: checked ? true : codexChatReasoning.supportsThinking,
        supportsEffort: checked,
        effortParam: checked
          ? (codexChatReasoning.effortParam ?? "reasoning_effort")
          : "none",
      });
    },
    [codexChatReasoning, onCodexChatReasoningChange],
  );

  const handleFetchModels = useCallback(() => {
    if (!codexBaseUrl || !codexApiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!codexApiKey,
        hasBaseUrl: !!codexBaseUrl,
      });
      return;
    }
    setIsFetchingModels(true);
    fetchModelsForConfig(
      codexBaseUrl,
      codexApiKey,
      isFullUrl,
      undefined,
      customUserAgent,
    )
      .then((models) => {
        setFetchedModels(models);
        if (onCatalogModelsChange && models.length > 0) {
          const mergedRows = mergeFetchedModelsIntoCatalogRows(
            catalogRowsRef.current,
            models,
            {
              providerId,
              providerName,
              baseUrl: codexBaseUrl,
              websiteUrl,
            },
          );
          catalogRowsRef.current = mergedRows;
          setCatalogRows(mergedRows);
          const autoSelected = models
            .map((model) => {
              const upstreamModel = model.id.trim();
              return (
                mergedRows
                  .find((row) => catalogRowUpstreamModel(row) === upstreamModel)
                  ?.model.trim() ?? upstreamModel
              );
            })
            .filter((model): model is string => Boolean(model))
            .slice(0, 5);
          if (onSpawnAgentModelsChange && spawnAgentModels.length === 0) {
            onSpawnAgentModelsChange(autoSelected);
          }
        }
        const shouldAutoSplitRouting =
          models.length > 0 &&
          onProviderSplitSuggestionChange &&
          (codexRouting.routes?.length ?? 0) === 0;
        if (shouldAutoSplitRouting) {
          const splitRouting =
            buildSplitCodexProviderSuggestionForFetchedModels({
              providerName,
              models,
            });
          if (splitRouting) {
            setPendingSplitRouting(splitRouting);
          }
        }
        if (models.length === 0) {
          toast.info(t("providerForm.fetchModelsEmpty"));
        } else {
          toast.success(
            t("providerForm.fetchModelsSuccess", { count: models.length }),
          );
        }
      })
      .catch((err) => {
        console.warn("[ModelFetch] Failed:", err);
        showFetchModelsError(err, t);
      })
      .finally(() => setIsFetchingModels(false));
  }, [
    codexBaseUrl,
    codexApiKey,
    isFullUrl,
    customUserAgent,
    providerId,
    providerName,
    websiteUrl,
    onCatalogModelsChange,
    onSpawnAgentModelsChange,
    onProviderSplitSuggestionChange,
    codexRouting.routes,
    spawnAgentModels.length,
    t,
  ]);

  const handleProtocolProbe = useCallback(async () => {
    if (!codexBaseUrl || !codexApiKey) {
      showFetchModelsError(null, t, {
        hasApiKey: !!codexApiKey,
        hasBaseUrl: !!codexBaseUrl,
      });
      return;
    }
    const models = Array.from(
      new Set(
        [
          ...catalogRowsRef.current.map((row) => catalogRowUpstreamModel(row)),
          ...fetchedModels.map((model) => model.id.trim()),
        ].filter(Boolean),
      ),
    );
    if (models.length === 0) {
      setIsProtocolProbeConfirmOpen(false);
      toast.warning("请先点击“获取模型列表”，或手动添加至少一个模型。");
      revealModelCatalogFetchAction();
      return;
    }

    setIsProtocolProbeConfirmOpen(false);
    setIsProbingProtocol(true);
    setProtocolProbeTone("muted");
    setProtocolProbeOutcomesByModel({});
    setProtocolProbeSummary(
      `正在测试 ${models.length} 个模型的 Chat / Responses 基础连通性...`,
    );
    const outcomes: CodexProtocolProbeOutcome[] = [];
    try {
      for (const [index, model] of models.entries()) {
        setProtocolProbeSummary(
          `正在测试 ${index + 1}/${models.length}：${model}。请稍等，失败会在这里显示。`,
        );
        const responses = await probeCodexResponsesForConfig(
          codexBaseUrl,
          codexApiKey,
          model,
          isFullUrl,
          customUserAgent,
        );
        const chat = await probeCodexChatForConfig(
          codexBaseUrl,
          codexApiKey,
          model,
          isFullUrl,
          customUserAgent,
        );
        outcomes.push({ model, responses, chat });
      }

      const { responsesPass, chatPass, failedCount, detail } =
        summarizeCodexProtocolProbeOutcomes(outcomes);
      setProtocolProbeOutcomesByModel(
        Object.fromEntries(outcomes.map((outcome) => [outcome.model, outcome])),
      );
      const splitSuggestion = buildSplitCodexProviderSuggestionForProbeOutcomes(
        {
          providerName,
          outcomes,
        },
      );
      const canApplySplitSuggestion = Boolean(
        splitSuggestion && onProviderSplitSuggestionChange,
      );
      if (splitSuggestion && onProviderSplitSuggestionChange) {
        setPendingSplitRouting(splitSuggestion);
        onProviderSplitSuggestionChange(null);
      }

      if (responsesPass > 0) {
        onApiFormatChange("openai_responses");
        const summary =
          chatPass > 0
            ? `Responses 和 Chat 的基础请求都有模型可用，已优先切换为 Responses。Responses 通过 ${responsesPass}/${models.length}，Chat 通过 ${chatPass}/${models.length}。${
                canApplySplitSuggestion
                  ? "检测到真实协议结果混合，建议下一步拆成 Responses / Chat 两个 provider。"
                  : ""
              }通过不等于完整 Codex 功能验证。${detail}`
            : `只有 Responses 基础请求可用，已切换为 Responses。Responses 通过 ${responsesPass}/${models.length}。通过不等于完整 Codex 功能验证。${detail}`;
        const tone = failedCount > 0 ? "warning" : "success";
        setProtocolProbeTone(tone);
        setProtocolProbeSummary(summary);
        if (tone === "warning") {
          toast.warning(summary, { closeButton: true });
        } else {
          toast.success(summary, { closeButton: true });
        }
        return;
      }
      if (chatPass > 0) {
        onApiFormatChange("openai_chat");
        const summary = `Responses 不通但 Chat 可用，已切换为 Chat Completions。Chat 通过 ${chatPass}/${models.length}。${
          canApplySplitSuggestion
            ? "检测到真实协议结果混合，建议下一步拆成 Responses / Chat 两个 provider。"
            : ""
        }${detail}`;
        setProtocolProbeTone("warning");
        setProtocolProbeSummary(summary);
        toast.warning(summary, { closeButton: true });
        return;
      }

      const summary = `Responses 和 Chat Completions 都不通，请检查 API Key、Base URL、模型权限、额度、网络或上游状态。${detail}`;
      setProtocolProbeTone("error");
      setProtocolProbeSummary(summary);
      toast.error(summary, { closeButton: true });
    } catch (error) {
      const summary = `协议测试中断：${error instanceof Error ? error.message : String(error)}`;
      setProtocolProbeTone("error");
      setProtocolProbeSummary(summary);
      toast.error(summary, { closeButton: true });
    } finally {
      setIsProbingProtocol(false);
    }
  }, [
    codexBaseUrl,
    codexApiKey,
    customUserAgent,
    fetchedModels,
    isFullUrl,
    onApiFormatChange,
    onProviderSplitSuggestionChange,
    providerName,
    revealModelCatalogFetchAction,
    t,
  ]);

  const handleAddCatalogRow = useCallback(() => {
    if (!onCatalogModelsChange) return;
    setCatalogRows((current) => [...current, createCatalogRow()]);
  }, [onCatalogModelsChange]);

  const handleUpdateCatalogRow = useCallback(
    (index: number, patch: Partial<CodexCatalogModel>) => {
      setCatalogRows((current) =>
        current.map((row, i) => {
          if (i !== index) return row;
          const next = { ...row, ...patch };
          if (
            patch.model !== undefined &&
            patch.upstreamModel === undefined &&
            patch.upstream_model === undefined
          ) {
            const previousVisibleModel = row.model.trim();
            const previousUpstreamModel = catalogRowUpstreamModel(row);
            if (
              previousVisibleModel &&
              (!previousUpstreamModel ||
                previousUpstreamModel === previousVisibleModel)
            ) {
              next.upstreamModel = previousVisibleModel;
            }
          }
          return next;
        }),
      );
    },
    [],
  );

  const handleSelectFetchedCatalogModel = useCallback(
    (
      index: number,
      modelId: string,
      currentVisibleModel?: string,
      currentDisplayName?: string,
    ) => {
      const fetched = fetchedModels.find((model) => model.id === modelId);
      const contextWindow = fetched
        ? resolveFetchedCodexModelContextWindow(fetched, {
            providerId,
            baseUrl: codexBaseUrl,
            websiteUrl,
            existingModels: catalogRows,
          })
        : undefined;

      handleUpdateCatalogRow(index, {
        model: currentVisibleModel?.trim() ? currentVisibleModel : modelId,
        upstreamModel: modelId,
        displayName: currentDisplayName?.trim() ? currentDisplayName : modelId,
        ...(contextWindow ? { contextWindow: String(contextWindow) } : {}),
      });
    },
    [
      catalogRows,
      codexBaseUrl,
      fetchedModels,
      handleUpdateCatalogRow,
      providerId,
      websiteUrl,
    ],
  );

  const handleRemoveCatalogRow = useCallback((index: number) => {
    setCatalogRows((current) => current.filter((_, i) => i !== index));
  }, []);

  const handleToggleSpawnAgentModel = useCallback(
    (model: string, checked: boolean) => {
      if (!onSpawnAgentModelsChange) return;
      const normalized = model.trim();
      if (!normalized) return;

      if (!checked) {
        onSpawnAgentModelsChange(
          spawnAgentModels.filter((item) => item !== normalized),
        );
        return;
      }

      if (spawnAgentModels.includes(normalized)) return;
      if (spawnAgentModels.length >= 5) {
        toast.error(
          t("codexConfig.spawnAgentModelsLimit", {
            defaultValue: "子 Agent 候选最多只能选择 5 个模型",
          }),
        );
        return;
      }
      onSpawnAgentModelsChange([...spawnAgentModels, normalized]);
    },
    [onSpawnAgentModelsChange, spawnAgentModels, t],
  );

  const handleMoveSpawnAgentModel = useCallback(
    (model: string, direction: -1 | 1) => {
      if (!onSpawnAgentModelsChange) return;
      const index = spawnAgentModels.indexOf(model);
      const targetIndex = index + direction;
      if (
        index < 0 ||
        targetIndex < 0 ||
        targetIndex >= spawnAgentModels.length
      ) {
        return;
      }
      const next = [...spawnAgentModels];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      onSpawnAgentModelsChange(next);
    },
    [onSpawnAgentModelsChange, spawnAgentModels],
  );

  const handleConfirmSplitRouting = useCallback(() => {
    if (!pendingSplitRouting || !onProviderSplitSuggestionChange) return;
    onTakeoverEnabledChange(true);
    onProviderSplitSuggestionChange(pendingSplitRouting);
    setPendingSplitRouting(null);
    toast.info(
      `保存时将生成 ${pendingSplitRouting.providerName}-responses / ${pendingSplitRouting.providerName}-chat 两个 provider。`,
    );
  }, [
    onTakeoverEnabledChange,
    onProviderSplitSuggestionChange,
    pendingSplitRouting,
  ]);

  const handleCancelSplitRouting = useCallback(() => {
    setPendingSplitRouting(null);
    onProviderSplitSuggestionChange?.(null);
  }, [onProviderSplitSuggestionChange]);

  // 路由行的增删改必须同步写回父表单，避免用户切换开关后立即保存时仍提交上一帧旧值。
  const publishRoutingRows = useCallback(
    (
      rows: CodexRoutingRow[],
      patch: Partial<Omit<CodexRoutingConfig, "routes">> = {},
    ) => {
      if (!onCodexRoutingChange) return;
      const next: CodexRoutingConfig = {
        enabled: codexRouting.enabled ?? false,
        defaultRouteId: codexRouting.defaultRouteId ?? "",
        ...patch,
        routes: rows.map(({ rowId: _rowId, ...route }) => route),
      };
      lastSentRoutingRef.current = next;
      onCodexRoutingChange(next);
    },
    [codexRouting.defaultRouteId, codexRouting.enabled, onCodexRoutingChange],
  );

  const handleRoutingEnabledChange = useCallback(
    (checked: boolean) => {
      publishRoutingRows(routingRows, { enabled: checked });
    },
    [publishRoutingRows, routingRows],
  );

  const handleAddRoute = useCallback(() => {
    setRoutingRows((current) => {
      const next = [...current, createRoutingRow()];
      setEditingRouteIndex(current.length);
      publishRoutingRows(next);
      return next;
    });
  }, [publishRoutingRows]);

  const handleUpdateRoute = useCallback(
    (index: number, patch: Partial<CodexRoutingRoute>) => {
      setRoutingRows((current) => {
        const next = current.map((row, i) =>
          i === index ? { ...row, ...patch } : row,
        );
        publishRoutingRows(next);
        return next;
      });
    },
    [publishRoutingRows],
  );

  const handleRemoveRoute = useCallback(
    (index: number) => {
      setRoutingRows((current) => {
        const next = current.filter((_, i) => i !== index);
        publishRoutingRows(next);
        return next;
      });
      setEditingRouteIndex((current) => {
        if (current === null) return current;
        if (current === index) return null;
        return current > index ? current - 1 : current;
      });
    },
    [publishRoutingRows],
  );

  const editingRoute =
    editingRouteIndex !== null ? routingRows[editingRouteIndex] : undefined;
  const editingRouteModelsText = editingRoute
    ? (editingRoute.match.models ?? []).join(", ")
    : "";
  const editingRoutePrefixesText = editingRoute
    ? (editingRoute.match.prefixes ?? []).join(", ")
    : "";
  const editingRouteModelMapText = editingRoute
    ? formatModelMap(editingRoute.upstream.modelMap)
    : "";
  const editingRouteAuthSource =
    editingRoute?.upstream.auth.source ?? "provider_config";
  const editingRouteTextOnly = editingRoute?.capabilities?.textOnly === true;
  const editingRouteSupportsImage =
    editingRoute?.capabilities?.inputModalities?.includes("image") ??
    !editingRouteTextOnly;
  const splitRoutingProviderName = providerName?.trim() || "provider";
  const pendingResponsesModels = pendingSplitRouting?.responsesModels ?? [];
  const pendingChatModels = pendingSplitRouting?.chatModels ?? [];

  const renderCatalogActionButtons = (onAdd: () => void, addLabel: string) => (
    <div className="flex gap-1">
      <Button
        ref={fetchModelsButtonRef}
        type="button"
        variant="outline"
        size="sm"
        onClick={handleFetchModels}
        disabled={isFetchingModels}
        className={cn(
          "h-7 gap-1",
          shouldHighlightFetchModels &&
            "border-blue-500 bg-blue-50 text-blue-700 shadow-[0_0_0_3px_rgba(59,130,246,0.18)] dark:bg-blue-950/40 dark:text-blue-200",
        )}
      >
        {isFetchingModels ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
        {t("providerForm.fetchModels")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAdd}
        className="h-7 gap-1"
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );

  return (
    <>
      <Dialog
        open={isProtocolProbeConfirmOpen}
        onOpenChange={setIsProtocolProbeConfirmOpen}
      >
        <DialogContent className="max-w-lg" zIndex="top">
          <DialogHeader>
            <DialogTitle>确认测试 Chat / Responses</DialogTitle>
            <DialogDescription className="space-y-2 text-left">
              <span className="block">
                这个测试会帮助判断当前 provider 应该选择 Responses 还是 Chat
                Completions。它会对当前模型目录里的模型发送真实请求，可能产生少量额度或流量消耗，也可能触发限流。
              </span>
              <span className="block">
                如果还没有模型目录，请先到下方“模型映射”右上角点击“获取模型列表”，或手动添加至少一个模型。
              </span>
              <span className="block">
                每个模型会分别测试 /v1/responses 和
                /v1/chat/completions，输出上限为
                1024。都不通时通常不是协议问题，而是 API Key、Base
                URL、模型权限、额度、网络或上游故障。
              </span>
              <span className="block">
                注意：Responses 通过只证明最小非流式请求能返回成功，不等于完整
                Codex
                功能验证；真实会话里的流式输出、工具调用、长上下文和限流稳定性仍要继续观察。
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsProtocolProbeConfirmOpen(false)}
            >
              取消
            </Button>
            <Button type="button" onClick={handleProtocolProbe}>
              确认测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Codex API Key 输入框 */}
      <ApiKeySection
        id="codexApiKey"
        label="API Key"
        value={codexApiKey}
        onChange={onApiKeyChange}
        category={category}
        shouldShowLink={shouldShowApiKeyLink}
        websiteUrl={websiteUrl}
        isPartner={isPartner}
        partnerPromotionKey={partnerPromotionKey}
        placeholder={{
          official: t("providerForm.codexOfficialNoApiKey", {
            defaultValue: "官方供应商无需 API Key",
          }),
          thirdParty: t("providerForm.codexApiKeyAutoFill", {
            defaultValue: "输入 API Key，将自动填充到配置",
          }),
        }}
      />

      {/* Codex Base URL 输入框 */}
      {shouldShowSpeedTest && (
        <EndpointField
          id="codexBaseUrl"
          label={t("codexConfig.apiUrlLabel")}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          placeholder={t("providerForm.codexApiEndpointPlaceholder")}
          hint={t("providerForm.codexApiHint")}
          showFullUrlToggle
          isFullUrl={isFullUrl}
          onFullUrlChange={onFullUrlChange}
          onManageClick={() => onEndpointModalToggle(true)}
        />
      )}

      {canEditRouting && (
        <div className="space-y-4 rounded-lg border border-border-default p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>
                {t("codexConfig.localModelRoutingTitle", {
                  defaultValue: "Codex 多模型路由",
                })}
              </FormLabel>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("codexConfig.localModelRoutingHint", {
                  defaultValue:
                    "Codex 仍然连接一个本地 CC Switch 代理端点，但可按请求里的 body.model 分流到不同上游模型。",
                })}
              </p>
            </div>
            <Switch
              checked={codexRouting.enabled ?? false}
              onCheckedChange={handleRoutingEnabledChange}
              aria-label={t("codexConfig.localModelRoutingTitle", {
                defaultValue: "Codex 多模型路由",
              })}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <Input
              value={codexRouting.defaultRouteId ?? ""}
              onChange={(event) =>
                onCodexRoutingChange?.({
                  ...codexRouting,
                  defaultRouteId: event.target.value.trim(),
                })
              }
              placeholder={t("codexConfig.defaultRoutePlaceholder", {
                defaultValue: "默认路由 ID",
              })}
              className="max-w-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddRoute}
              className="h-8 gap-1"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("codexConfig.addRoute", { defaultValue: "添加路由" })}
            </Button>
          </div>

          <div className="min-h-[72px] space-y-3">
            {routingRows.length === 0 ? (
              <div className="rounded-md border border-dashed border-border-default bg-muted/10 px-3 py-4 text-xs text-muted-foreground">
                {t("codexConfig.noRoutesConfigured", {
                  defaultValue:
                    "还没有路由。添加 route 后，Codex 会按模型名分流到对应上游。",
                })}
              </div>
            ) : (
              routingRows.map((route, index) => {
                const matchedModels = route.match.models?.join(", ") || "-";
                const matchedPrefixes = route.match.prefixes?.join(", ") || "-";
                const capabilityLabels = [
                  route.capabilities?.textOnly ? "仅文本" : "图文",
                  route.capabilities?.supportsReasoning ? "推理" : null,
                ].filter(Boolean);

                return (
                  <div
                    key={route.rowId}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-md border p-3 transition-colors",
                      route.enabled === false
                        ? "border-amber-500/45 bg-amber-500/10"
                        : "border-emerald-500/45 bg-emerald-500/10",
                    )}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">
                          {route.label || route.id || "路由"}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {route.targetProviderId
                            ? `目标: ${route.targetProviderId}`
                            : route.upstream.apiFormat}
                        </span>
                        <span
                          className={cn(
                            "rounded border px-1.5 py-0.5 text-[11px] font-medium",
                            route.enabled === false
                              ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                              : "border-emerald-500/50 bg-emerald-500/15 text-emerald-200",
                          )}
                        >
                          {route.enabled === false ? "已停用" : "已启用"}
                        </span>
                        {capabilityLabels.map((label) => (
                          <span
                            key={label}
                            className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        匹配模型：{matchedModels}；匹配前缀：{matchedPrefixes}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {route.targetProviderId
                          ? `复用供应商配置：${route.targetProviderId}`
                          : route.upstream.baseUrl || "尚未填写上游 Base URL"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <label className="flex items-center gap-2 rounded-md border border-border-default bg-background/60 px-2 py-1 text-xs text-foreground">
                        <Switch
                          checked={route.enabled !== false}
                          onCheckedChange={(checked) =>
                            handleUpdateRoute(index, { enabled: checked })
                          }
                          aria-label={t("codexConfig.routeEnabled", {
                            defaultValue: "启用路由",
                          })}
                        />
                        {route.enabled === false ? "已停用" : "已启用"}
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-foreground/80 hover:text-foreground"
                        onClick={() => setEditingRouteIndex(index)}
                        title={t("codexConfig.editRoute", {
                          defaultValue: "编辑路由",
                        })}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-foreground/80 hover:text-destructive"
                        onClick={() => handleRemoveRoute(index)}
                        title={t("common.delete", { defaultValue: "删除" })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <Dialog
        open={Boolean(pendingSplitRouting)}
        onOpenChange={(open) => {
          if (!open) handleCancelSplitRouting();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>检测到混合协议模型</DialogTitle>
            <DialogDescription>
              当前中转同时返回了 GPT-like 模型和非 GPT-like 模型。建议保存时拆成
              Responses 与 Chat 两个
              provider，避免把两种协议混在同一个配置里导致后续分不清。
              确认后不会立即保存；点击新增时才会创建两个 provider。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 px-6 pb-2">
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span>{`${splitRoutingProviderName}-responses`}</span>
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  OpenAI Responses
                </span>
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  单独 provider
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                匹配模型：
                {pendingResponsesModels.join(", ") || "-"}
              </p>
            </div>
            <div className="rounded-md border border-sky-500/40 bg-sky-500/10 p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span>{`${splitRoutingProviderName}-chat`}</span>
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  OpenAI Chat Completions
                </span>
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  单独 provider
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                匹配模型：{pendingChatModels.join(", ") || "-"}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancelSplitRouting}
            >
              暂不拆分
            </Button>
            <Button type="button" onClick={handleConfirmSplitRouting}>
              确认生成两个 provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editingRoute)}
        onOpenChange={(open) => {
          if (!open) setEditingRouteIndex(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {t("codexConfig.editRoute", { defaultValue: "编辑路由" })}
            </DialogTitle>
            <DialogDescription>
              {t("codexConfig.editRouteHint", {
                defaultValue:
                  "配置这条路由的匹配规则、上游 API 格式、认证方式、模型映射和能力标记。",
              })}
            </DialogDescription>
          </DialogHeader>

          {editingRoute && editingRouteIndex !== null && (
            <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
                <Input
                  value={editingRoute.id}
                  onChange={(event) =>
                    handleUpdateRoute(editingRouteIndex, {
                      id: event.target.value.trim(),
                    })
                  }
                  placeholder={t("codexConfig.routeIdPlaceholder", {
                    defaultValue: "路由 ID",
                  })}
                />
                <Input
                  value={editingRoute.label ?? ""}
                  onChange={(event) =>
                    handleUpdateRoute(editingRouteIndex, {
                      label: event.target.value,
                    })
                  }
                  placeholder={t("codexConfig.routeLabelPlaceholder", {
                    defaultValue: "路由名称",
                  })}
                />
                <label className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={editingRoute.enabled !== false}
                    onCheckedChange={(checked) =>
                      handleUpdateRoute(editingRouteIndex, { enabled: checked })
                    }
                  />
                  {editingRoute.enabled === false ? "已停用" : "已启用"}
                </label>
              </div>

              <Input
                value={editingRoute.targetProviderId ?? ""}
                onChange={(event) =>
                  handleUpdateRoute(editingRouteIndex, {
                    targetProviderId: event.target.value.trim() || undefined,
                  })
                }
                placeholder={t("codexConfig.targetProviderIdPlaceholder", {
                  defaultValue:
                    "目标供应商 ID（可选；填写后复用该供应商的 Base URL、认证和转换配置）",
                })}
              />

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Input
                  value={editingRouteModelsText}
                  onChange={(event) =>
                    handleUpdateRoute(editingRouteIndex, {
                      match: {
                        ...editingRoute.match,
                        models: parseRoutingList(event.target.value),
                      },
                    })
                  }
                  placeholder={t("codexConfig.matchModelsPlaceholder", {
                    defaultValue: "匹配模型，多个用英文逗号分隔",
                  })}
                />
                <Input
                  value={editingRoutePrefixesText}
                  onChange={(event) =>
                    handleUpdateRoute(editingRouteIndex, {
                      match: {
                        ...editingRoute.match,
                        prefixes: parseRoutingList(event.target.value),
                      },
                    })
                  }
                  placeholder={t("codexConfig.matchPrefixesPlaceholder", {
                    defaultValue: "匹配前缀，多个用英文逗号分隔",
                  })}
                />
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_180px_180px]">
                <Input
                  value={editingRoute.upstream.baseUrl ?? ""}
                  onChange={(event) =>
                    handleUpdateRoute(editingRouteIndex, {
                      upstream: {
                        ...editingRoute.upstream,
                        baseUrl: event.target.value.trim(),
                      },
                    })
                  }
                  placeholder={t("codexConfig.routeBaseUrlPlaceholder", {
                    defaultValue: "上游 Base URL",
                  })}
                />
                <Select
                  value={editingRoute.upstream.apiFormat}
                  onValueChange={(value) =>
                    handleUpdateRoute(editingRouteIndex, {
                      upstream: {
                        ...editingRoute.upstream,
                        apiFormat: value as CodexApiFormat,
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai_responses">
                      OpenAI Responses
                    </SelectItem>
                    <SelectItem value="openai_chat">
                      OpenAI Chat Completions
                    </SelectItem>
                    <SelectItem value="openai_messages">
                      OpenAI Messages
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={editingRouteAuthSource}
                  onValueChange={(value) =>
                    handleUpdateRoute(editingRouteIndex, {
                      upstream: {
                        ...editingRoute.upstream,
                        apiKey:
                          value === "provider_config"
                            ? editingRoute.upstream.apiKey
                            : "",
                        auth: {
                          source: value as CodexRoutingAuthSource,
                          authProvider:
                            value === "managed_account" ||
                            value === "managed_codex_oauth"
                              ? "codex_oauth"
                              : undefined,
                          accountId:
                            value === "managed_account" ||
                            value === "managed_codex_oauth"
                              ? editingRoute.upstream.auth.accountId
                              : undefined,
                        },
                      },
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="provider_config">
                      使用路由 API Key
                    </SelectItem>
                    <SelectItem value="managed_codex_oauth">
                      托管 Codex OAuth
                    </SelectItem>
                    <SelectItem value="managed_account">托管账号</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {editingRouteAuthSource === "provider_config" ? (
                  <Input
                    type="password"
                    value={editingRoute.upstream.apiKey ?? ""}
                    onChange={(event) =>
                      handleUpdateRoute(editingRouteIndex, {
                        upstream: {
                          ...editingRoute.upstream,
                          apiKey: event.target.value.trim(),
                        },
                      })
                    }
                    placeholder={t("codexConfig.routeApiKeyPlaceholder", {
                      defaultValue: "路由 API Key",
                    })}
                  />
                ) : (
                  <Input
                    value={editingRoute.upstream.auth.accountId ?? ""}
                    onChange={(event) =>
                      handleUpdateRoute(editingRouteIndex, {
                        upstream: {
                          ...editingRoute.upstream,
                          auth: {
                            ...editingRoute.upstream.auth,
                            authProvider: "codex_oauth",
                            accountId: event.target.value.trim(),
                          },
                        },
                      })
                    }
                    placeholder={t("codexConfig.routeAccountPlaceholder", {
                      defaultValue: "托管账号 ID（可选）",
                    })}
                  />
                )}
                <Input
                  value={editingRouteModelMapText}
                  onChange={(event) =>
                    handleUpdateRoute(editingRouteIndex, {
                      upstream: {
                        ...editingRoute.upstream,
                        modelMap: parseModelMap(event.target.value),
                      },
                    })
                  }
                  placeholder={t("codexConfig.modelMapPlaceholder", {
                    defaultValue: "codex模型=上游模型",
                  })}
                />
              </div>

              <div className="flex flex-wrap items-center gap-4 border-t border-border-default pt-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={editingRouteTextOnly}
                    onCheckedChange={(checked) =>
                      handleUpdateRoute(editingRouteIndex, {
                        capabilities: {
                          ...editingRoute.capabilities,
                          textOnly: checked,
                          inputModalities: checked
                            ? ["text"]
                            : ["text", "image"],
                        },
                      })
                    }
                  />
                  {t("codexConfig.textOnlyCapability", {
                    defaultValue: "仅文本",
                  })}
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={editingRouteSupportsImage}
                    onCheckedChange={(checked) =>
                      handleUpdateRoute(editingRouteIndex, {
                        capabilities: {
                          ...editingRoute.capabilities,
                          textOnly: !checked,
                          inputModalities: checked
                            ? ["text", "image"]
                            : ["text"],
                        },
                      })
                    }
                  />
                  {t("codexConfig.imageCapability", { defaultValue: "图文" })}
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={
                      editingRoute.capabilities?.supportsReasoning === true
                    }
                    onCheckedChange={(checked) =>
                      handleUpdateRoute(editingRouteIndex, {
                        capabilities: {
                          ...editingRoute.capabilities,
                          supportsReasoning: checked,
                        },
                      })
                    }
                  />
                  {t("codexConfig.reasoningCapability", {
                    defaultValue: "推理",
                  })}
                </label>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" onClick={() => setEditingRouteIndex(null)}>
              {t("common.done", { defaultValue: "完成" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 高级选项 —— 本地路由映射/模型映射/思考能力/自定义 UA；预设供应商通常无需展开 */}
      {category !== "official" && (
        <Collapsible
          open={advancedExpanded}
          onOpenChange={setAdvancedExpanded}
          className="rounded-lg border border-border-default p-4"
        >
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant={null}
              size="sm"
              className="h-8 w-full justify-start gap-1.5 px-0 text-sm font-medium text-foreground hover:opacity-70"
            >
              {advancedExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {t("providerForm.advancedOptionsToggle", {
                defaultValue: "高级选项",
              })}
            </Button>
          </CollapsibleTrigger>
          {!advancedExpanded && (
            <p className="mt-1 ml-1 text-xs text-muted-foreground">
              {t("codexConfig.advancedSectionHint", {
                defaultValue:
                  "包含模型映射、思考能力与自定义 User-Agent。供应商使用 Chat Completions 协议或非 GPT 模型时，请在上方开启本地路由映射。",
              })}
            </p>
          )}
          <CollapsibleContent className="space-y-3 pt-3">
            {/* 上游格式 + 本地路由映射 —— 两个平级、相互独立的控件。
                格式不依赖路由：Responses 原生供应商无需开启路由即可直连；
                沿用 shouldShowSpeedTest 门控，cloud_provider 保持不可切换。 */}
            {shouldShowSpeedTest && (
              <div className="space-y-3">
                {/* 上游格式 —— 顶层独立选择，与路由开关解耦 */}
                <div className="space-y-1.5">
                  <FormLabel htmlFor="codex-upstream-format">
                    {t("codexConfig.upstreamFormatLabel", {
                      defaultValue: "上游格式",
                    })}
                  </FormLabel>
                  <Select
                    value={apiFormat}
                    onValueChange={(value) =>
                      onApiFormatChange(value as CodexApiFormat)
                    }
                  >
                    <SelectTrigger
                      id="codex-upstream-format"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai_chat">
                        {t("codexConfig.upstreamFormatChat", {
                          defaultValue: "Chat Completions（转换）",
                        })}
                      </SelectItem>
                      <SelectItem value="openai_responses">
                        {t("codexConfig.upstreamFormatResponses", {
                          defaultValue: "Responses（原生）",
                        })}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.upstreamFormatHint", {
                      defaultValue:
                        "供应商原生是 Responses API 就选 Responses（直连，不转换格式）；使用 Chat Completions 协议就选 Chat（转换为 Chat Completions）。",
                    })}
                  </p>
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
                    不确定该选哪个时，可以测试 Chat /
                    Responses。测试前需要先在“模型映射”里获取模型列表或手动添加模型；测试会发送真实模型请求，
                    输出上限为
                    1024，可能产生少量额度或流量消耗。通过只代表基础协议入口可用，不等于完整
                    Codex 功能验证。
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1"
                      disabled={isProbingProtocol}
                      onClick={() => {
                        setProtocolProbeTone("muted");
                        setProtocolProbeSummary(
                          "已打开测试确认框；如果没有看到弹窗，请按 Esc 后重试。",
                        );
                        setIsProtocolProbeConfirmOpen(true);
                      }}
                    >
                      {isProbingProtocol ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Route className="h-3.5 w-3.5" />
                      )}
                      测试 Chat / Responses
                    </Button>
                    {protocolProbeSummary && (
                      <span
                        role={
                          protocolProbeTone === "error" ? "alert" : "status"
                        }
                        className={cn(
                          "text-xs leading-relaxed",
                          protocolProbeTone === "success" &&
                            "text-emerald-700 dark:text-emerald-300",
                          protocolProbeTone === "warning" &&
                            "text-amber-700 dark:text-amber-300",
                          protocolProbeTone === "error" && "text-destructive",
                          protocolProbeTone === "muted" &&
                            "text-muted-foreground",
                        )}
                      >
                        {protocolProbeSummary}
                      </span>
                    )}
                  </div>
                </div>

                {/* 需要本地路由映射 —— 纯模型映射门控，与上游格式无关 */}
                <div className="flex items-center justify-between gap-4 border-t border-border-default pt-3">
                  <div className="space-y-1">
                    <FormLabel>
                      {t("codexConfig.localRoutingToggle", {
                        defaultValue: "需要本地路由映射",
                      })}
                    </FormLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {takeoverEnabled
                        ? t("codexConfig.localRoutingOnHint", {
                            defaultValue:
                              "打开后可在下方配置模型映射：让 Codex 的 /model 菜单显示自定义模型名，并把请求映射到真实上游模型。",
                          })
                        : t("codexConfig.localRoutingOffHint", {
                            defaultValue:
                              "供应商模型名无需改写、也无需在 /model 菜单展示自定义名称时，可保持关闭；需要模型映射时打开。",
                          })}
                    </p>
                  </div>
                  <Switch
                    checked={takeoverEnabled}
                    onCheckedChange={onTakeoverEnabledChange}
                    aria-label={t("codexConfig.localRoutingToggle", {
                      defaultValue: "需要本地路由映射",
                    })}
                  />
                </div>
              </div>
            )}

            {takeoverEnabled && isChatFormat && canEditReasoning && (
              <div
                className={cn(
                  "space-y-3",
                  shouldShowSpeedTest && "border-t border-border-default pt-3",
                )}
              >
                <div className="space-y-1">
                  <FormLabel>
                    {t("codexConfig.reasoningGroupTitle", {
                      defaultValue: "思考能力",
                    })}
                  </FormLabel>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.reasoningSectionHint", {
                      defaultValue:
                        "预设供应商已自动配置；自定义供应商会按名称/地址自动推断。仅当自动识别不准时才需手动覆盖。",
                    })}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <FormLabel>
                      {t("codexConfig.reasoningModeToggle", {
                        defaultValue: "支持思考模式",
                      })}
                    </FormLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("codexConfig.reasoningModeHint", {
                        defaultValue:
                          "上游 Chat Completions 接口支持开启或关闭 thinking 时启用。Kimi、GLM、Qwen 等通常属于这一类。",
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={supportsThinking}
                    onCheckedChange={handleReasoningThinkingChange}
                    aria-label={t("codexConfig.reasoningModeToggle", {
                      defaultValue: "支持思考模式",
                    })}
                  />
                </div>

                <div className="flex items-center justify-between gap-4 border-t border-border-default pt-3">
                  <div className="space-y-1">
                    <FormLabel>
                      {t("codexConfig.reasoningEffortToggle", {
                        defaultValue: "支持思考等级",
                      })}
                    </FormLabel>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("codexConfig.reasoningEffortHint", {
                        defaultValue:
                          "上游支持 low/high/max 等思考深度控制时启用。启用后会自动启用思考模式，并把 Codex 的 reasoning.effort 转成上游 Chat 参数。",
                      })}
                    </p>
                  </div>
                  <Switch
                    checked={supportsEffort}
                    onCheckedChange={handleReasoningEffortChange}
                    aria-label={t("codexConfig.reasoningEffortToggle", {
                      defaultValue: "支持思考等级",
                    })}
                  />
                </div>
              </div>
            )}

            <div
              className={cn(
                "space-y-3",
                (shouldShowSpeedTest ||
                  (takeoverEnabled && isChatFormat && canEditReasoning)) &&
                  "border-t border-border-default pt-3",
              )}
            >
              <CustomUserAgentField
                id="codex-custom-user-agent"
                value={customUserAgent}
                onChange={onCustomUserAgentChange}
              />
              <div className="border-t border-border-default pt-3">
                <LocalProxyRequestOverridesField
                  headersJson={localProxyHeadersOverride}
                  bodyJson={localProxyBodyOverride}
                  onHeadersJsonChange={onLocalProxyHeadersOverrideChange}
                  onBodyJsonChange={onLocalProxyBodyOverrideChange}
                />
              </div>
            </div>

            {/* 模型映射 —— 仅在本地路由开启 + 可编辑时显示（与上游格式解耦，
                Responses 原生供应商同样可配置）；上方恒有 UA 字段，分隔线无需条件 */}
            {takeoverEnabled && canEditCatalog && (
              <div
                ref={modelMappingSectionRef}
                className="space-y-4 border-t border-border-default pt-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <FormLabel>
                      {t("codexConfig.modelMappingTitle", {
                        defaultValue: "模型映射",
                      })}
                    </FormLabel>
                    {renderCatalogActionButtons(
                      handleAddCatalogRow,
                      t("codexConfig.addCatalogModel", {
                        defaultValue: "添加模型",
                      }),
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("codexConfig.modelMappingHint", {
                      defaultValue:
                        "选择模型角色后，CC Switch 会自动生成 Codex 兼容路由；菜单显示名可以填 DeepSeek、Kimi 等品牌模型，实际请求模型按右侧填写内容发送。",
                    })}
                  </p>
                </div>

                {catalogRows.length > 0 && (
                  <div className="space-y-2">
                    {/* 列头：md+ 显示 */}
                    <div className="hidden grid-cols-[88px_1fr_1fr_1fr_132px_76px_36px] gap-2 px-1 text-xs font-medium text-muted-foreground md:grid">
                      <span>
                        {t("codexConfig.spawnAgentColumn", {
                          defaultValue: "子 Agent",
                        })}
                      </span>
                      <span>
                        {t("codexConfig.catalogColumnDisplay", {
                          defaultValue: "菜单显示名",
                        })}
                      </span>
                      <span>
                        {t("codexConfig.catalogColumnModel", {
                          defaultValue: "候选模型名",
                        })}
                      </span>
                      <span>
                        {t("codexConfig.catalogColumnUpstreamModel", {
                          defaultValue: "上游模型名",
                        })}
                      </span>
                      <span>
                        {t("codexConfig.catalogColumnContext", {
                          defaultValue: "上下文窗口",
                        })}
                      </span>
                      <span>
                        {t("codexConfig.spawnAgentOrderColumn", {
                          defaultValue: "顺序",
                        })}
                      </span>
                      <span />
                    </div>

                    {catalogRows.map((row, index) => {
                      const probeModel =
                        catalogRowUpstreamModel(row) || row.model.trim();
                      const probeBadge = getProtocolProbeBadge(
                        protocolProbeOutcomesByModel[probeModel],
                      );

                      return (
                        <div
                          key={row.rowId}
                          className="grid grid-cols-1 gap-2 md:grid-cols-[88px_1fr_1fr_1fr_132px_76px_36px]"
                        >
                          <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border-default"
                              checked={selectedSpawnAgentModelSet.has(
                                row.model,
                              )}
                              disabled={!row.model.trim()}
                              onChange={(event) =>
                                handleToggleSpawnAgentModel(
                                  row.model,
                                  event.target.checked,
                                )
                              }
                              aria-label={t("codexConfig.spawnAgentCheckbox", {
                                defaultValue: "加入子 Agent 候选",
                              })}
                            />
                            <span className="md:hidden">
                              {t("codexConfig.spawnAgentColumn", {
                                defaultValue: "子 Agent",
                              })}
                            </span>
                          </label>
                          <Input
                            value={row.displayName ?? ""}
                            onChange={(event) =>
                              handleUpdateCatalogRow(index, {
                                displayName: event.target.value,
                              })
                            }
                            placeholder={t(
                              "codexConfig.catalogDisplayNamePlaceholder",
                              {
                                defaultValue: "例如: DeepSeek V4 Flash",
                              },
                            )}
                            aria-label={t("codexConfig.catalogColumnDisplay", {
                              defaultValue: "菜单显示名",
                            })}
                          />
                          <Input
                            value={row.model}
                            onChange={(event) =>
                              handleUpdateCatalogRow(index, {
                                model: event.target.value,
                              })
                            }
                            placeholder={t(
                              "codexConfig.catalogModelPlaceholder",
                              {
                                defaultValue: "例如: gpt-5.5-thirdparty",
                              },
                            )}
                            aria-label={t("codexConfig.catalogColumnModel", {
                              defaultValue: "候选模型名",
                            })}
                          />
                          <div className="space-y-1">
                            <div className="flex gap-1">
                              <Input
                                value={
                                  row.upstreamModel ?? row.upstream_model ?? ""
                                }
                                onChange={(event) =>
                                  handleUpdateCatalogRow(index, {
                                    upstreamModel: event.target.value,
                                  })
                                }
                                placeholder={t(
                                  "codexConfig.catalogUpstreamModelPlaceholder",
                                  {
                                    defaultValue: "留空则使用候选模型名",
                                  },
                                )}
                                aria-label={t(
                                  "codexConfig.catalogColumnUpstreamModel",
                                  {
                                    defaultValue: "上游模型名",
                                  },
                                )}
                                className="flex-1"
                              />
                              {fetchedModels.length > 0 && (
                                <ModelDropdown
                                  models={fetchedModels}
                                  onSelect={(id) =>
                                    handleSelectFetchedCatalogModel(
                                      index,
                                      id,
                                      row.model,
                                      row.displayName,
                                    )
                                  }
                                />
                              )}
                            </div>
                            {probeBadge && (
                              <span
                                className={cn(
                                  "inline-flex w-fit items-center rounded border px-1.5 py-0.5 text-[11px] font-medium",
                                  probeBadge.className,
                                )}
                                title={probeBadge.title}
                              >
                                {probeBadge.label}
                              </span>
                            )}
                          </div>
                          <Input
                            type="number"
                            min={1}
                            inputMode="numeric"
                            value={row.contextWindow ?? ""}
                            onChange={(event) =>
                              handleUpdateCatalogRow(index, {
                                contextWindow: event.target.value.replace(
                                  /[^\d]/g,
                                  "",
                                ),
                              })
                            }
                            placeholder={t(
                              "codexConfig.contextWindowPlaceholder",
                              {
                                defaultValue: "例如: 128000",
                              },
                            )}
                            aria-label={t("codexConfig.catalogColumnContext", {
                              defaultValue: "上下文窗口",
                            })}
                          />
                          <div className="flex h-9 items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              disabled={
                                spawnAgentModels.indexOf(row.model) <= 0
                              }
                              onClick={() =>
                                handleMoveSpawnAgentModel(row.model, -1)
                              }
                              title={t("common.moveUp", {
                                defaultValue: "上移",
                              })}
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground"
                              disabled={
                                spawnAgentModels.indexOf(row.model) < 0 ||
                                spawnAgentModels.indexOf(row.model) >=
                                  spawnAgentModels.length - 1
                              }
                              onClick={() =>
                                handleMoveSpawnAgentModel(row.model, 1)
                              }
                              title={t("common.moveDown", {
                                defaultValue: "下移",
                              })}
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemoveCatalogRow(index)}
                            title={t("common.delete", { defaultValue: "删除" })}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* 端点测速弹窗 - Codex */}
      {shouldShowSpeedTest && isEndpointModalOpen && (
        <EndpointSpeedTest
          appId="codex"
          providerId={providerId}
          value={codexBaseUrl}
          onChange={onBaseUrlChange}
          initialEndpoints={speedTestEndpoints}
          visible={isEndpointModalOpen}
          onClose={() => onEndpointModalToggle(false)}
          autoSelect={autoSelect}
          onAutoSelectChange={onAutoSelectChange}
          onCustomEndpointsChange={onCustomEndpointsChange}
        />
      )}
    </>
  );
}
