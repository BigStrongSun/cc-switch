import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  syncCodexMultiRouterPlanWithProviders,
  syncCodexMultiRouterPlansAfterProviderChange,
} from "@/lib/codexMultiRouterSync";

// 构造测试用 provider；只填同步逻辑需要读取的字段。
function provider(overrides: Partial<Provider>): Provider {
  return {
    id: overrides.id ?? "provider",
    name: overrides.name ?? "Provider",
    category: overrides.category,
    settingsConfig: overrides.settingsConfig ?? {},
    meta: overrides.meta,
  };
}

describe("codexMultiRouterSync", () => {
  it("同步 provider 保留模型变更到 route、总 catalog 和子 Agent 候选", () => {
    const deepseek = provider({
      id: "deepseek",
      name: "DeepSeek",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-chat" },
            { model: "deepseek-reasoner" },
            { model: "deepseek-v4-flash" },
          ],
        },
      },
    });
    const qwen = provider({
      id: "qwen",
      name: "Qwen",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    });
    const plan = provider({
      id: "router",
      name: "Codex MultiRouter",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "deepseek-chat" },
            { model: "old-removed-model" },
            { model: "qwen3.6" },
          ],
          spawnAgentModels: ["old-removed-model", "qwen3.6"],
        },
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "router-deepseek",
              targetProviderId: "deepseek",
              match: { models: ["deepseek-chat", "old-removed-model"] },
              upstream: {
                apiFormat: "openai_chat",
                auth: { source: "provider_config" },
              },
            },
            {
              id: "router-qwen",
              targetProviderId: "qwen",
              match: { models: ["qwen3.6"] },
              upstream: {
                apiFormat: "openai_chat",
                auth: { source: "provider_config" },
              },
            },
          ],
        },
      },
    });

    const synced = syncCodexMultiRouterPlanWithProviders(
      plan,
      new Map([
        [deepseek.id, deepseek],
        [qwen.id, qwen],
        [plan.id, plan],
      ]),
    );

    expect(synced?.settingsConfig.codexRouting.routes[0].match.models).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
    ]);
    expect(
      synced?.settingsConfig.modelCatalog.models.map(
        (model: { model: string }) => model.model,
      ),
    ).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "qwen3.6",
    ]);
    expect(synced?.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "qwen3.6",
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
    ]);
  });

  it("同步 provider 模型变更时保留已保存 route 的别名 modelMap", () => {
    const relay = provider({
      id: "relay",
      name: "Relay",
      settingsConfig: {
        modelCatalog: {
          models: [
            { model: "gpt-5.5", contextWindow: 272000 },
            { model: "gpt-5.4-mini", contextWindow: 128000 },
          ],
        },
      },
    });
    const plan = provider({
      id: "router",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5-relay", upstreamModel: "gpt-5.5" }],
          spawnAgentModels: ["gpt-5.5-relay"],
        },
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "router-relay",
              targetProviderId: "relay",
              match: { models: ["gpt-5.5-relay"] },
              upstream: {
                apiFormat: "openai_chat",
                auth: { source: "provider_config" },
                modelMap: { "gpt-5.5-relay": "gpt-5.5" },
              },
            },
          ],
        },
      },
    });

    const synced = syncCodexMultiRouterPlanWithProviders(
      plan,
      new Map([
        [relay.id, relay],
        [plan.id, plan],
      ]),
    );

    expect(synced?.settingsConfig.codexRouting.routes[0].match.models).toEqual([
      "gpt-5.5-relay",
      "gpt-5.4-mini",
    ]);
    expect(
      synced?.settingsConfig.codexRouting.routes[0].upstream.modelMap,
    ).toEqual({ "gpt-5.5-relay": "gpt-5.5" });
    expect(synced?.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "gpt-5.5-relay",
      "gpt-5.4-mini",
    ]);
    expect(synced?.settingsConfig.modelCatalog.models).toEqual([
      {
        model: "gpt-5.5-relay",
        upstreamModel: "gpt-5.5",
        displayName: "gpt-5.5-relay",
        contextWindow: 272000,
      },
      {
        model: "gpt-5.4-mini",
        upstreamModel: "gpt-5.4-mini",
        contextWindow: 128000,
      },
    ]);
  });

  it("provider id 改名时同步 route 目标并按新 provider 目录重建", () => {
    const renamed = provider({
      id: "new-provider",
      name: "New Provider",
      settingsConfig: {
        modelCatalog: { models: [{ model: "new-model" }] },
      },
    });
    const plan = provider({
      id: "router",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "old-model" }],
          spawnAgentModels: ["old-model"],
        },
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "router-old",
              targetProviderId: "old-provider",
              match: { models: ["old-model"] },
              upstream: {
                apiFormat: "openai_chat",
                auth: { source: "provider_config" },
              },
            },
          ],
        },
      },
    });

    const [synced] = syncCodexMultiRouterPlansAfterProviderChange(
      [renamed, plan],
      renamed,
      "old-provider",
    );

    expect(synced.settingsConfig.codexRouting.routes[0].targetProviderId).toBe(
      "new-provider",
    );
    expect(synced.settingsConfig.codexRouting.routes[0].match.models).toEqual([
      "new-model",
    ]);
    expect(synced.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "new-model",
    ]);
  });
});
