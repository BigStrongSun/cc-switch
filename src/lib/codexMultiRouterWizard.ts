import type {
  CodexApiFormat,
  CodexCacheConfig,
  CodexCatalogModel,
  CodexModelCatalogConfig,
  CodexRoutingConfig,
  CodexRoutingRoute,
  Provider,
} from "@/types";
import type { FetchedModel } from "@/lib/api/model-fetch";

export const CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY =
  "ccswitchmulti.codexMultiRouterWizard.dismissed";
export const CODEX_MULTI_ROUTER_DEFAULT_ID = "codex-multirouter";
export const CODEX_MULTI_ROUTER_DEFAULT_NAME = "Codex MultiRouter";
export const CODEX_MULTI_ROUTER_PROXY_BASE_URL = "http://127.0.0.1:15721/v1";

export interface WizardModelFetchConfig {
  baseUrl: string;
  apiKey: string;
  isFullUrl?: boolean;
  modelsUrl?: string;
  customUserAgent?: string;
}

export interface WizardPlanBuildResult {
  plan: Provider;
  sourceProviders: Provider[];
}

export interface WizardConfigIssue {
  providerId: string;
  providerName: string;
  reason: string;
}

export interface WizardModelNameCollision {
  upstreamModel: string;
  providerIds: string[];
  canonicalProviderIds: string[];
}

export type WizardConnectivityStatus = "pass" | "warn" | "fail" | "skipped";

export interface WizardConnectivityResult {
  providerId: string;
  providerName: string;
  model: string;
  status: WizardConnectivityStatus;
  canContinue: boolean;
  detail: string;
  recommendedApiFormat?: CodexApiFormat;
  url?: string;
  httpStatus?: number | null;
}

export interface WizardProtocolProbe {
  ok: boolean;
  detail: string;
  url?: string;
  httpStatus?: number | null;
}

const OPENAI_CODEX_FALLBACK_MODELS: CodexCatalogModel[] = [
  { model: "gpt-5.5", upstreamModel: "gpt-5.5", contextWindow: 272000 },
  { model: "gpt-5.4", upstreamModel: "gpt-5.4", contextWindow: 272000 },
  {
    model: "gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    contextWindow: 128000,
  },
  {
    model: "gpt-5.3-codex-spark",
    upstreamModel: "gpt-5.3-codex-spark",
    contextWindow: 128000,
  },
];

// 判断模型源是否是官方/OAuth 路径；这些 provider 常常不能通过普通 /models 获取目录。
function isOfficialCodexSource(provider: Provider): boolean {
  const text = `${provider.id} ${provider.name} ${provider.category ?? ""} ${
    provider.meta?.providerType ?? ""
  }`.toLowerCase();
  const providerType = String(provider.meta?.providerType ?? "").toLowerCase();
  const idOrName = `${provider.id} ${provider.name}`.toLowerCase();
  return (
    provider.category === "official" ||
    providerType.includes("codex_oauth") ||
    text.includes("codex_oauth") ||
    idOrName === "openai openai" ||
    (idOrName.includes("openai") && idOrName.includes("official"))
  );
}

// 读取 Codex provider 的模型目录；旧数据缺失或结构异常时返回空目录，避免向导崩溃。
export function readWizardModelCatalog(
  provider: Provider,
): CodexCatalogModel[] {
  const models = provider.settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(models)) {
    return isOfficialCodexSource(provider)
      ? OPENAI_CODEX_FALLBACK_MODELS.map((model) => ({ ...model }))
      : [];
  }
  const normalizedModels = models
    .map((model) => model as CodexCatalogModel)
    .filter((model) => typeof model.model === "string" && model.model.trim());
  if (normalizedModels.length === 0 && isOfficialCodexSource(provider)) {
    return OPENAI_CODEX_FALLBACK_MODELS.map((model) => ({ ...model }));
  }
  return normalizedModels;
}

// 判断 provider 是否是 MultiRouter 方案；向导只把普通 provider 当作上游模型源。
export function isCodexMultiRouterPlan(provider: Provider): boolean {
  const routing = provider.settingsConfig?.codexRouting;
  return Boolean(
    routing &&
      typeof routing === "object" &&
      (routing.enabled !== false || Array.isArray(routing.routes)),
  );
}

// 从 provider 配置里提取可调用 /models 的参数；官方 OAuth provider 没有普通 Base URL 时会被跳过。
export function getWizardModelFetchConfig(
  provider: Provider,
): WizardModelFetchConfig | null {
  const config = provider.settingsConfig ?? {};
  const auth = config.auth ?? {};
  const baseUrl = String(
    config.base_url ?? config.baseURL ?? config.baseUrl ?? "",
  ).trim();
  const apiKey = String(
    auth.OPENAI_API_KEY ??
      config.apiKey ??
      config.api_key ??
      config.experimental_bearer_token ??
      "",
  ).trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    isFullUrl: Boolean(provider.meta?.isFullUrl ?? config.isFullUrl),
    modelsUrl:
      typeof config.modelsUrl === "string" ? config.modelsUrl : undefined,
    customUserAgent: provider.meta?.customUserAgent,
  };
}

// 判断 provider 是否已有可用于路由的模型目录；官方 fallback 会在 readWizardModelCatalog 中统一补齐。
export function hasWizardModelCatalog(provider: Provider): boolean {
  return readWizardModelCatalog(provider).length > 0;
}

// 给状态机提供配置缺口列表；已有模型目录的 provider 可以继续进入路由预览，不强制要求 /models 可抓。
export function getWizardConfigIssues(
  providers: Provider[],
): WizardConfigIssue[] {
  return providers
    .filter(
      (provider) =>
        !getWizardModelFetchConfig(provider) &&
        !hasWizardModelCatalog(provider),
    )
    .map((provider) => ({
      providerId: provider.id,
      providerName: provider.name,
      reason: "缺少 Base URL/API Key，且当前没有可用 modelCatalog。",
    }));
}

// 把 /models 返回值合并进 provider modelCatalog；保留已有用户手写字段和 upstreamModel。
export function mergeFetchedModelsIntoWizardProvider(
  provider: Provider,
  fetchedModels: FetchedModel[],
): Provider {
  const existingModels = readWizardModelCatalog(provider);
  const byModel = new Map<string, CodexCatalogModel>();
  for (const model of existingModels) {
    byModel.set(model.model, model);
  }
  for (const fetched of fetchedModels) {
    const modelId = fetched.id.trim();
    if (!modelId) continue;
    const existing = byModel.get(modelId);
    byModel.set(modelId, {
      ...(existing ?? {}),
      model: modelId,
      upstreamModel:
        existing?.upstreamModel ?? existing?.upstream_model ?? modelId,
      displayName: existing?.displayName ?? modelId,
      ...(fetched.contextWindow
        ? { contextWindow: fetched.contextWindow }
        : {}),
    });
  }
  return {
    ...provider,
    settingsConfig: {
      ...provider.settingsConfig,
      modelCatalog: {
        ...(provider.settingsConfig?.modelCatalog ?? {}),
        models: Array.from(byModel.values()),
      },
    },
  };
}

// 判断某个模型源是否应该优先保留原始可见模型名；官方/订阅源是重名冲突的 canonical 侧。
function isCanonicalModelSource(provider: Provider): boolean {
  return isOfficialCodexSource(provider);
}

// 收集重名模型冲突，供向导进入“重名确认”状态并展示需要用户理解的别名策略。
export function collectWizardModelNameCollisions(
  providers: Provider[],
): WizardModelNameCollision[] {
  const ownersByUpstream = new Map<string, Provider[]>();
  for (const provider of providers) {
    for (const model of readWizardModelCatalog(provider)) {
      const upstream =
        model.upstreamModel ?? model.upstream_model ?? model.model;
      if (!upstream) continue;
      const owners = ownersByUpstream.get(upstream) ?? [];
      owners.push(provider);
      ownersByUpstream.set(upstream, owners);
    }
  }
  return Array.from(ownersByUpstream.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([upstreamModel, owners]) => ({
      upstreamModel,
      providerIds: owners.map((owner) => owner.id),
      canonicalProviderIds: owners
        .filter(isCanonicalModelSource)
        .map((owner) => owner.id),
    }));
}

// 把 provider 展示名清理成可放进模型 ID 的稳定后缀；优先使用用户能看懂的名称，避免泄露自动生成 ID。
function providerNameSuffix(provider: Provider): string {
  const cleanedName = provider.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleanedName) return cleanedName;
  return (
    provider.id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "provider"
  );
}

// 为非官方重名模型生成稳定别名，保留 upstreamModel 指向真实上游模型名。
function aliasModelName(provider: Provider, modelName: string): string {
  return `${modelName}-${providerNameSuffix(provider)}`;
}

// 判断模型目录是否主要是 OpenAI 官方 GPT/O 系列；这些模型应优先保持 Responses 原生链路。
function hasOpenAiResponsesNativeModels(provider: Provider): boolean {
  if (!isOfficialCodexSource(provider)) return false;
  return readWizardModelCatalog(provider).some((model) => {
    const upstream = (
      model.upstreamModel ??
      model.upstream_model ??
      model.model ??
      ""
    )
      .trim()
      .toLowerCase();
    return upstream.startsWith("gpt-") || /^o\d/.test(upstream);
  });
}

// 检测多个 provider 暴露的同名模型；官方保留原名，第三方/中转站自动生成可见别名。
export function resolveWizardModelNameCollisions(
  providers: Provider[],
): Provider[] {
  const ownersByUpstream = new Map<string, Provider[]>();
  for (const provider of providers) {
    for (const model of readWizardModelCatalog(provider)) {
      const upstream =
        model.upstreamModel ?? model.upstream_model ?? model.model;
      if (!upstream) continue;
      const owners = ownersByUpstream.get(upstream) ?? [];
      owners.push(provider);
      ownersByUpstream.set(upstream, owners);
    }
  }

  return providers.map((provider) => {
    const nextModels = readWizardModelCatalog(provider).map((model) => {
      const upstream =
        model.upstreamModel ?? model.upstream_model ?? model.model;
      const owners = ownersByUpstream.get(upstream) ?? [];
      if (owners.length <= 1 || isCanonicalModelSource(provider)) {
        return { ...model, upstreamModel: upstream };
      }
      return {
        ...model,
        model: aliasModelName(provider, upstream),
        displayName: model.displayName ?? aliasModelName(provider, upstream),
        upstreamModel: upstream,
      };
    });
    return {
      ...provider,
      settingsConfig: {
        ...provider.settingsConfig,
        modelCatalog: {
          ...(provider.settingsConfig?.modelCatalog ?? {}),
          models: nextModels,
        },
      },
    };
  });
}

// 按 provider 名称和模型名推断默认前缀；这些前缀只作为向导初始规则，后续可在工作台细调。
export function inferWizardRoutePrefixes(provider: Provider): string[] {
  const text = `${provider.id} ${provider.name} ${provider.category ?? ""} ${
    provider.meta?.providerType ?? ""
  }`.toLowerCase();
  const models = readWizardModelCatalog(provider).map((model) =>
    model.model.toLowerCase(),
  );
  const has = (value: string) =>
    text.includes(value) || models.some((model) => model.startsWith(value));
  const prefixes = new Set<string>();
  if (has("openai") || has("gpt")) prefixes.add("gpt");
  if (has("openai") || models.some((model) => /^o\d/.test(model))) {
    prefixes.add("o");
  }
  if (has("deepseek")) prefixes.add("deepseek");
  if (has("qwen")) prefixes.add("qwen");
  if (has("ollama") || has("vllm") || has("local")) prefixes.add("local");
  return Array.from(prefixes);
}

// 推断 route 上游协议；官方 GPT/O 模型优先走 Responses，未知第三方默认走 Chat Completions。
export function inferWizardApiFormat(provider: Provider): CodexApiFormat {
  const config = provider.settingsConfig ?? {};
  if (hasOpenAiResponsesNativeModels(provider)) {
    return "openai_responses";
  }
  return (
    provider.meta?.apiFormat ??
    config.apiFormat ??
    config.api_format ??
    "openai_chat"
  );
}

// 推断 provider 的缓存能力；这里只生成安全默认，不会让自动缓存平台收到 OpenAI 私有参数。
export function inferWizardCacheConfig(provider: Provider): CodexCacheConfig {
  const text = `${provider.id} ${provider.name} ${provider.category ?? ""} ${
    provider.meta?.providerType ?? ""
  }`.toLowerCase();
  const models = readWizardModelCatalog(provider).map((model) =>
    String(model.upstreamModel ?? model.upstream_model ?? model.model)
      .trim()
      .toLowerCase(),
  );
  const hasModel = (needle: string) =>
    models.some((model) => model.includes(needle));
  if (
    isOfficialCodexSource(provider) ||
    hasOpenAiResponsesNativeModels(provider)
  ) {
    return {
      cacheMode: "openai_prompt_cache",
      supportsPromptCacheKey: true,
      supportsPromptCacheRetention: true,
      promptCacheKey: provider.meta?.promptCacheKey,
      promptCacheRetention: provider.meta?.promptCacheRetention,
      usageFields: [
        "usage.input_tokens_details.cached_tokens",
        "usage.prompt_tokens_details.cached_tokens",
      ],
    };
  }
  if (text.includes("deepseek") || hasModel("deepseek")) {
    return {
      cacheMode: "deepseek_context_cache",
      usageFields: [
        "usage.prompt_cache_hit_tokens",
        "usage.prompt_cache_miss_tokens",
      ],
    };
  }
  if (
    text.includes("z.ai") ||
    text.includes("zai") ||
    text.includes("glm") ||
    hasModel("glm")
  ) {
    return {
      cacheMode: "glm_context_cache",
      usageFields: ["usage.prompt_tokens_details.cached_tokens"],
    };
  }
  if (text.includes("dashscope") || text.includes("qwen") || hasModel("qwen")) {
    return {
      cacheMode: "qwen_context_cache",
      usageFields: [
        "usage.input_tokens_details.cached_tokens",
        "usage.prompt_tokens_details.cached_tokens",
        "usage.prompt_tokens_details.cache_creation_input_tokens",
      ],
    };
  }
  return { cacheMode: "unknown" };
}

// 每个 provider 默认探测其 modelCatalog 暴露的全部可见模型；这是用户显式点击的真实请求，不在向导自动执行。
export function getWizardConnectivityProbeModels(provider: Provider): string[] {
  return Array.from(
    new Set(
      readWizardModelCatalog(provider)
        .map((model) => model.model?.trim())
        .filter((model): model is string => Boolean(model)),
    ),
  );
}

// 将真实 `/v1/responses` 探测结果归类为“可继续/阻塞”；Chat-only provider 的 Responses 失败不是阻塞。
export function classifyWizardConnectivityResult(args: {
  provider: Provider;
  model: string;
  ok: boolean;
  detail: string;
  url?: string;
  httpStatus?: number | null;
}): WizardConnectivityResult {
  const apiFormat = inferWizardApiFormat(args.provider);
  if (args.ok) {
    return {
      providerId: args.provider.id,
      providerName: args.provider.name,
      model: args.model,
      status: "pass",
      canContinue: true,
      detail: "直接 /v1/responses 探测通过。",
      url: args.url,
      httpStatus: args.httpStatus,
    };
  }

  const chatOnlyCanContinue = apiFormat === "openai_chat";
  return {
    providerId: args.provider.id,
    providerName: args.provider.name,
    model: args.model,
    status: chatOnlyCanContinue ? "warn" : "fail",
    canContinue: chatOnlyCanContinue,
    detail: chatOnlyCanContinue
      ? `直接 /v1/responses 失败，但该 provider 配置为 Chat Completions；运行时会由 MultiRouter 转换到 /chat/completions。上游返回：${args.detail}`
      : `该 provider 配置为 Responses 直连，/v1/responses 失败会阻塞真实 Codex 请求。上游返回：${args.detail}`,
    url: args.url,
    httpStatus: args.httpStatus,
  };
}

// 结合 Responses 与 Chat 两条真实探测结果，判断 provider 应该用哪个上游协议。
export function classifyWizardDualProtocolConnectivityResult(args: {
  provider: Provider;
  model: string;
  responses: WizardProtocolProbe;
  chat: WizardProtocolProbe;
}): WizardConnectivityResult {
  const base = {
    providerId: args.provider.id,
    providerName: args.provider.name,
    model: args.model,
    url: args.responses.url ?? args.chat.url,
    httpStatus: args.responses.httpStatus ?? args.chat.httpStatus,
  };
  if (args.responses.ok && args.chat.ok) {
    return {
      ...base,
      status: "pass",
      canContinue: true,
      recommendedApiFormat: "openai_responses",
      detail:
        "Responses 和 Chat Completions 的基础请求都可用；这只能证明协议入口、鉴权和模型名可用，Codex 原生工具链仍优先使用 Responses。",
    };
  }
  if (args.responses.ok) {
    return {
      ...base,
      status: "pass",
      canContinue: true,
      recommendedApiFormat: "openai_responses",
      detail: `Responses 基础请求可用，Chat Completions 不通；将使用 Responses。该结果不等于完整 Codex 功能验证，Chat 返回：${args.chat.detail}`,
    };
  }
  if (args.chat.ok) {
    return {
      ...base,
      status: "warn",
      canContinue: true,
      recommendedApiFormat: "openai_chat",
      detail: `Responses 不通但 Chat Completions 可用；将保留 Chat 转换路径。Responses 返回：${args.responses.detail}`,
    };
  }
  return {
    ...base,
    status: "fail",
    canContinue: false,
    detail: `Responses 和 Chat Completions 都不通，更可能是 API Key、Base URL、模型权限、额度、网络或上游可用性问题。Responses 返回：${args.responses.detail}；Chat 返回：${args.chat.detail}`,
  };
}

// 没有可探测配置时生成跳过结果；有模型目录则可继续但有风险，没有目录则阻塞。
export function skippedWizardConnectivityResult(
  provider: Provider,
  reason: string,
): WizardConnectivityResult {
  const hasCatalog = hasWizardModelCatalog(provider);
  return {
    providerId: provider.id,
    providerName: provider.name,
    model: "*",
    status: hasCatalog ? "skipped" : "fail",
    canContinue: hasCatalog,
    detail: hasCatalog
      ? `${reason}；已有 modelCatalog，允许继续但未验证真实响应。`
      : `${reason}；且没有 modelCatalog，不能确认路由可用。`,
  };
}

// 聚合连通性结果：只要存在阻塞项，状态机就不应自动进入保存发布。
export function canContinueAfterConnectivity(
  results: WizardConnectivityResult[],
): boolean {
  return results.length > 0 && results.every((result) => result.canContinue);
}

// 将显式 Chat / Responses 双协议探测结果反写到向导草稿；实测结果优先于旧的 openai_chat 元数据。
export function applyWizardConnectivityApiFormatOverrides(
  providers: Provider[],
  results: WizardConnectivityResult[],
): Provider[] {
  if (results.length === 0) return providers;
  const resultsByProvider = new Map<string, WizardConnectivityResult[]>();
  for (const result of results) {
    const bucket = resultsByProvider.get(result.providerId) ?? [];
    bucket.push(result);
    resultsByProvider.set(result.providerId, bucket);
  }

  return providers.map((provider) => {
    const providerResults = resultsByProvider.get(provider.id) ?? [];
    const recommendedFormats = providerResults
      .map((result) => result.recommendedApiFormat)
      .filter((format): format is CodexApiFormat => Boolean(format));
    const hasResponsesRecommendation =
      recommendedFormats.includes("openai_responses");
    const hasChatRecommendation = recommendedFormats.includes("openai_chat");
    const hasResponsesPass = providerResults.some(
      (result) =>
        result.status === "pass" ||
        result.recommendedApiFormat === "openai_responses",
    );
    const hasBlockingFailure = providerResults.some(
      (result) => result.status === "fail",
    );
    if (hasBlockingFailure) return provider;
    if (hasChatRecommendation && !hasResponsesRecommendation) {
      return {
        ...provider,
        meta: {
          ...(provider.meta ?? {}),
          apiFormat: "openai_chat",
        },
        settingsConfig: {
          ...(provider.settingsConfig ?? {}),
          apiFormat: "openai_chat",
        },
      };
    }
    if (!hasResponsesPass) return provider;
    return {
      ...provider,
      meta: {
        ...(provider.meta ?? {}),
        apiFormat: "openai_responses",
      },
      settingsConfig: {
        ...(provider.settingsConfig ?? {}),
        apiFormat: "openai_responses",
      },
    };
  });
}

// 为模型源生成 provider 分组 route；只引用 targetProviderId，不复制第三方 bearer 密钥。
export function buildWizardRoutesFromSources(
  providers: Provider[],
): CodexRoutingRoute[] {
  return providers.map((provider) => {
    const models = readWizardModelCatalog(provider).map((model) => model.model);
    return {
      id: `router-${provider.id}`,
      label: provider.name,
      enabled: true,
      targetProviderId: provider.id,
      match: {
        models,
        prefixes: inferWizardRoutePrefixes(provider),
      },
      upstream: {
        apiFormat: inferWizardApiFormat(provider),
        auth: { source: "provider_config" },
      },
      capabilities: {
        codexCache: inferWizardCacheConfig(provider),
      },
    };
  });
}

// 从已处理重名的模型源生成 MultiRouter catalog；保留 upstreamModel 供运行时把别名映射回真实模型。
export function buildWizardModelCatalog(
  providers: Provider[],
): CodexModelCatalogConfig {
  const byModel = new Map<string, CodexCatalogModel>();
  for (const provider of providers) {
    for (const model of readWizardModelCatalog(provider)) {
      if (!byModel.has(model.model)) {
        byModel.set(model.model, model);
      }
    }
  }
  const models = Array.from(byModel.values());
  return {
    models,
    spawnAgentModels: models.map((model) => model.model).slice(0, 5),
  };
}

// 过滤出向导默认可用的普通 Codex provider；空目录 provider 仍保留，便于引导用户先刷新模型。
export function defaultWizardModelSources(providers: Provider[]): Provider[] {
  return providers.filter((provider) => !isCodexMultiRouterPlan(provider));
}

// 创建或更新 MultiRouter provider；草稿只在用户点击保存发布时写入数据库。
export function buildCodexMultiRouterWizardPlan(
  allProviders: Provider[],
  sourceProviders: Provider[],
  existingPlan?: Provider | null,
): WizardPlanBuildResult {
  const resolvedSources = resolveWizardModelNameCollisions(sourceProviders);
  const routes = buildWizardRoutesFromSources(resolvedSources);
  const routing: CodexRoutingConfig = {
    enabled: true,
    defaultRouteId: routes[0]?.id,
    routes,
  };
  const existingIds = new Set(allProviders.map((provider) => provider.id));
  const planId =
    existingPlan?.id ??
    (existingIds.has(CODEX_MULTI_ROUTER_DEFAULT_ID)
      ? `${CODEX_MULTI_ROUTER_DEFAULT_ID}-${Date.now()}`
      : CODEX_MULTI_ROUTER_DEFAULT_ID);
  const plan: Provider = {
    ...(existingPlan ?? {
      id: planId,
      name: CODEX_MULTI_ROUTER_DEFAULT_NAME,
      category: "custom",
      createdAt: Date.now(),
    }),
    id: planId,
    name: existingPlan?.name ?? CODEX_MULTI_ROUTER_DEFAULT_NAME,
    category: existingPlan?.category ?? "custom",
    settingsConfig: {
      ...(existingPlan?.settingsConfig ?? {}),
      auth: existingPlan?.settingsConfig?.auth ?? {},
      base_url: CODEX_MULTI_ROUTER_PROXY_BASE_URL,
      baseUrl: CODEX_MULTI_ROUTER_PROXY_BASE_URL,
      config: existingPlan?.settingsConfig?.config ?? null,
      modelCatalog: buildWizardModelCatalog(resolvedSources),
      codexRouting: routing,
    },
  };
  return { plan, sourceProviders: resolvedSources };
}
