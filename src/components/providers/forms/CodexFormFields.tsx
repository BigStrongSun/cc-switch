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
  Trash2,
} from "lucide-react";
import EndpointSpeedTest from "./EndpointSpeedTest";
import { ApiKeySection, EndpointField, ModelDropdown } from "./shared";
import {
  fetchModelsForConfig,
  showFetchModelsError,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import { CustomUserAgentField } from "./CustomUserAgentField";
import { cn } from "@/lib/utils";
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

interface CodexFormFieldsProps {
  providerId?: string;
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

  // Speed Test Endpoints
  speedTestEndpoints: EndpointCandidate[];

  // Local proxy User-Agent override
  customUserAgent: string;
  onCustomUserAgentChange: (value: string) => void;
}

type CodexCatalogRow = CodexCatalogModel & { rowId: string };

type CodexRoutingRow = CodexRoutingRoute & { rowId: string };

function createCatalogRow(seed?: Partial<CodexCatalogModel>): CodexCatalogRow {
  return {
    rowId: crypto.randomUUID(),
    model: seed?.model ?? "",
    displayName: seed?.displayName ?? "",
    contextWindow: seed?.contextWindow ?? "",
  };
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
  rows: Array<Pick<CodexCatalogRow, "model" | "displayName" | "contextWindow">>,
  models: CodexCatalogModel[],
): boolean {
  if (rows.length !== models.length) return false;
  return rows.every((row, i) => {
    const incoming = models[i];
    return (
      row.model === (incoming.model ?? "") &&
      (row.displayName ?? "") === (incoming.displayName ?? "") &&
      String(row.contextWindow ?? "") === String(incoming.contextWindow ?? "")
    );
  });
}

export function CodexFormFields({
  providerId,
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
  speedTestEndpoints,
  customUserAgent,
  onCustomUserAgentChange,
}: CodexFormFieldsProps) {
  const { t } = useTranslation();

  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [editingRouteIndex, setEditingRouteIndex] = useState<number | null>(
    null,
  );
  const needsLocalRouting = apiFormat === "openai_chat";
  const canEditCatalog = Boolean(onCatalogModelsChange);
  const canEditRouting = Boolean(onCodexRoutingChange);
  const canEditReasoning = Boolean(onCodexChatReasoningChange);
  const supportsThinking =
    codexChatReasoning.supportsThinking === true ||
    codexChatReasoning.supportsEffort === true;
  const supportsEffort = codexChatReasoning.supportsEffort === true;
  const selectedSpawnAgentModelSet = new Set(spawnAgentModels);

  // needsLocalRouting 非默认值说明预设/用户动过路由配置，需要让模型映射保持可见
  const hasAnyAdvancedValue = !!customUserAgent || needsLocalRouting;
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

  const handleLocalRoutingChange = useCallback(
    (checked: boolean) => {
      onApiFormatChange(checked ? "openai_chat" : "openai_responses");
    },
    [onApiFormatChange],
  );

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
  }, [codexBaseUrl, codexApiKey, isFullUrl, customUserAgent, t]);

  const handleAddCatalogRow = useCallback(() => {
    if (!onCatalogModelsChange) return;
    setCatalogRows((current) => [...current, createCatalogRow()]);
  }, [onCatalogModelsChange]);

  const handleUpdateCatalogRow = useCallback(
    (index: number, patch: Partial<CodexCatalogModel>) => {
      setCatalogRows((current) =>
        current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const handleSelectFetchedCatalogModel = useCallback(
    (index: number, modelId: string, currentDisplayName?: string) => {
      const fetched = fetchedModels.find((model) => model.id === modelId);
      const contextWindow =
        typeof fetched?.contextWindow === "number" && fetched.contextWindow > 0
          ? String(fetched.contextWindow)
          : undefined;

      handleUpdateCatalogRow(index, {
        model: modelId,
        displayName: currentDisplayName?.trim() ? currentDisplayName : modelId,
        ...(contextWindow ? { contextWindow } : {}),
      });
    },
    [fetchedModels, handleUpdateCatalogRow],
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

  const renderCatalogActionButtons = (onAdd: () => void, addLabel: string) => (
    <div className="flex gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleFetchModels}
        disabled={isFetchingModels}
        className="h-7 gap-1"
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

      {shouldShowSpeedTest && (
        <div className="space-y-3 rounded-lg border border-border-default bg-muted/20 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>
                {t("codexConfig.localRoutingToggle", {
                  defaultValue: "需要本地路由映射",
                })}
              </FormLabel>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {needsLocalRouting
                  ? t("codexConfig.localRoutingOnHint", {
                      defaultValue:
                        "Codex 目前仅原生支持 OpenAI Responses API 与 GPT 系列模型；如果您的供应商使用 Chat Completions 协议或非 GPT 模型（如 DeepSeek、Kimi），则需要打开本开关，并在使用过程中保持本地路由开启。",
                    })
                  : t("codexConfig.localRoutingOffHint", {
                      defaultValue:
                        "如果您的供应商不是原生 OpenAI Responses API，或者模型名不是 Codex 默认的 GPT 系列，请打开此开关。",
                    })}
              </p>
            </div>
            <Switch
              checked={needsLocalRouting}
              onCheckedChange={handleLocalRoutingChange}
              aria-label={t("codexConfig.localRoutingToggle", {
                defaultValue: "需要本地路由映射",
              })}
            />
          </div>
        </div>
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
            {needsLocalRouting && canEditReasoning && (
              <div className="space-y-3">
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
                needsLocalRouting &&
                  canEditReasoning &&
                  "border-t border-border-default pt-3",
              )}
            >
              <CustomUserAgentField
                id="codex-custom-user-agent"
                value={customUserAgent}
                onChange={onCustomUserAgentChange}
              />
            </div>

            {/* 模型映射 —— 仅在本地路由 + 可编辑时显示；上方恒有 UA 字段，分隔线无需条件 */}
            {needsLocalRouting && canEditCatalog && (
              <div className="space-y-4 border-t border-border-default pt-3">
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
                    <div className="hidden grid-cols-[88px_1fr_1fr_140px_76px_36px] gap-2 px-1 text-xs font-medium text-muted-foreground md:grid">
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
                          defaultValue: "实际请求模型",
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

                    {catalogRows.map((row, index) => (
                      <div
                        key={row.rowId}
                        className="grid grid-cols-1 gap-2 md:grid-cols-[88px_1fr_1fr_140px_76px_36px]"
                      >
                        <label className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border-default"
                            checked={selectedSpawnAgentModelSet.has(row.model)}
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
                        <div className="flex gap-1">
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
                                defaultValue: "例如: deepseek-v4-flash",
                              },
                            )}
                            aria-label={t("codexConfig.catalogColumnModel", {
                              defaultValue: "实际请求模型",
                            })}
                            className="flex-1"
                          />
                          {fetchedModels.length > 0 && (
                            <ModelDropdown
                              models={fetchedModels}
                              onSelect={(id) =>
                                handleSelectFetchedCatalogModel(
                                  index,
                                  id,
                                  row.displayName,
                                )
                              }
                            />
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
                            disabled={spawnAgentModels.indexOf(row.model) <= 0}
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
                    ))}
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
