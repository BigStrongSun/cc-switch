import type {
  CodexCatalogModel,
  CodexModelCatalogConfig,
  CodexRoutingConfig,
  CodexRoutingRoute,
  Provider,
} from "@/types";
import { isCodexMultiRouterPlan } from "@/lib/codexMultiRouterWizard";
import { readCodexModelCatalog } from "@/utils/codexSpawnAgentCandidates";

// MultiRouter 同步返回写回后的 plan，以及需要用户人工补选的子 Agent 候选删减。
export interface CodexMultiRouterPlanSyncResult {
  plan: Provider;
  removedSpawnAgentModels: string[];
}

// 读取 route 的目标 provider id；兼容旧草稿里可能残留在 upstream/provider 字段的写法。
function routeTargetProviderId(route: CodexRoutingRoute): string | undefined {
  const upstream = route.upstream as
    | (CodexRoutingRoute["upstream"] & {
        targetProviderId?: string;
        target_provider_id?: string;
        providerId?: string;
        provider_id?: string;
        upstreamProviderId?: string;
        upstream_provider_id?: string;
        provider?: string;
      })
    | undefined;
  return (
    route.targetProviderId ??
    upstream?.targetProviderId ??
    upstream?.target_provider_id ??
    upstream?.providerId ??
    upstream?.provider_id ??
    upstream?.upstreamProviderId ??
    upstream?.upstream_provider_id ??
    upstream?.provider
  );
}

// 读取模型真实上游名；MultiRouter 可见模型可能是为解决重名而生成的别名。
function catalogModelUpstreamId(model: CodexCatalogModel): string {
  return (model.upstreamModel ?? model.upstream_model ?? model.model).trim();
}

// 将 UI 读取到的宽松 catalog 规整成保存配置使用的严格模型条目。
function readStrictProviderCatalogModels(
  provider: Provider,
): CodexCatalogModel[] {
  return readCodexModelCatalog(provider)
    .models.map((model) => {
      const id = model.model?.trim();
      if (!id) return null;
      return {
        model: id,
        ...(model.upstreamModel ? { upstreamModel: model.upstreamModel } : {}),
        ...(model.upstream_model
          ? { upstream_model: model.upstream_model }
          : {}),
        ...(model.displayName ? { displayName: model.displayName } : {}),
        ...(model.contextWindow !== undefined
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(model.context_window !== undefined
          ? { context_window: model.context_window }
          : {}),
        ...(model.inputModalities
          ? {
              inputModalities: model.inputModalities as Array<"text" | "image">,
            }
          : {}),
        ...(model.input_modalities
          ? {
              input_modalities: model.input_modalities as Array<
                "text" | "image"
              >,
            }
          : {}),
        ...(model.textOnly !== undefined ? { textOnly: model.textOnly } : {}),
        ...(model.text_only !== undefined
          ? { text_only: model.text_only }
          : {}),
        ...(model.supportsImage !== undefined
          ? { supportsImage: model.supportsImage }
          : {}),
        ...(model.supports_image !== undefined
          ? { supports_image: model.supports_image }
          : {}),
        ...(model.vision !== undefined ? { vision: model.vision } : {}),
      } satisfies CodexCatalogModel;
    })
    .filter((model): model is CodexCatalogModel => Boolean(model));
}

// 从 provider 当前保留目录生成 route 的模型别名映射；没有别名时删除旧映射，避免过期转发。
function buildRouteModelMap(
  models: CodexCatalogModel[],
): Record<string, string> | undefined {
  const entries = models
    .map((model) => {
      const visible = model.model?.trim();
      const upstream = catalogModelUpstreamId(model);
      return visible && upstream && visible !== upstream
        ? [visible, upstream]
        : null;
    })
    .filter((entry): entry is [string, string] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// 建立 plan 当前 catalog 的可见模型索引，便于同步时保留用户看到的别名和展示名。
function buildPlanCatalogByModel(
  plan: Provider,
): Map<string, CodexCatalogModel> {
  const models = plan.settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(models)) return new Map();
  return new Map(
    models
      .filter((model) => typeof model.model === "string" && model.model.trim())
      .map((model) => [model.model, model]),
  );
}

// 从 route 当前 match/modelMap/catalog 中反查“真实上游模型 -> 可见模型名”，用于保留已有别名。
function buildVisibleModelByUpstream(
  route: CodexRoutingRoute,
  planCatalogByModel: Map<string, CodexCatalogModel>,
): Map<string, string> {
  const visibleByUpstream = new Map<string, string>();
  for (const visibleModel of route.match.models ?? []) {
    const catalogModel = planCatalogByModel.get(visibleModel);
    const upstream =
      route.upstream.modelMap?.[visibleModel] ??
      catalogModel?.upstreamModel ??
      catalogModel?.upstream_model ??
      visibleModel;
    if (!visibleByUpstream.has(upstream)) {
      visibleByUpstream.set(upstream, visibleModel);
    }
  }
  return visibleByUpstream;
}

// 根据目标 provider 的最新目录生成 route 可见模型；已有别名优先保留，模型能力字段从最新目录继承。
function buildSyncedRouteModels(
  plan: Provider,
  route: CodexRoutingRoute,
  targetModels: CodexCatalogModel[],
): CodexCatalogModel[] {
  const planCatalogByModel = buildPlanCatalogByModel(plan);
  const visibleByUpstream = buildVisibleModelByUpstream(
    route,
    planCatalogByModel,
  );
  return targetModels
    .map((sourceModel) => {
      const upstream = catalogModelUpstreamId(sourceModel);
      const visible = visibleByUpstream.get(upstream) ?? sourceModel.model;
      const existingVisibleModel = planCatalogByModel.get(visible);
      const displayName =
        existingVisibleModel?.displayName ??
        sourceModel.displayName ??
        (visible !== sourceModel.model ? visible : undefined);
      return {
        ...sourceModel,
        model: visible,
        upstreamModel: upstream,
        ...(displayName ? { displayName } : {}),
      };
    })
    .filter((model) => model.model.trim());
}

// route 能力是 MultiRouter 规则侧的覆盖项，重建 catalog 时继续投影到对应模型上。
function applyRouteCapabilities(
  model: CodexCatalogModel,
  route: CodexRoutingRoute,
): CodexCatalogModel {
  if (!route.capabilities) return model;
  return {
    ...model,
    inputModalities:
      route.capabilities.inputModalities ?? model.inputModalities,
    textOnly: route.capabilities.textOnly ?? model.textOnly,
  };
}

// 子 Agent 候选只保留仍在最新聚合 catalog 中的旧选择；被删除的候选交给 UI 提醒用户人工处理。
function pruneSpawnAgentModels(
  existingSpawnAgentModels: string[],
  models: CodexCatalogModel[],
): { spawnAgentModels: string[]; removedSpawnAgentModels: string[] } {
  const availableModels = new Set(models.map((model) => model.model));
  const spawnAgentModels = existingSpawnAgentModels.filter((model) =>
    availableModels.has(model),
  );
  return {
    spawnAgentModels,
    removedSpawnAgentModels: existingSpawnAgentModels.filter(
      (model) => !availableModels.has(model),
    ),
  };
}

// 按当前 routes 和 provider SSOT 重建 MultiRouter 聚合模型目录，并清理不可用的子 Agent 候选。
function rebuildPlanModelCatalog(
  plan: Provider,
  routes: CodexRoutingRoute[],
  providersById: Map<string, Provider>,
): {
  modelCatalog: CodexModelCatalogConfig;
  removedSpawnAgentModels: string[];
} {
  const byModel = new Map<string, CodexCatalogModel>();
  for (const route of routes) {
    const targetId = routeTargetProviderId(route);
    const targetProvider = targetId ? providersById.get(targetId) : undefined;
    const targetModels = targetProvider
      ? readStrictProviderCatalogModels(targetProvider)
      : [];
    const sourceModels =
      targetModels.length > 0
        ? buildSyncedRouteModels(plan, route, targetModels)
        : (route.match.models ?? []).map((model) => ({
            model,
            upstreamModel: route.upstream.modelMap?.[model] ?? model,
          }));
    for (const sourceModel of sourceModels) {
      const id = sourceModel.model?.trim();
      if (!id || byModel.has(id)) continue;
      byModel.set(id, applyRouteCapabilities({ ...sourceModel }, route));
    }
  }

  const models = Array.from(byModel.values());
  const existingSpawnAgentModels = Array.isArray(
    plan.settingsConfig?.modelCatalog?.spawnAgentModels,
  )
    ? plan.settingsConfig.modelCatalog.spawnAgentModels
    : [];
  const { spawnAgentModels, removedSpawnAgentModels } = pruneSpawnAgentModels(
    existingSpawnAgentModels,
    models,
  );
  return {
    modelCatalog: {
      models,
      spawnAgentModels,
    },
    removedSpawnAgentModels,
  };
}

// 用最新 provider modelCatalog 重算单个 MultiRouter plan；返回 null 表示没有实际变化。
export function syncCodexMultiRouterPlanWithProviders(
  plan: Provider,
  providersById: Map<string, Provider>,
): CodexMultiRouterPlanSyncResult | null {
  const routing = plan.settingsConfig?.codexRouting as
    | CodexRoutingConfig
    | undefined;
  const routes = routing?.routes ?? [];
  if (!isCodexMultiRouterPlan(plan) || routes.length === 0) return null;

  let changed = false;
  const nextRoutes = routes.map((route) => {
    const targetId = routeTargetProviderId(route);
    const targetProvider = targetId ? providersById.get(targetId) : undefined;
    if (!targetProvider) return route;

    const targetModels = readStrictProviderCatalogModels(targetProvider);
    const nextRouteModels = buildSyncedRouteModels(plan, route, targetModels);
    const nextModelIds = nextRouteModels
      .map((model) => model.model?.trim())
      .filter((model): model is string => Boolean(model));
    const previousModelIds = route.match.models ?? [];
    const nextModelMap = buildRouteModelMap(nextRouteModels);
    const previousModelMap = route.upstream.modelMap;
    const routeChanged =
      previousModelIds.join("\n") !== nextModelIds.join("\n") ||
      JSON.stringify(previousModelMap ?? null) !==
        JSON.stringify(nextModelMap ?? null);
    if (!routeChanged) return route;

    changed = true;
    const { modelMap: _modelMap, ...upstreamWithoutModelMap } = route.upstream;
    return {
      ...route,
      targetProviderId: targetId,
      match: {
        ...route.match,
        models: nextModelIds,
      },
      upstream: {
        ...upstreamWithoutModelMap,
        ...(nextModelMap ? { modelMap: nextModelMap } : {}),
      },
    };
  });

  const { modelCatalog: nextModelCatalog, removedSpawnAgentModels } =
    rebuildPlanModelCatalog(plan, nextRoutes, providersById);
  const catalogChanged =
    JSON.stringify(plan.settingsConfig?.modelCatalog ?? null) !==
    JSON.stringify(nextModelCatalog);

  if (!changed && !catalogChanged) return null;

  return {
    plan: {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          ...routing,
          routes: nextRoutes,
        },
        modelCatalog: nextModelCatalog,
      },
    },
    removedSpawnAgentModels,
  };
}

// provider 保存后同步所有引用它的 MultiRouter；重命名 provider id 时同时更新 route 目标。
export function syncCodexMultiRouterPlansAfterProviderChange(
  providers: Provider[],
  changedProvider: Provider,
  originalProviderId?: string,
): CodexMultiRouterPlanSyncResult[] {
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  if (originalProviderId && originalProviderId !== changedProvider.id) {
    providersById.delete(originalProviderId);
    providersById.set(changedProvider.id, changedProvider);
  }

  return providers
    .filter((provider) => provider.id !== changedProvider.id)
    .filter(isCodexMultiRouterPlan)
    .map((plan) => {
      if (!originalProviderId || originalProviderId === changedProvider.id) {
        return syncCodexMultiRouterPlanWithProviders(plan, providersById);
      }
      const routing = plan.settingsConfig?.codexRouting as
        | CodexRoutingConfig
        | undefined;
      const routes = routing?.routes ?? [];
      let routeIdChanged = false;
      const rewiredRoutes = routes.map((route) => {
        if (routeTargetProviderId(route) !== originalProviderId) return route;
        routeIdChanged = true;
        return { ...route, targetProviderId: changedProvider.id };
      });
      const rewiredPlan = routeIdChanged
        ? {
            ...plan,
            settingsConfig: {
              ...plan.settingsConfig,
              codexRouting: { ...routing, routes: rewiredRoutes },
            },
          }
        : plan;
      return syncCodexMultiRouterPlanWithProviders(rewiredPlan, providersById);
    })
    .filter((result): result is CodexMultiRouterPlanSyncResult =>
      Boolean(result),
    );
}
