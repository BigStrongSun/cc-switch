import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  buildModelCatalogForRoutes,
  createDraftRoutingPlan,
  isRoutingPlan,
  normalizeCodexRouteForSave,
  readCodexRouting,
} from "./CodexRouterWorkspacePage";

describe("Codex MultiRouter workspace route persistence helpers", () => {
  it("creates a real routing plan instead of a plain model source", () => {
    const openai: Provider = {
      id: "codex-openai",
      name: "OpenAI",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.4-mini", displayName: "GPT 5.4 Mini" }],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "qwen3.6", displayName: "Qwen 3.6" }],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };

    const plan = createDraftRoutingPlan([openai, qwen], [openai, qwen]);

    expect(plan.id).toBe("codex-multirouter");
    expect(isRoutingPlan(plan)).toBe(true);
    expect(readCodexRouting(plan)?.enabled).toBe(true);
    expect(readCodexRouting(plan)?.routes).toEqual([]);
    expect(plan.settingsConfig.modelCatalog.models).toEqual([
      { model: "gpt-5.4-mini" },
      { model: "qwen3.6" },
    ]);
  });

  it("normalizes selected router candidates into visible routes and catalog models", () => {
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "qwen3.6", displayName: "Qwen 3.6" }],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const deepseek: Provider = {
      id: "codex-deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash" }],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan([qwen, deepseek], [qwen, deepseek]);
    const usedRouteIds = new Set<string>();
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: "Qwen Local",
          targetProviderId: qwen.id,
          match: { models: ["qwen3.6"], prefixes: ["qwen"] },
          upstream: { apiFormat: "openai_chat" },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          label: "DeepSeek",
          targetProviderId: deepseek.id,
          match: { models: ["deepseek-v4-flash"], prefixes: ["deepseek"] },
          upstream: { apiFormat: "openai_chat" },
        },
        1,
        usedRouteIds,
      ),
    ];
    const savedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: buildModelCatalogForRoutes(
          plan,
          routes,
          new Map([
            [qwen.id, qwen],
            [deepseek.id, deepseek],
          ]),
        ),
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };

    expect(isRoutingPlan(savedPlan)).toBe(true);
    expect(readCodexRouting(savedPlan)?.routes).toHaveLength(2);
    expect(
      (readCodexRouting(savedPlan)?.routes ?? []).map((route) => route.id),
    ).toEqual(["codex-qwen", "codex-deepseek"]);
    expect(savedPlan.settingsConfig.modelCatalog.models).toEqual([
      { model: "qwen3.6" },
      { model: "deepseek-v4-flash" },
    ]);
    expect(savedPlan.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "qwen3.6",
      "deepseek-v4-flash",
    ]);
  });

  it("seeds OpenAI/Codex providers without a model catalog with fallback models", () => {
    const officialBackup: Provider = {
      id: "codex-official-backup",
      name: "OpenAI Official Backup",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };

    const plan = createDraftRoutingPlan([officialBackup], [officialBackup]);

    expect(plan.settingsConfig.modelCatalog.models).toEqual([
      { model: "gpt-5.5" },
      { model: "gpt-5.4" },
      { model: "gpt-5.4-mini" },
      { model: "gpt-5.3-codex-spark" },
    ]);
    expect(plan.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });
});
