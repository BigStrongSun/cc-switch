import { describe, expect, it } from "vitest";
import type { Provider } from "@/types";
import {
  applyWizardConnectivityApiFormatOverrides,
  buildCodexMultiRouterWizardPlan,
  buildWizardRoutesFromSources,
  canContinueAfterConnectivity,
  classifyWizardConnectivityResult,
  collectWizardModelNameCollisions,
  getWizardConfigIssues,
  inferWizardApiFormat,
  resolveWizardModelNameCollisions,
} from "@/lib/codexMultiRouterWizard";

// 构造最小 Codex provider，测试只关注向导 helper 写入的私有字段。
function provider(overrides: Partial<Provider>): Provider {
  return {
    id: overrides.id ?? "provider",
    name: overrides.name ?? "Provider",
    category: overrides.category,
    settingsConfig: overrides.settingsConfig ?? {},
    meta: overrides.meta,
  };
}

describe("codexMultiRouterWizard helpers", () => {
  it("aliases third-party duplicate models while preserving upstreamModel", () => {
    const official = provider({
      id: "openai-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });
    const relay = provider({
      id: "relay-main",
      name: "Relay",
      category: "aggregator",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    const [, resolvedRelay] = resolveWizardModelNameCollisions([
      official,
      relay,
    ]);

    expect(resolvedRelay.settingsConfig.modelCatalog.models[0]).toMatchObject({
      model: "gpt-5.5-relay",
      upstreamModel: "gpt-5.5",
    });
  });

  it("adds provider-name suffixes to every third-party duplicate when no official source exists", () => {
    const relayA = provider({
      id: "3ecd52c8-random",
      name: "Yansd666 GPT",
      category: "aggregator",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });
    const relayB = provider({
      id: "relay-b",
      name: "Codex Relay",
      category: "aggregator",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    const [resolvedA, resolvedB] = resolveWizardModelNameCollisions([
      relayA,
      relayB,
    ]);

    expect(resolvedA.settingsConfig.modelCatalog.models[0]).toMatchObject({
      model: "gpt-5.5-yansd666-gpt",
      upstreamModel: "gpt-5.5",
    });
    expect(resolvedB.settingsConfig.modelCatalog.models[0]).toMatchObject({
      model: "gpt-5.5-codex-relay",
      upstreamModel: "gpt-5.5",
    });
  });

  it("does not treat OpenAI-compatible third-party relays as official sources", () => {
    const official = provider({
      id: "openai",
      name: "OpenAI",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });
    const compatibleRelay = provider({
      id: "openai-compatible-relay",
      name: "OpenAI Compatible Relay",
      category: "aggregator",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    const [, resolvedRelay] = resolveWizardModelNameCollisions([
      official,
      compatibleRelay,
    ]);

    expect(resolvedRelay.settingsConfig.modelCatalog.models[0]).toMatchObject({
      model: "gpt-5.5-openai-compatible-relay",
      upstreamModel: "gpt-5.5",
    });
  });

  it("uses native Responses routes for official OpenAI GPT/O models even when legacy metadata says chat", () => {
    const openaiBackup = provider({
      id: "openai-official-backup",
      name: "OpenAI Official Backup",
      category: "official",
      meta: { apiFormat: "openai_chat" },
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    expect(inferWizardApiFormat(openaiBackup)).toBe("openai_responses");
  });

  it("uses successful Responses probes to override stale chat metadata before route generation", () => {
    const relay = provider({
      id: "relay",
      name: "Relay",
      category: "aggregator",
      meta: { apiFormat: "openai_chat" },
      settingsConfig: {
        apiFormat: "openai_chat",
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    const [resolvedRelay] = applyWizardConnectivityApiFormatOverrides(
      [relay],
      [
        {
          providerId: "relay",
          providerName: "Relay",
          model: "gpt-5.5",
          status: "pass",
          canContinue: true,
          detail: "直接 /v1/responses 探测通过。",
        },
      ],
    );

    expect(inferWizardApiFormat(resolvedRelay)).toBe("openai_responses");
    expect(buildWizardRoutesFromSources([resolvedRelay])[0].upstream).toMatchObject(
      {
        apiFormat: "openai_responses",
      },
    );
  });

  it("keeps stale chat metadata when Responses probes warn or fail", () => {
    const relay = provider({
      id: "relay",
      name: "Relay",
      category: "aggregator",
      meta: { apiFormat: "openai_chat" },
      settingsConfig: {
        apiFormat: "openai_chat",
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    const [resolvedRelay] = applyWizardConnectivityApiFormatOverrides(
      [relay],
      [
        {
          providerId: "relay",
          providerName: "Relay",
          model: "gpt-5.5",
          status: "warn",
          canContinue: true,
          detail: "直接 /v1/responses 失败，保留 Chat Completions。",
        },
      ],
    );

    expect(inferWizardApiFormat(resolvedRelay)).toBe("openai_chat");
  });

  it("groups generated routes by provider and infers common model prefixes", () => {
    const openai = provider({
      id: "openai",
      name: "OpenAI",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }, { model: "o4-mini" }] },
      },
    });
    const deepseek = provider({
      id: "deepseek",
      name: "DeepSeek",
      settingsConfig: {
        modelCatalog: { models: [{ model: "deepseek-chat" }] },
      },
    });
    const qwen = provider({
      id: "qwen-local",
      name: "Qwen Local",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3-coder" }] },
      },
    });

    const routes = buildWizardRoutesFromSources([openai, deepseek, qwen]);

    expect(routes).toHaveLength(3);
    expect(routes[0].match.prefixes).toEqual(
      expect.arrayContaining(["gpt", "o"]),
    );
    expect(routes[1].match.prefixes).toContain("deepseek");
    expect(routes[2].match.prefixes).toContain("qwen");
    expect(routes.map((route) => route.targetProviderId)).toEqual([
      "openai",
      "deepseek",
      "qwen-local",
    ]);
  });

  it("builds a MultiRouter plan whose routes and catalog expose the same visible models", () => {
    const deepseek = provider({
      id: "deepseek",
      name: "DeepSeek",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-chat", upstreamModel: "deepseek-chat" }],
        },
      },
    });
    const qwen = provider({
      id: "qwen",
      name: "Qwen",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "qwen3-coder", upstreamModel: "qwen3-coder" }],
        },
      },
    });

    const { plan } = buildCodexMultiRouterWizardPlan(
      [deepseek, qwen],
      [deepseek, qwen],
    );
    const routeModels = new Set(
      plan.settingsConfig.codexRouting.routes.flatMap(
        (route: { match: { models: string[] } }) => route.match.models,
      ),
    );
    const catalogModels = new Set(
      plan.settingsConfig.modelCatalog.models.map(
        (model: { model: string }) => model.model,
      ),
    );

    expect(plan.settingsConfig.codexRouting.routes).toHaveLength(2);
    expect(routeModels).toEqual(catalogModels);
    expect(plan.settingsConfig.base_url).toBe("http://127.0.0.1:15721/v1");
  });

  it("reports config issues only for sources without fetch config or model catalog", () => {
    const incomplete = provider({
      id: "empty-relay",
      name: "Empty Relay",
      settingsConfig: {},
    });
    const catalogOnly = provider({
      id: "manual-catalog",
      name: "Manual Catalog",
      settingsConfig: {
        modelCatalog: { models: [{ model: "manual-model" }] },
      },
    });

    const issues = getWizardConfigIssues([incomplete, catalogOnly]);

    expect(issues).toEqual([
      {
        providerId: "empty-relay",
        providerName: "Empty Relay",
        reason: "缺少 Base URL/API Key，且当前没有可用 modelCatalog。",
      },
    ]);
  });

  it("collects duplicate upstream model collisions for state machine review", () => {
    const official = provider({
      id: "openai-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });
    const relay = provider({
      id: "relay",
      name: "Relay",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "relay-gpt-5.5", upstreamModel: "gpt-5.5" }],
        },
      },
    });

    expect(collectWizardModelNameCollisions([official, relay])).toEqual([
      {
        upstreamModel: "gpt-5.5",
        providerIds: ["openai-official", "relay"],
        canonicalProviderIds: ["openai-official"],
      },
    ]);
  });

  it("treats failed direct Responses probes as blocking for native Responses providers", () => {
    const responsesProvider = provider({
      id: "responses",
      name: "Responses Provider",
      meta: { apiFormat: "openai_responses" },
    });

    const result = classifyWizardConnectivityResult({
      provider: responsesProvider,
      model: "gpt-5.5",
      ok: false,
      detail: "HTTP 404",
    });

    expect(result.status).toBe("fail");
    expect(result.canContinue).toBe(false);
    expect(canContinueAfterConnectivity([result])).toBe(false);
  });

  it("allows failed direct Responses probes as warnings for Chat Completions providers", () => {
    const chatProvider = provider({
      id: "chat",
      name: "Chat Provider",
      meta: { apiFormat: "openai_chat" },
    });

    const result = classifyWizardConnectivityResult({
      provider: chatProvider,
      model: "deepseek-chat",
      ok: false,
      detail: "HTTP 404",
    });

    expect(result.status).toBe("warn");
    expect(result.canContinue).toBe(true);
    expect(canContinueAfterConnectivity([result])).toBe(true);
  });
});
