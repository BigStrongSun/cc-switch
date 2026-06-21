import type { Provider } from "@/types";

export interface CodexCatalogModel {
  model?: string;
  displayName?: string;
  display_name?: string;
}

export interface CodexModelCatalog {
  models: CodexCatalogModel[];
  spawnAgentModels: string[];
}

export interface SpawnAgentCandidateValidation {
  visibleModels: string[];
  missingSelectedModels: string[];
  missingPriorityModels: string[];
  tooManySelected: boolean;
}

export const CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT = 5;
export const CODEX_SPAWN_AGENT_PRIORITY_MODELS = [
  "qwen3.6",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
];

// 读取 MultiRouter provider 私有配置中的模型目录和 spawn_agent 候选顺序。
export function readCodexModelCatalog(
  provider: Pick<Provider, "settingsConfig"> | null,
): CodexModelCatalog {
  const catalog = provider?.settingsConfig?.modelCatalog;
  if (!catalog || typeof catalog !== "object") {
    return { models: [], spawnAgentModels: [] };
  }

  const catalogObject = catalog as Record<string, unknown>;
  const rawModels: unknown[] = Array.isArray(catalogObject.models)
    ? catalogObject.models
    : [];
  const models = rawModels
    .filter(
      (item: unknown): item is CodexCatalogModel =>
        !!item && typeof item === "object",
    )
    .filter((item) => typeof item.model === "string" && item.model.trim());
  const rawSpawnAgentModels: unknown[] = Array.isArray(
    catalogObject.spawnAgentModels,
  )
    ? catalogObject.spawnAgentModels
    : Array.isArray(catalogObject.spawn_agent_models)
      ? catalogObject.spawn_agent_models
      : [];
  const spawnAgentModels = rawSpawnAgentModels
    .filter((item: unknown): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT);

  return { models, spawnAgentModels };
}

// 展示模型名称时优先使用 catalog 的 displayName，保留 slug 方便用户复制。
export function catalogModelLabel(model: CodexCatalogModel): string {
  const id = model.model?.trim() ?? "";
  const displayName = model.displayName ?? model.display_name;
  return displayName?.trim() ? `${displayName.trim()} (${id})` : id;
}

// 将用户选择规整到当前 catalog 中真实存在的前五个模型。
export function normalizeSpawnAgentCandidateSelection(
  selectedModels: string[],
  catalogModels: CodexCatalogModel[],
  limit = CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
): string[] {
  const available = new Set(
    catalogModels
      .map((model) => model.model?.trim())
      .filter((model): model is string => Boolean(model)),
  );
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of selectedModels) {
    const model = item.trim();
    if (!model || seen.has(model) || !available.has(model)) continue;
    seen.add(model);
    normalized.push(model);
    if (normalized.length >= limit) break;
  }

  return normalized;
}

// 拖动排序后的新顺序，同样保持在五个可见候选窗口内。
export function reorderSpawnAgentCandidates(
  selectedModels: string[],
  activeModel: string,
  overModel: string,
  limit = CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
): string[] {
  const activeIndex = selectedModels.indexOf(activeModel);
  const overIndex = selectedModels.indexOf(overModel);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return selectedModels.slice(0, limit);
  }

  const next = [...selectedModels];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next.slice(0, limit);
}

// 校验当前候选窗口是否覆盖用户选择和重点跨 provider 模型。
export function validateSpawnAgentCandidates(
  catalog: CodexModelCatalog,
  visibleModels: string[],
  priorityModels: string[] = [],
  limit = CODEX_SPAWN_AGENT_VISIBLE_MODEL_LIMIT,
): SpawnAgentCandidateValidation {
  const catalogModels = new Set(
    catalog.models
      .map((model) => model.model?.trim())
      .filter((model): model is string => Boolean(model)),
  );
  const visible = visibleModels.slice(0, limit).filter(Boolean);
  const visibleSet = new Set(visible);

  return {
    visibleModels: visible,
    missingSelectedModels: catalog.spawnAgentModels.filter(
      (model) => catalogModels.has(model) && !visibleSet.has(model),
    ),
    missingPriorityModels: priorityModels.filter(
      (model) => catalogModels.has(model) && !visibleSet.has(model),
    ),
    tooManySelected: catalog.spawnAgentModels.length > limit,
  };
}
