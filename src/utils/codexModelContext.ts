import { codexProviderPresets } from "@/config/codexProviderPresets";

export interface CodexContextInferenceSource {
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  websiteUrl?: string;
  existingModels?: ExistingModelLike[];
}

interface FetchedModelLike {
  id: string;
  contextWindow?: number | null;
}

interface ExistingModelLike {
  model?: string;
  contextWindow?: string | number;
  context_window?: string | number;
}

const DEEPSEEK_ALIAS_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-chat": 1000000,
  "deepseek-reasoner": 1000000,
};

// 解析 UI/配置里可能出现的上下文窗口，允许保留旧数据中的 "128000 tokens" 形态。
function parsePositiveContextWindow(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/\d+/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// 判断当前 provider 是否明显属于某个预设，避免同名模型跨供应商时误套上下文。
function providerMatchesPreset(
  presetName: string,
  presetWebsiteUrl: string,
  source: CodexContextInferenceSource,
): boolean {
  const signals = [
    source.providerId,
    source.providerName,
    source.baseUrl,
    source.websiteUrl,
  ]
    .map((value) => value?.toLowerCase() ?? "")
    .filter(Boolean);
  if (signals.length === 0) return false;

  const presetNameSignal = presetName.toLowerCase();
  const presetHostSignal = presetWebsiteUrl
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  return signals.some(
    (signal) =>
      signal.includes(presetNameSignal) ||
      (presetHostSignal && signal.includes(presetHostSignal)),
  );
}

// 优先从当前 provider 已有目录读取，避免获取模型列表时覆盖用户手工修正过的上下文。
function existingCatalogContextWindow(
  modelId: string,
  existingModels: ExistingModelLike[] = [],
): number | undefined {
  const normalizedModel = modelId.trim();
  if (!normalizedModel) return undefined;
  const existing = existingModels.find(
    (model) => (model.model ?? "").trim() === normalizedModel,
  );
  return parsePositiveContextWindow(
    existing?.contextWindow ?? existing?.context_window,
  );
}

// 从本地 Codex provider 预设推断已知模型上下文；远端 /models 经常只返回 id。
export function inferCodexModelContextWindow(
  modelId: string,
  source: CodexContextInferenceSource = {},
): number | undefined {
  const normalizedModel = modelId.trim();
  if (!normalizedModel) return undefined;

  const lowerModel = normalizedModel.toLowerCase();
  for (const preset of codexProviderPresets) {
    const matchedPreset = providerMatchesPreset(
      preset.name,
      preset.websiteUrl,
      source,
    );
    const presetModel = preset.modelCatalog?.find(
      (model) => model.model.trim() === normalizedModel,
    );
    if (matchedPreset) {
      const parsed = parsePositiveContextWindow(presetModel?.contextWindow);
      if (parsed) return parsed;
    }
  }

  const deepseekAliasContext = DEEPSEEK_ALIAS_CONTEXT_WINDOWS[lowerModel];
  if (deepseekAliasContext) {
    return deepseekAliasContext;
  }

  for (const preset of codexProviderPresets) {
    const presetModel = preset.modelCatalog?.find(
      (model) => model.model.trim() === normalizedModel,
    );
    const parsed = parsePositiveContextWindow(presetModel?.contextWindow);
    if (parsed) return parsed;
  }

  return undefined;
}

// 合并 /models 结果时的统一优先级：远端显式值 > 用户已有值 > 本地已知 provider/model 元数据。
export function resolveFetchedCodexModelContextWindow(
  fetched: FetchedModelLike,
  source: CodexContextInferenceSource = {},
): number | undefined {
  return (
    parsePositiveContextWindow(fetched.contextWindow) ??
    existingCatalogContextWindow(fetched.id, source.existingModels) ??
    inferCodexModelContextWindow(fetched.id, source)
  );
}
