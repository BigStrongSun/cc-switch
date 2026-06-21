import { describe, expect, it } from "vitest";
import {
  normalizeSpawnAgentCandidateSelection,
  readCodexModelCatalog,
  reorderSpawnAgentCandidates,
  validateSpawnAgentCandidates,
  type CodexCatalogModel,
} from "@/utils/codexSpawnAgentCandidates";
import type { Provider } from "@/types";

const catalogModels: CodexCatalogModel[] = [
  { model: "gpt-5.4" },
  { model: "gpt-5.4-mini" },
  { model: "qwen3.6" },
  { model: "deepseek-v4-flash" },
  { model: "deepseek-v4-pro" },
  { model: "gpt-5.5" },
];

/// 构造只包含本测试关心字段的 Provider，避免测试依赖真实数据库或 Tauri 命令。
function providerWithModelCatalog(modelCatalog: unknown): Provider {
  return {
    id: "codex_model_router_v2",
    name: "Codex MultiRouter",
    settingsConfig: { modelCatalog },
  };
}

describe("codexSpawnAgentCandidates", () => {
  it("读取 camelCase 子 Agent 候选并限制为前五个", () => {
    const provider = providerWithModelCatalog({
      models: catalogModels,
      spawnAgentModels: [
        "qwen3.6",
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.5",
      ],
    });

    const catalog = readCodexModelCatalog(provider);

    expect(catalog.models).toHaveLength(6);
    expect(catalog.spawnAgentModels).toEqual([
      "qwen3.6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  it("兼容 snake_case 子 Agent 候选字段", () => {
    const provider = providerWithModelCatalog({
      models: catalogModels,
      spawn_agent_models: ["deepseek-v4-flash", "qwen3.6"],
    });

    expect(readCodexModelCatalog(provider).spawnAgentModels).toEqual([
      "deepseek-v4-flash",
      "qwen3.6",
    ]);
  });

  it("规整选择时去掉未知模型和重复模型", () => {
    expect(
      normalizeSpawnAgentCandidateSelection(
        ["qwen3.6", "missing-model", "qwen3.6", "deepseek-v4-flash"],
        catalogModels,
      ),
    ).toEqual(["qwen3.6", "deepseek-v4-flash"]);
  });

  it("拖拽排序后仍保持在可见数量上限内", () => {
    expect(
      reorderSpawnAgentCandidates(
        [
          "qwen3.6",
          "deepseek-v4-flash",
          "deepseek-v4-pro",
          "gpt-5.4",
          "gpt-5.4-mini",
        ],
        "deepseek-v4-pro",
        "qwen3.6",
      ),
    ).toEqual([
      "deepseek-v4-pro",
      "qwen3.6",
      "deepseek-v4-flash",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
  });

  it("默认只校验用户已选候选，不强制未选择的重点模型进入前五", () => {
    const result = validateSpawnAgentCandidates(
      {
        models: catalogModels,
        spawnAgentModels: ["qwen3.6", "deepseek-v4-flash"],
      },
      ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
    );

    expect(result.missingSelectedModels).toEqual([
      "qwen3.6",
      "deepseek-v4-flash",
    ]);
    expect(result.missingPriorityModels).toEqual([]);
  });

  it("显式传入重点模型时仍可计算推荐模型缺口", () => {
    const result = validateSpawnAgentCandidates(
      {
        models: catalogModels,
        spawnAgentModels: ["qwen3.6", "deepseek-v4-flash"],
      },
      ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
      ["qwen3.6", "deepseek-v4-flash", "deepseek-v4-pro"],
    );

    expect(result.missingPriorityModels).toEqual([
      "qwen3.6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });
});
