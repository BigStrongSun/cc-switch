import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  applyMultiRouterSettingsDraft,
  buildMultiRouterRuntimeStatus,
  buildCodexProxyBaseUrl,
  buildModelCatalogForRoutes,
  createDraftRoutingPlan,
  isRoutingPlan,
  mergeRoutePickerDraftIds,
  normalizeCodexRouteForSave,
  readCodexRouting,
  validateProxyListenDraft,
} from "./CodexRouterWorkspacePage";

describe("Codex MultiRouter workspace route persistence helpers", () => {
  it("creates a real routing plan instead of a plain model source", () => {
    const openai: Provider = {
      id: "codex-openai",
      name: "OpenAI",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.4-mini",
              displayName: "GPT 5.4 Mini",
              contextWindow: 128000,
            },
          ],
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
          models: [
            {
              model: "qwen3.6",
              displayName: "Qwen 3.6",
              contextWindow: 262144,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };

    const plan = createDraftRoutingPlan([openai, qwen], [openai, qwen]);

    expect(plan.id).toBe("codex-multirouter");
    expect(isRoutingPlan(plan)).toBe(true);
    expect(plan.settingsConfig.base_url).toBe("http://127.0.0.1:15721/v1");
    expect(plan.settingsConfig.baseUrl).toBe("http://127.0.0.1:15721/v1");
    expect(readCodexRouting(plan)?.enabled).toBe(true);
    expect(readCodexRouting(plan)?.routes).toEqual([]);
    expect(plan.settingsConfig.modelCatalog.models).toEqual([
      {
        model: "gpt-5.4-mini",
        displayName: "GPT 5.4 Mini",
        contextWindow: 128000,
      },
      { model: "qwen3.6", displayName: "Qwen 3.6", contextWindow: 262144 },
    ]);
  });

  it("normalizes selected router candidates into visible routes and catalog models", () => {
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "qwen3.6",
              displayName: "Qwen 3.6",
              contextWindow: 262144,
            },
          ],
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
          models: [{ model: "deepseek-v4-flash", contextWindow: 1000000 }],
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
      { model: "qwen3.6", displayName: "Qwen 3.6", contextWindow: 262144 },
      { model: "deepseek-v4-flash", contextWindow: 1000000 },
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

  it("keeps unsaved route picker enabled draft state across candidate refreshes", () => {
    const currentEnabledIds = new Set(["openai-route"]);

    expect(
      Array.from(
        mergeRoutePickerDraftIds(
          currentEnabledIds,
          ["openai-route", "qwen-route"],
          ["openai-route", "qwen-route"],
          ["qwen-route"],
        ),
      ),
    ).toEqual(["openai-route"]);
  });

  it("applies route picker defaults only to newly discovered candidates", () => {
    const currentEnabledIds = new Set(["openai-route"]);

    expect(
      Array.from(
        mergeRoutePickerDraftIds(
          currentEnabledIds,
          ["openai-route", "qwen-route"],
          ["openai-route", "qwen-route", "deepseek-route"],
          ["qwen-route", "deepseek-route"],
        ),
      ),
    ).toEqual(["openai-route", "deepseek-route"]);
  });

  it("updates multirouter settings without dropping routes or model catalog", () => {
    const qwen: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([qwen], [qwen]);
    const savedPlan: Provider = {
      ...plan,
      name: "Old MultiRouter",
      notes: "old notes",
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: {
          models: [{ model: "qwen3.6" }],
          spawnAgentModels: ["qwen3.6"],
        },
        codexRouting: {
          enabled: true,
          defaultRouteId: "codex-qwen",
          routes: [
            {
              id: "codex-qwen",
              label: "Qwen Local",
              enabled: true,
              targetProviderId: qwen.id,
              match: { models: ["qwen3.6"] },
            },
          ],
        },
      },
    };

    const updated = applyMultiRouterSettingsDraft(savedPlan, {
      name: "Daily MultiRouter",
      notes: "primary plan",
      enabled: false,
      defaultRouteId: "missing-route",
    });

    expect(updated.name).toBe("Daily MultiRouter");
    expect(updated.notes).toBe("primary plan");
    expect(updated.settingsConfig.base_url).toBe("http://127.0.0.1:15721/v1");
    expect(updated.settingsConfig.baseUrl).toBe("http://127.0.0.1:15721/v1");
    expect(updated.settingsConfig.modelCatalog).toEqual(
      savedPlan.settingsConfig.modelCatalog,
    );
    expect(readCodexRouting(updated)?.enabled).toBe(false);
    expect(readCodexRouting(updated)?.routes).toEqual(
      readCodexRouting(savedPlan)?.routes,
    );
    expect(readCodexRouting(updated)?.defaultRouteId).toBeUndefined();
  });

  it("normalizes listener config into a usable Codex proxy base url", () => {
    expect(buildCodexProxyBaseUrl("0.0.0.0", 15721)).toBe(
      "http://127.0.0.1:15721/v1",
    );
    expect(buildCodexProxyBaseUrl("::", 15721)).toBe("http://[::1]:15721/v1");

    expect(validateProxyListenDraft("127.0.0.1", "15721")).toEqual({
      ok: true,
      listenAddress: "127.0.0.1",
      listenPort: 15721,
      baseUrl: "http://127.0.0.1:15721/v1",
    });
    expect(validateProxyListenDraft("127.0.0.1", "abc")).toEqual({
      ok: false,
      error: "监听端口必须是 1024-65535 之间的数字。",
    });
  });

  it("reports multirouter runtime state from current provider and takeover status", () => {
    const plan = createDraftRoutingPlan([], []);

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        selectedRouteCount: 1,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: "other-router",
      }).label,
    ).toBe("未发布");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        selectedRouteCount: 1,
        isProxyRunning: false,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }).label,
    ).toBe("代理未启动");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        selectedRouteCount: 1,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }),
    ).toMatchObject({
      running: true,
      label: "运行中",
      tone: "ok",
    });
  });
});
