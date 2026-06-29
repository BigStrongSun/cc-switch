import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Database,
  GitBranch,
  KeyRound,
  RefreshCw,
  Route,
  Server,
  ShieldAlert,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Provider } from "@/types";
import type {
  CodexCacheConfig,
  CodexCatalogModel,
  CodexRoutingRoute,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { providersApi } from "@/lib/api/providers";
import {
  fetchModelsForConfig,
  probeCodexChatForConfig,
  probeCodexResponsesForConfig,
} from "@/lib/api/model-fetch";
import {
  CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY,
  applyWizardConnectivityApiFormatOverrides,
  buildCodexMultiRouterWizardPlan,
  canContinueAfterConnectivity,
  classifyWizardDualProtocolConnectivityResult,
  classifyWizardConnectivityResult,
  collectWizardModelNameCollisions,
  defaultWizardModelSources,
  getWizardConnectivityProbeModels,
  getWizardConfigIssues,
  getWizardModelFetchConfig,
  hasWizardModelCatalog,
  mergeFetchedModelsIntoWizardProvider,
  isCodexMultiRouterPlan,
  readWizardModelCatalog,
  resolveWizardModelNameCollisions,
  skippedWizardConnectivityResult,
  type WizardConnectivityResult,
  type WizardModelFetchConfig,
} from "@/lib/codexMultiRouterWizard";
import type { WorkspaceTab } from "@/components/codex/CodexRouterWorkspacePage";

interface CodexMultiRouterWizardProps {
  open: boolean;
  providers: Provider[];
  onOpenChange: (open: boolean) => void;
  onCreateProvider: () => void;
  onOpenWorkspace: (provider: Provider, tab: WorkspaceTab) => void;
  onEnablePlan: (provider: Provider) => void | Promise<void>;
}

type WizardStepKey =
  | "intro"
  | "sources"
  | "providerConfig"
  | "fetchModels"
  | "collisions"
  | "routes"
  | "publish"
  | "finish";

interface WizardStep {
  key: WizardStepKey;
  title: string;
  description: string;
  icon: typeof Wand2;
}

interface WizardStepRule {
  errors: string[];
  canContinue: string;
}

interface WizardIssue {
  id: string;
  stage: WizardStepKey;
  severity: "error" | "warning";
  title: string;
  detail: string;
  canContinue: boolean;
  providerName?: string;
}

const STEPS: WizardStep[] = [
  {
    key: "intro",
    title: "理解 MultiRouter",
    description:
      "Codex 仍连接本地 15721，CCSwitchMulti 按 model 分发到不同上游。",
    icon: Wand2,
  },
  {
    key: "sources",
    title: "创建模型源",
    description:
      "逐个添加 OpenAI/中转站、DeepSeek、Qwen、本地 vLLM/Ollama 等 Codex provider。",
    icon: Server,
  },
  {
    key: "providerConfig",
    title: "配置核心参数",
    description:
      "检查 API Key、Base URL、Responses / Chat Completions 以及是否需要本地路由映射。",
    icon: KeyRound,
  },
  {
    key: "fetchModels",
    title: "获取模型列表",
    description: "自动调用 /models，把模型写入每个 provider 的 modelCatalog。",
    icon: RefreshCw,
  },
  {
    key: "collisions",
    title: "处理重名模型",
    description:
      "官方模型保留原名，中转站或第三方同名模型会在模型名后追加 provider 名称并保留 upstreamModel。",
    icon: ShieldAlert,
  },
  {
    key: "routes",
    title: "生成路由规则",
    description:
      "按 provider 分组生成规则，gpt/o、deepseek、qwen 等前缀自动命中对应上游。",
    icon: GitBranch,
  },
  {
    key: "publish",
    title: "保存并发布",
    description:
      "创建或更新带 codexRouting 和 modelCatalog 的 MultiRouter provider。",
    icon: Database,
  },
  {
    key: "finish",
    title: "启用并测试",
    description:
      "显式启用多路路由，进入状态页等待真实转发成功，再自动跳到历史修复。",
    icon: CheckCircle2,
  },
];

const STEP_RULES: Record<WizardStepKey, WizardStepRule> = {
  intro: {
    errors: ["本地代理未运行或 15721 被其它进程占用时，后续启用会失败。"],
    canContinue: "这是说明步骤，总是可以继续。",
  },
  sources: {
    errors: ["没有普通 Codex provider 时，不能生成任何路由。"],
    canContinue: "至少识别到一个普通 Codex provider 后可以继续。",
  },
  providerConfig: {
    errors: [
      "缺少 Base URL/API Key 时无法自动获取模型，也无法做真实连通性测试。",
      "apiFormat 未设置时按 Chat Completions 保守处理。",
    ],
    canContinue:
      "有可用 modelCatalog 时可继续；没有 modelCatalog 且缺配置会停在配置缺口状态。",
  },
  fetchModels: {
    errors: [
      "/models 失败会保留已有目录，不会清空用户配置。",
      "Responses 直连 provider 的 /v1/responses 探测失败是阻塞项。",
      "Chat Completions provider 的 /v1/responses 探测失败是可继续警告。",
    ],
    canContinue:
      "无阻塞连通性失败即可继续；未测试时允许继续但状态条会提示风险。",
  },
  collisions: {
    errors: [
      "多个 provider 暴露同一 upstreamModel 时，后面的同名模型会被路由顺序遮蔽。",
    ],
    canContinue: "接受自动别名策略后可以继续，upstreamModel 会保留真实模型名。",
  },
  routes: {
    errors: ["没有 match.models/prefixes 的 route 不会稳定命中模型请求。"],
    canContinue: "至少生成一条 route 且没有连通性阻塞项时可以继续保存。",
  },
  publish: {
    errors: ["数据库写入失败或 provider id 冲突会进入 saveFailed。"],
    canContinue: "点击保存并发布成功后进入完成页；保存失败必须重试或返回修改。",
  },
  finish: {
    errors: [
      "本地代理未运行、端口冲突或切换 provider 失败会进入 enableFailed。",
      "启用后如果 Codex 没有发出真实请求，状态页会停在待请求验证，不会提前跳历史修复。",
    ],
    canContinue:
      "显式启用成功后会自动打开状态页；最近一次转发成功后，App 会提示配置成功并进入历史修复。",
  },
};

type WizardFlowStatus =
  | "opened"
  | "needSources"
  | "reviewProviderConfig"
  | "configIncomplete"
  | "readyToFetchModels"
  | "fetchingModels"
  | "modelFetchPartial"
  | "modelsFetched"
  | "probingConnectivity"
  | "connectivityPassed"
  | "connectivityPartial"
  | "connectivityFailed"
  | "collisionReviewRequired"
  | "routePreview"
  | "savingPlan"
  | "saveFailed"
  | "published"
  | "enablePrompt"
  | "enabling"
  | "enableFailed"
  | "enabled"
  | "completed"
  | "dismissed";

interface WizardFlowState {
  status: WizardFlowStatus;
  stepKey: WizardStepKey;
  lastError?: string;
  fetchSummary?: {
    successCount: number;
    skippedCount: number;
    failedCount: number;
  };
  connectivitySummary?: {
    passCount: number;
    warnCount: number;
    skippedCount: number;
    failCount: number;
  };
}

type WizardFlowEvent =
  | { type: "INIT"; hasSources: boolean }
  | { type: "GOTO_STEP"; stepKey: WizardStepKey }
  | { type: "NEXT"; nextStatus: WizardFlowStatus; nextStepKey: WizardStepKey }
  | { type: "FETCH_START" }
  | {
      type: "FETCH_DONE";
      partial: boolean;
      summary: WizardFlowState["fetchSummary"];
    }
  | { type: "PROBE_START" }
  | {
      type: "PROBE_DONE";
      canContinue: boolean;
      hasWarnings: boolean;
      summary: WizardFlowState["connectivitySummary"];
    }
  | { type: "SAVE_START" }
  | { type: "SAVE_SUCCESS" }
  | { type: "SAVE_ERROR"; error: string }
  | { type: "ENABLE_START" }
  | { type: "ENABLE_SUCCESS" }
  | { type: "ENABLE_ERROR"; error: string }
  | { type: "DISMISS" }
  | { type: "COMPLETE" };

const INITIAL_FLOW_STATE: WizardFlowState = {
  status: "opened",
  stepKey: "intro",
};

// 将左侧教程步骤映射到业务状态；手动跳步也会进入对应的状态分支，避免 UI 步骤和流程状态脱节。
function statusForStep(stepKey: WizardStepKey): WizardFlowStatus {
  switch (stepKey) {
    case "sources":
      return "reviewProviderConfig";
    case "providerConfig":
      return "reviewProviderConfig";
    case "fetchModels":
      return "readyToFetchModels";
    case "collisions":
      return "collisionReviewRequired";
    case "routes":
      return "routePreview";
    case "publish":
      return "published";
    case "finish":
      return "enablePrompt";
    case "intro":
    default:
      return "opened";
  }
}

// reducer 是向导的状态机核心；所有异步动作只发事件，不直接改流程状态。
function wizardFlowReducer(
  state: WizardFlowState,
  event: WizardFlowEvent,
): WizardFlowState {
  switch (event.type) {
    case "INIT":
      return {
        status: event.hasSources ? "opened" : "needSources",
        stepKey: "intro",
      };
    case "GOTO_STEP":
      return {
        ...state,
        status: statusForStep(event.stepKey),
        stepKey: event.stepKey,
        lastError: undefined,
      };
    case "NEXT":
      return {
        ...state,
        status: event.nextStatus,
        stepKey: event.nextStepKey,
        lastError: undefined,
      };
    case "FETCH_START":
      return { ...state, status: "fetchingModels", lastError: undefined };
    case "FETCH_DONE":
      return {
        ...state,
        status: event.partial ? "modelFetchPartial" : "modelsFetched",
        stepKey: event.partial ? "fetchModels" : "collisions",
        fetchSummary: event.summary,
      };
    case "PROBE_START":
      return {
        ...state,
        status: "probingConnectivity",
        stepKey: "fetchModels",
        lastError: undefined,
      };
    case "PROBE_DONE":
      return {
        ...state,
        status: event.canContinue
          ? event.hasWarnings
            ? "connectivityPartial"
            : "connectivityPassed"
          : "connectivityFailed",
        stepKey: event.canContinue ? "collisions" : "fetchModels",
        connectivitySummary: event.summary,
      };
    case "SAVE_START":
      return { ...state, status: "savingPlan", lastError: undefined };
    case "SAVE_SUCCESS":
      return { ...state, status: "published", stepKey: "finish" };
    case "SAVE_ERROR":
      return {
        ...state,
        status: "saveFailed",
        stepKey: "publish",
        lastError: event.error,
      };
    case "ENABLE_START":
      return { ...state, status: "enabling", lastError: undefined };
    case "ENABLE_SUCCESS":
      return { ...state, status: "enabled", stepKey: "finish" };
    case "ENABLE_ERROR":
      return {
        ...state,
        status: "enableFailed",
        stepKey: "finish",
        lastError: event.error,
      };
    case "DISMISS":
      return { ...state, status: "dismissed" };
    case "COMPLETE":
      return { ...state, status: "completed" };
    default:
      return state;
  }
}

// 将模型源的模型目录数量转成人可扫读的摘要，避免向导卡片暴露底层 JSON。
function modelSourceSummary(provider: Provider): string {
  const models = readWizardModelCatalog(provider);
  if (models.length === 0) return "尚未获取模型";
  return `${models.length} 个模型`;
}

// 把 /models 抓取参数格式化成安全摘要，不展示真实 API Key。
function fetchConfigSummary(config: WizardModelFetchConfig | null): string {
  if (!config) return "缺少 Base URL 或 API Key";
  return `${config.baseUrl}${config.isFullUrl ? " (完整 URL)" : ""}`;
}

// 将 route 的缓存能力转换成向导里的说明，强调缓存验证看真实 usage，而不是基础连通性。
function cacheCapabilitySummary(cache?: CodexCacheConfig): string {
  switch (cache?.cacheMode) {
    case "openai_prompt_cache":
      return "OpenAI Prompt Cache：保留原生前缀缓存；支持时会透传 prompt_cache_key/retention，真实命中看 cached_tokens。";
    case "deepseek_context_cache":
      return "DeepSeek Context Cache：不注入 OpenAI 私有参数；真实命中看 prompt_cache_hit_tokens / miss_tokens。";
    case "glm_context_cache":
    case "zai_context_cache":
      return "GLM/Z.AI 自动上下文缓存：保持稳定前缀，不注入 OpenAI 私有参数；真实命中看 cached_tokens。";
    case "qwen_context_cache":
      return "Qwen/DashScope 上下文缓存：按协议保持请求形态；真实命中看 cached_tokens / cache_creation_input_tokens。";
    case "anthropic_cache_control":
      return "Anthropic cache_control：只适用于 Anthropic/Bedrock 风格消息块。";
    case "auto_prefix_cache":
      return "自动前缀缓存：保持稳定前缀，不额外注入 OpenAI cache 参数。";
    default:
      return "缓存能力未知：只做基础连通性与路由验证，真实命中需看上游 usage。";
  }
}

// 给配置页提供三态说明：能在线读取、已有目录可继续、确实需要补全。
function providerConfigStatus(provider: Provider): {
  badge: string;
  badgeVariant: "outline" | "secondary" | "destructive";
  summary: string;
} {
  const config = getWizardModelFetchConfig(provider);
  if (config) {
    return {
      badge: "可自动获取模型",
      badgeVariant: "outline",
      summary: fetchConfigSummary(config),
    };
  }
  if (hasWizardModelCatalog(provider)) {
    return {
      badge: "已有模型目录，可继续",
      badgeVariant: "secondary",
      summary: "未配置在线获取参数，将使用当前 modelCatalog 生成路由",
    };
  }
  return {
    badge: "需补全配置",
    badgeVariant: "destructive",
    summary: "缺少 Base URL/API Key，且没有可用 modelCatalog",
  };
}

// 将内部状态机状态转换为用户能理解的短句，便于在向导顶部持续暴露当前进度。
function wizardStatusText(state: WizardFlowState): string {
  switch (state.status) {
    case "needSources":
      return "等待添加至少一个模型源。";
    case "configIncomplete":
      return "部分模型源不能自动获取模型，可补全配置或继续使用已有目录。";
    case "readyToFetchModels":
      return "配置已就绪，可以自动获取模型列表。";
    case "fetchingModels":
      return "正在读取各 provider 的模型列表。";
    case "modelFetchPartial":
      return "模型列表部分成功，请检查失败或跳过的 provider。";
    case "modelsFetched":
      return "模型列表已刷新，下一步处理重名模型。";
    case "probingConnectivity":
      return "正在对每个 provider/model 发起最小 /v1/responses 探测。";
    case "connectivityPassed":
      return "所有已测试模型都能直接响应 /v1/responses。";
    case "connectivityPartial":
      return "连通性测试存在可继续警告，请确认 Chat-only 或跳过项符合预期。";
    case "connectivityFailed":
      return "连通性测试存在阻塞项，请修复 provider 或模型后再保存发布。";
    case "collisionReviewRequired":
      return "检测到重名模型，需要确认别名策略。";
    case "routePreview":
      return "路由预览已生成，可以继续保存发布。";
    case "savingPlan":
      return "正在保存 MultiRouter provider。";
    case "saveFailed":
      return "保存失败，请修正后重试。";
    case "published":
      return "MultiRouter provider 已保存。";
    case "enabling":
      return "正在启用这个多路路由。";
    case "enableFailed":
      return "启用失败，请重试或检查本地代理状态。";
    case "enabled":
      return "已启用，状态页会等待最近一次 Codex 请求转发成功。";
    case "completed":
      return "向导已完成。";
    case "dismissed":
      return "向导已跳过。";
    case "opened":
    case "enablePrompt":
    default:
      return "按步骤完成多路模型配置。";
  }
}

// 把异常转换成面向用户的短文本，同时保留 console 中的详细错误对象。
function formatWizardError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 生成稳定但不依赖后端的异常 ID，方便 React 渲染和后续按阶段清理。
function createWizardIssueId(stage: WizardStepKey, title: string): string {
  return `${stage}:${title}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function CodexMultiRouterWizard({
  open,
  providers,
  onOpenChange,
  onCreateProvider,
  onOpenWorkspace,
  onEnablePlan,
}: CodexMultiRouterWizardProps) {
  const queryClient = useQueryClient();
  const [flowState, dispatchFlow] = useReducer(
    wizardFlowReducer,
    INITIAL_FLOW_STATE,
  );
  const [draftSources, setDraftSources] = useState<Provider[]>([]);
  const [savedPlan, setSavedPlan] = useState<Provider | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<
    WizardConnectivityResult[]
  >([]);
  const [isConnectivityConfirmOpen, setIsConnectivityConfirmOpen] =
    useState(false);
  const [wizardIssues, setWizardIssues] = useState<WizardIssue[]>([]);
  const initializedOpenRef = useRef(false);

  const existingPlan = useMemo(
    () => providers.find((provider) => isCodexMultiRouterPlan(provider)),
    [providers],
  );
  const providerModelSources = useMemo(
    () => defaultWizardModelSources(providers),
    [providers],
  );
  const stepIndex = STEPS.findIndex((step) => step.key === flowState.stepKey);
  const currentStep = STEPS[stepIndex];
  const CurrentStepIcon = currentStep.icon;
  const configIssues = useMemo(
    () => getWizardConfigIssues(draftSources),
    [draftSources],
  );
  const modelCollisions = useMemo(
    () => collectWizardModelNameCollisions(draftSources),
    [draftSources],
  );
  const isRefreshingModels = flowState.status === "fetchingModels";
  const isProbingConnectivity = flowState.status === "probingConnectivity";
  const isSavingPlan = flowState.status === "savingPlan";
  const isEnablingPlan = flowState.status === "enabling";

  // 每次打开向导只初始化一次。父组件 rerender 会传入新的 providers 数组，不能因此把用户从第 2 步重置回第 1 步。
  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      return;
    }
    if (initializedOpenRef.current) return;

    initializedOpenRef.current = true;
    setSavedPlan(existingPlan ?? null);
    setDraftSources(providerModelSources);
    setConnectivityResults([]);
    setWizardIssues([]);
    dispatchFlow({
      type: "INIT",
      hasSources: providerModelSources.length > 0,
    });
  }, [existingPlan, open, providerModelSources]);

  // 向导打开后仍要吸收用户新建/删除的普通 Codex provider，但不能重新派发 INIT。
  useEffect(() => {
    if (!open || !initializedOpenRef.current) return;
    setSavedPlan(existingPlan ?? null);
    setDraftSources((currentSources) => {
      const nextSourceById = new Map(
        providerModelSources.map((provider) => [provider.id, provider]),
      );
      const retainedSources = currentSources.filter((provider) =>
        nextSourceById.has(provider.id),
      );
      const retainedIds = new Set(
        retainedSources.map((provider) => provider.id),
      );
      const appendedSources = providerModelSources.filter(
        (provider) => !retainedIds.has(provider.id),
      );
      if (
        retainedSources.length === currentSources.length &&
        appendedSources.length === 0
      ) {
        return currentSources;
      }
      return [...retainedSources, ...appendedSources];
    });
  }, [existingPlan, open, providerModelSources]);

  // 所有异步 catch 都进入同一个问题列表，让 toast 之外的 UI 也能长期展示异常和继续策略。
  const recordWizardIssue = (issue: Omit<WizardIssue, "id">) => {
    setWizardIssues((current) => [
      ...current,
      {
        ...issue,
        id: createWizardIssueId(issue.stage, issue.title),
      },
    ]);
  };

  // 重新执行某个阶段时只清理该阶段旧问题，避免旧错误误导当前判断。
  const clearWizardIssuesForStage = (stage: WizardStepKey) => {
    setWizardIssues((current) =>
      current.filter((issue) => issue.stage !== stage),
    );
  };

  // 关闭/跳过时记录 dismissed；首页按钮仍可再次显式打开。
  const closeWizard = (dismissed = true) => {
    if (dismissed) {
      localStorage.setItem(CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY, "true");
      dispatchFlow({ type: "DISMISS" });
    } else {
      dispatchFlow({ type: "COMPLETE" });
    }
    onOpenChange(false);
  };

  // 下一步按钮按状态机 gate 推进；配置不完整时停在当前状态并给出可操作提示。
  const advanceWizard = () => {
    switch (currentStep.key) {
      case "intro":
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            draftSources.length > 0 ? "reviewProviderConfig" : "needSources",
          nextStepKey: "sources",
        });
        return;
      case "sources":
        if (draftSources.length === 0) {
          dispatchFlow({
            type: "NEXT",
            nextStatus: "needSources",
            nextStepKey: "sources",
          });
          toast.info("请先添加至少一个 Codex provider 作为模型源。", {
            closeButton: true,
          });
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            configIssues.length > 0 ? "configIncomplete" : "readyToFetchModels",
          nextStepKey: "providerConfig",
        });
        return;
      case "providerConfig":
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            configIssues.length > 0 ? "configIncomplete" : "readyToFetchModels",
          nextStepKey: "fetchModels",
        });
        if (configIssues.length > 0) {
          toast.warning(
            "部分 provider 不能自动获取模型，将使用已有 modelCatalog 或等待你补全配置。",
            {
              closeButton: true,
            },
          );
        }
        return;
      case "fetchModels":
        if (
          connectivityResults.length > 0 &&
          !canContinueAfterConnectivity(connectivityResults)
        ) {
          dispatchFlow({
            type: "NEXT",
            nextStatus: "connectivityFailed",
            nextStepKey: "fetchModels",
          });
          recordWizardIssue({
            stage: "fetchModels",
            severity: "error",
            title: "Responses 连通性存在阻塞项",
            detail:
              "至少一个 Responses 直连 provider 的 /v1/responses 探测失败，继续保存会让 Codex 请求命中不可用上游。",
            canContinue: false,
          });
          toast.error(
            "连通性测试仍有阻塞项，请先修复失败的 Responses provider。",
            {
              closeButton: true,
            },
          );
          return;
        }
        dispatchFlow({
          type: "NEXT",
          nextStatus:
            modelCollisions.length > 0
              ? "collisionReviewRequired"
              : "routePreview",
          nextStepKey: modelCollisions.length > 0 ? "collisions" : "routes",
        });
        return;
      case "collisions":
        setDraftSources(resolveWizardModelNameCollisions(draftSources));
        dispatchFlow({
          type: "NEXT",
          nextStatus: "routePreview",
          nextStepKey: "routes",
        });
        return;
      case "routes":
        dispatchFlow({
          type: "NEXT",
          nextStatus: "published",
          nextStepKey: "publish",
        });
        return;
      case "publish":
        toast.info("请点击“保存并发布”写入 MultiRouter provider。", {
          closeButton: true,
        });
        return;
      case "finish":
        closeWizard(false);
        return;
      default:
        return;
    }
  };

  // 上一步只改变教程步骤和对应状态，不回滚已经抓取/保存的草稿数据。
  const retreatWizard = () => {
    const previousStep = STEPS[Math.max(0, stepIndex - 1)];
    dispatchFlow({ type: "GOTO_STEP", stepKey: previousStep.key });
  };

  // 顺序抓取所有可抓模型源；失败不阻塞其它 provider，最终由保存页继续使用已成功目录。
  const refreshModelSources = async () => {
    dispatchFlow({ type: "FETCH_START" });
    clearWizardIssuesForStage("fetchModels");
    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    try {
      const nextSources: Provider[] = [];
      for (const provider of draftSources) {
        const config = getWizardModelFetchConfig(provider);
        if (!config) {
          skippedCount += 1;
          nextSources.push(provider);
          continue;
        }
        try {
          const fetchedModels = await fetchModelsForConfig(
            config.baseUrl,
            config.apiKey,
            config.isFullUrl,
            config.modelsUrl,
            config.customUserAgent,
          );
          const nextProvider = mergeFetchedModelsIntoWizardProvider(
            provider,
            fetchedModels,
          );
          await providersApi.update(nextProvider, "codex");
          nextSources.push(nextProvider);
          successCount += 1;
        } catch (error) {
          console.error("[CodexMultiRouterWizard] fetch models failed", error);
          const message = formatWizardError(error);
          recordWizardIssue({
            stage: "fetchModels",
            severity: "warning",
            title: "模型列表获取失败",
            detail: message,
            canContinue: true,
            providerName: provider.name,
          });
          failedCount += 1;
          nextSources.push(provider);
        }
      }
      setDraftSources(resolveWizardModelNameCollisions(nextSources));
      setConnectivityResults([]);
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      dispatchFlow({
        type: "FETCH_DONE",
        partial: failedCount > 0 || skippedCount > 0,
        summary: { successCount, skippedCount, failedCount },
      });
      toast.success(
        `模型列表刷新完成：${successCount} 个成功，${skippedCount} 个跳过，${failedCount} 个失败。`,
        { closeButton: true },
      );
    } catch (error) {
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "fetchModels",
        severity: "error",
        title: "模型列表刷新中断",
        detail: message,
        canContinue: false,
      });
      dispatchFlow({
        type: "FETCH_DONE",
        partial: true,
        summary: { successCount, skippedCount, failedCount },
      });
      toast.error(`模型列表刷新中断：${message}`, {
        closeButton: true,
      });
    }
  };

  // 对每个 provider 的每个可见模型发起 Responses + Chat 双协议探测；这是用户确认后的真实上游请求。
  const probeResponsesConnectivity = async () => {
    setIsConnectivityConfirmOpen(false);
    dispatchFlow({ type: "PROBE_START" });
    clearWizardIssuesForStage("fetchModels");
    const results: WizardConnectivityResult[] = [];
    for (const provider of draftSources) {
      const config = getWizardModelFetchConfig(provider);
      const models = getWizardConnectivityProbeModels(provider);
      if (!config) {
        results.push(
          skippedWizardConnectivityResult(
            provider,
            "缺少 Base URL 或 API Key，跳过 Chat / Responses 双协议探测",
          ),
        );
        continue;
      }
      if (models.length === 0) {
        results.push(
          skippedWizardConnectivityResult(
            provider,
            "没有可探测模型，跳过 Chat / Responses 双协议探测",
          ),
        );
        continue;
      }
      for (const model of models) {
        try {
          const responsesProbe = await probeCodexResponsesForConfig(
            config.baseUrl,
            config.apiKey,
            model,
            config.isFullUrl,
            config.customUserAgent,
          );
          const chatProbe = await probeCodexChatForConfig(
            config.baseUrl,
            config.apiKey,
            model,
            config.isFullUrl,
            config.customUserAgent,
          );
          results.push(
            classifyWizardDualProtocolConnectivityResult({
              provider,
              model,
              responses: {
                ok: responsesProbe.ok,
                detail: responsesProbe.detail,
                url: responsesProbe.url,
                httpStatus: responsesProbe.status,
              },
              chat: {
                ok: chatProbe.ok,
                detail: chatProbe.detail,
                url: chatProbe.url,
                httpStatus: chatProbe.status,
              },
            }),
          );
        } catch (error) {
          const message = formatWizardError(error);
          const classified = classifyWizardConnectivityResult({
            provider,
            model,
            ok: false,
            detail: message,
          });
          recordWizardIssue({
            stage: "fetchModels",
            severity: classified.canContinue ? "warning" : "error",
            title: "连通性探测命令异常",
            detail: message,
            canContinue: classified.canContinue,
            providerName: provider.name,
          });
          results.push(classified);
        }
      }
    }

    const summary = {
      passCount: results.filter((result) => result.status === "pass").length,
      warnCount: results.filter((result) => result.status === "warn").length,
      skippedCount: results.filter((result) => result.status === "skipped")
        .length,
      failCount: results.filter((result) => result.status === "fail").length,
    };
    setConnectivityResults(results);
    dispatchFlow({
      type: "PROBE_DONE",
      canContinue: canContinueAfterConnectivity(results),
      hasWarnings: summary.warnCount > 0 || summary.skippedCount > 0,
      summary,
    });
    toast.success(
      `连通性测试完成：通过 ${summary.passCount}，警告 ${summary.warnCount}，跳过 ${summary.skippedCount}，失败 ${summary.failCount}。`,
      { closeButton: true },
    );
  };

  // 保存 MultiRouter provider；这里才真正写入 DB，不会静默切换当前 Codex provider。
  const saveMultiRouterPlan = async () => {
    dispatchFlow({ type: "SAVE_START" });
    clearWizardIssuesForStage("publish");
    try {
      const routeReadySources = applyWizardConnectivityApiFormatOverrides(
        draftSources,
        connectivityResults,
      );
      const result = buildCodexMultiRouterWizardPlan(
        providers,
        routeReadySources,
        existingPlan,
      );
      if (existingPlan) {
        await providersApi.update(result.plan, "codex");
      } else {
        await providersApi.add(result.plan, "codex", false);
      }
      setSavedPlan(result.plan);
      setDraftSources(result.sourceProviders);
      await queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      toast.success("MultiRouter 方案已保存。", { closeButton: true });
      dispatchFlow({ type: "SAVE_SUCCESS" });
    } catch (error) {
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "publish",
        severity: "error",
        title: "MultiRouter 保存失败",
        detail: message,
        canContinue: false,
      });
      dispatchFlow({ type: "SAVE_ERROR", error: message });
      toast.error(`MultiRouter 保存失败：${message}`, { closeButton: true });
    }
  };

  // 启用动作复用 App 里的 switchProvider 路径，保证 Codex 接管和 OAuth 保留逻辑保持一致。
  const enableSavedPlan = async () => {
    if (!savedPlan) return;
    dispatchFlow({ type: "ENABLE_START" });
    clearWizardIssuesForStage("finish");
    try {
      await onEnablePlan(savedPlan);
      dispatchFlow({ type: "ENABLE_SUCCESS" });
      toast.success(
        "已启用多路模型，状态页已打开。请在 Codex 里发送一次请求，等待当前链路、监听、Codex 接管、路由入口和最近转发都成功后，会自动进入历史修复。",
        {
          closeButton: true,
          duration: 12000,
        },
      );
      closeWizard(false);
    } catch (error) {
      const message = formatWizardError(error);
      recordWizardIssue({
        stage: "finish",
        severity: "error",
        title: "启用多路路由失败",
        detail: message,
        canContinue: false,
      });
      dispatchFlow({ type: "ENABLE_ERROR", error: message });
      toast.error(`启用多路路由失败：${message}`, { closeButton: true });
    }
  };

  if (!open) return null;

  const routeReadySources = applyWizardConnectivityApiFormatOverrides(
    draftSources,
    connectivityResults,
  );
  const planPreview = buildCodexMultiRouterWizardPlan(
    providers,
    routeReadySources,
    existingPlan,
  ).plan;
  const previewRoutes = (planPreview.settingsConfig.codexRouting?.routes ??
    []) as CodexRoutingRoute[];
  const previewModels = (planPreview.settingsConfig.modelCatalog?.models ??
    []) as CodexCatalogModel[];

  return createPortal(
    <div className="fixed inset-0 z-[120] bg-black/70 text-foreground backdrop-blur-sm">
      <div className="absolute inset-x-3 top-4 mx-auto w-[min(96vw,1280px)] rounded-lg border border-white/15 bg-background shadow-2xl">
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <CurrentStepIcon className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">
                第 {stepIndex + 1} / {STEPS.length} 步
              </div>
              <h2 className="text-xl font-semibold">{currentStep.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {currentStep.description}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => closeWizard(true)}
            aria-label="关闭多路模型配置向导"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="grid max-h-[82vh] grid-cols-[15rem_minmax(0,1fr)] overflow-hidden">
          <div className="space-y-1 border-r bg-muted/30 p-3">
            {STEPS.map((step, index) => {
              const StepIcon = step.icon;
              return (
                <button
                  key={step.key}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                    index === stepIndex
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                  onClick={() =>
                    dispatchFlow({ type: "GOTO_STEP", stepKey: step.key })
                  }
                >
                  <StepIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{step.title}</span>
                </button>
              );
            })}
          </div>

          <div className="overflow-y-auto p-5">
            <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">状态机：{flowState.status}</Badge>
                <span className="text-muted-foreground">
                  {wizardStatusText(flowState)}
                </span>
              </div>
              {flowState.fetchSummary && (
                <div className="mt-2 text-xs text-muted-foreground">
                  最近一次获取模型：成功 {flowState.fetchSummary.successCount}
                  ，跳过 {flowState.fetchSummary.skippedCount}，失败{" "}
                  {flowState.fetchSummary.failedCount}
                </div>
              )}
              {flowState.connectivitySummary && (
                <div className="mt-2 text-xs text-muted-foreground">
                  最近一次 Chat / Responses 基础协议测试：通过{" "}
                  {flowState.connectivitySummary.passCount}，警告{" "}
                  {flowState.connectivitySummary.warnCount}，跳过{" "}
                  {flowState.connectivitySummary.skippedCount}，失败{" "}
                  {flowState.connectivitySummary.failCount}
                </div>
              )}
              {flowState.lastError && (
                <div className="mt-2 text-xs text-destructive">
                  {flowState.lastError}
                </div>
              )}
            </div>
            {wizardIssues.length > 0 && (
              <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <div className="font-medium text-foreground">
                  已捕获问题与处理状态
                </div>
                <div className="mt-2 space-y-2">
                  {wizardIssues.map((issue) => (
                    <div
                      key={issue.id}
                      className="rounded-md border bg-background/80 p-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            issue.severity === "error"
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {issue.severity === "error" ? "错误" : "警告"}
                        </Badge>
                        <span className="font-medium">{issue.title}</span>
                        {issue.providerName && (
                          <span className="text-xs text-muted-foreground">
                            {issue.providerName}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {issue.canContinue ? "可继续" : "需处理后继续"}
                        </span>
                      </div>
                      <div className="mt-1 break-words text-xs text-muted-foreground">
                        {issue.detail}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-4 rounded-lg border p-3 text-sm">
              <div className="font-medium">本步骤异常与继续条件</div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {STEP_RULES[currentStep.key].errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
              <div className="mt-2 text-xs text-muted-foreground">
                可继续判断：{STEP_RULES[currentStep.key].canContinue}
              </div>
            </div>

            {currentStep.key === "intro" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4">
                  <div className="flex items-center gap-2 font-medium">
                    <Wand2 className="h-4 w-4" />
                    这套向导会帮你完成 4 件事
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {[
                      "把 OpenAI、中转站、DeepSeek、Qwen、本地模型接进来",
                      "自动读取模型列表，并处理官方模型和中转模型重名",
                      "按模型名称生成分流规则，让 Codex 自动选上游",
                      "启用后等待真实请求成功，再带你修复历史记录",
                    ].map((item, index) => (
                      <div
                        key={item}
                        className="flex gap-3 rounded-md border bg-muted/30 p-3 text-sm"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                          {index + 1}
                        </span>
                        <span className="leading-6">{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
                  你不用手动改配置文件。向导会先预览模型源、连通性和路由规则，只有点击“保存并发布”后才写入本地
                  providers 数据库；点击“启用这个多路路由”后才会接管当前 Codex。
                </div>
                <div className="rounded-lg border bg-muted/30 p-4 text-xs leading-6 text-muted-foreground">
                  技术备注：Codex 最后仍只连接本机 127.0.0.1:15721，
                  CCSwitchMulti 会根据请求里的 model 把流量发到对应上游。
                </div>
              </div>
            )}

            {currentStep.key === "sources" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    当前识别到 {draftSources.length} 个普通 Codex provider
                    可作为模型源。
                  </p>
                  <Button onClick={onCreateProvider}>
                    <Server className="mr-2 h-4 w-4" />
                    添加 Provider
                  </Button>
                </div>
                <div className="max-h-[min(42vh,28rem)] overflow-y-auto pr-2">
                  <div className="grid gap-3 md:grid-cols-2">
                    {draftSources.map((provider) => (
                      <div key={provider.id} className="rounded-lg border p-3">
                        <div className="font-medium">{provider.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {provider.id}
                        </div>
                        <Badge variant="outline" className="mt-3">
                          {modelSourceSummary(provider)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
                {draftSources.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    状态机当前停在 NeedSources。请先添加一个普通 Codex
                    provider，或关闭向导后从已有配置导入。
                  </div>
                )}
              </div>
            )}

            {currentStep.key === "providerConfig" && (
              <div className="space-y-3">
                {configIssues.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                    {configIssues.length} 个 provider
                    不能自动获取模型。你可以补全 Base URL/API
                    Key，或继续使用已有 modelCatalog。
                  </div>
                )}
                <div className="max-h-[min(46vh,32rem)] space-y-3 overflow-y-auto pr-2">
                  {draftSources.map((provider) => {
                    const status = providerConfigStatus(provider);
                    return (
                      <div
                        key={provider.id}
                        className="rounded-lg border p-4 text-sm"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-medium">{provider.name}</div>
                          <Badge variant={status.badgeVariant}>
                            {status.badge}
                          </Badge>
                        </div>
                        <div className="mt-2 text-muted-foreground">
                          {status.summary}
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          API 格式：
                          {provider.meta?.apiFormat ??
                            provider.settingsConfig?.apiFormat ??
                            provider.settingsConfig?.api_format ??
                            "未显式设置，向导保存路由时默认 Chat Completions"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {currentStep.key === "fetchModels" && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <Button
                    onClick={refreshModelSources}
                    disabled={
                      isRefreshingModels ||
                      isProbingConnectivity ||
                      draftSources.length === 0
                    }
                  >
                    <RefreshCw
                      className={`mr-2 h-4 w-4 ${
                        isRefreshingModels ? "animate-spin" : ""
                      }`}
                    />
                    自动获取并写入模型列表
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setIsConnectivityConfirmOpen(true)}
                    disabled={
                      isRefreshingModels ||
                      isProbingConnectivity ||
                      draftSources.length === 0
                    }
                  >
                    <Route
                      className={`mr-2 h-4 w-4 ${
                        isProbingConnectivity ? "animate-pulse" : ""
                      }`}
                    />
                    测试 Chat / Responses 连通性
                  </Button>
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                  连通性测试会对每个 provider 的每个可见模型分别发送
                  /v1/responses 与 /v1/chat/completions 真实请求，输出上限为
                  1024。测试结果会用来判断该 provider 应走 Responses 还是 Chat
                  转换路径；通过只代表基础协议入口可用，不代表工具调用、流式输出、长上下文、多模态或真实
                  Codex 会话一定完整正常。
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {draftSources.map((provider) => (
                    <div key={provider.id} className="rounded-lg border p-3">
                      <div className="font-medium">{provider.name}</div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        {modelSourceSummary(provider)}
                      </div>
                    </div>
                  ))}
                </div>
                {connectivityResults.length > 0 && (
                  <div className="max-h-80 overflow-auto rounded-lg border">
                    {connectivityResults.map((result, index) => (
                      <div
                        key={`${result.providerId}:${result.model}:${index}`}
                        className="grid grid-cols-[7rem_1fr] gap-3 border-b px-3 py-2 text-sm last:border-b-0"
                      >
                        <Badge
                          variant={
                            result.status === "fail" ? "destructive" : "outline"
                          }
                          className="h-fit justify-center"
                        >
                          {result.status}
                        </Badge>
                        <div>
                          <div className="font-medium">
                            {result.providerName} / {result.model}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {result.detail}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {currentStep.key === "collisions" && (
              <div className="space-y-4">
                <Button
                  variant="outline"
                  onClick={() =>
                    setDraftSources(
                      resolveWizardModelNameCollisions(draftSources),
                    )
                  }
                >
                  <ShieldAlert className="mr-2 h-4 w-4" />
                  重新计算重名别名
                </Button>
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  同名策略：官方/订阅模型保留原名；中转站或第三方模型显示成
                  gpt-5.4-mini-relay 这类别名，upstreamModel
                  仍指向真实上游模型名。
                </div>
                {modelCollisions.length > 0 && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
                    检测到 {modelCollisions.length}{" "}
                    组上游模型重名。点击下一步时会先应用别名策略，再生成路由。
                  </div>
                )}
                <div className="max-h-72 overflow-auto rounded-lg border">
                  {previewModels.slice(0, 80).map((model) => (
                    <div
                      key={`${model.model}:${model.upstreamModel ?? ""}`}
                      className="flex items-center justify-between border-b px-3 py-2 text-sm last:border-b-0"
                    >
                      <span>{model.model}</span>
                      <span className="text-muted-foreground">
                        {model.upstreamModel &&
                        model.upstreamModel !== model.model
                          ? `上游 ${model.upstreamModel}`
                          : "原名"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {currentStep.key === "routes" && (
              <div className="space-y-3">
                {previewRoutes.map((route) => (
                  <div key={route.id} className="rounded-lg border p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium">{route.label}</div>
                      <Badge variant="outline">
                        {route.upstream.apiFormat}
                      </Badge>
                    </div>
                    <div className="mt-2 text-sm text-muted-foreground">
                      模型 {route.match.models?.length ?? 0} 个；前缀{" "}
                      {(route.match.prefixes ?? []).join(", ") || "无"}
                    </div>
                    <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">
                      {cacheCapabilitySummary(route.capabilities?.codexCache)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {currentStep.key === "publish" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                  将保存 {previewRoutes.length} 条路由和 {previewModels.length}{" "}
                  个可见模型到{" "}
                  {existingPlan ? existingPlan.name : "新的 MultiRouter"}。
                </div>
                <Button
                  onClick={saveMultiRouterPlan}
                  disabled={
                    isSavingPlan ||
                    draftSources.length === 0 ||
                    (connectivityResults.length > 0 &&
                      !canContinueAfterConnectivity(connectivityResults))
                  }
                >
                  <Database className="mr-2 h-4 w-4" />
                  {isSavingPlan ? "正在保存..." : "保存并发布"}
                </Button>
              </div>
            )}

            {currentStep.key === "finish" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
                  保存完成后，请显式启用这个多路路由。启用成功后向导会自动关闭，并露出
                  MultiRouter 状态页；保持 CCSwitchMulti 运行，去 Codex
                  里发送一次请求，状态页五项成功后会提示配置成功并跳到历史修复。
                  历史修复会继续指导你按顺序加载历史、预览修复、确认写入、重启
                  Codex，并打开 GitHub 仓库点 Star。
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button
                    onClick={enableSavedPlan}
                    disabled={!savedPlan || isEnablingPlan}
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    启用这个多路路由
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!savedPlan}
                    onClick={() => {
                      if (!savedPlan) return;
                      closeWizard(false);
                      onOpenWorkspace(savedPlan, "status");
                    }}
                  >
                    <Route className="mr-2 h-4 w-4" />
                    打开状态页继续验证
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <Dialog
          open={isConnectivityConfirmOpen}
          onOpenChange={setIsConnectivityConfirmOpen}
        >
          <DialogContent className="max-w-lg" zIndex="alert">
            <DialogHeader>
              <DialogTitle>确认开始连通性测试</DialogTitle>
              <DialogDescription className="space-y-2 text-left">
                <span className="block">
                  这个流程需要确认每个 provider/model 到底应该使用 Responses
                  还是 Chat
                  Completions。测试会向上游发送真实请求，可能产生少量额度或流量消耗，也可能触发限流。
                </span>
                <span className="block">
                  每个模型会分别测试 /v1/responses 和
                  /v1/chat/completions，输出上限为
                  1024。都不通时通常不是协议问题，而是 API Key、Base
                  URL、模型权限、额度、网络或上游故障。
                </span>
                <span className="block">
                  注意：Responses 通过只证明最小非流式请求能返回成功，不等于完整
                  Codex 功能验证。保存启用后仍需要在状态页和真实 Codex
                  会话里确认路由、流式响应、工具调用和历史修复流程。
                </span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsConnectivityConfirmOpen(false)}
              >
                取消
              </Button>
              <Button type="button" onClick={probeResponsesConnectivity}>
                确认测试
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <div className="flex items-center justify-between border-t px-5 py-4">
          <Button variant="ghost" onClick={() => closeWizard(true)}>
            跳过
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={retreatWizard}
              disabled={stepIndex === 0}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              上一步
            </Button>
            <Button onClick={advanceWizard}>
              {stepIndex === STEPS.length - 1 ? "关闭" : "下一步"}
              {stepIndex !== STEPS.length - 1 && (
                <ArrowRight className="ml-2 h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
