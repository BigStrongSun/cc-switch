import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providersApi } from "@/lib/api";
import {
  fetchModelsForConfig,
  type FetchedModel,
} from "@/lib/api/model-fetch";
import type { Provider } from "@/types";
import {
  applyMultiRouterSettingsDraft,
  buildMultiRouterRuntimeStatus,
  buildCodexProxyBaseUrl,
  buildModelCatalogForRoutes,
  CodexRouterWorkspacePage,
  createDraftRoutingPlan,
  isRoutingPlan,
  mergeRoutePickerDraftIds,
  normalizeCodexRouteForSave,
  readCodexRouting,
  validateProxyListenDraft,
} from "./CodexRouterWorkspacePage";

vi.mock("@/lib/api/proxy", () => ({
  proxyApi: {
    getGlobalProxyConfig: vi.fn().mockResolvedValue({
      listenAddress: "127.0.0.1",
      listenPort: 15721,
    }),
    diagnoseCodexMultiRouter: vi.fn(),
    unlockCodexModelPicker: vi.fn(),
  },
}));

vi.mock("@/lib/query/usage", () => ({
  usageKeys: {
    all: ["usage"],
  },
  useCodexSubagentUsageStats: () => ({
    data: {
      totals: {
        sessions: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      agents: [],
      modelStats: [],
      providerModels: [],
    },
    isLoading: false,
    error: null,
  }),
  useRequestLogs: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/api", () => ({
  providersApi: {
    add: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

/// 创建可手动完成的 Promise，用来稳定复现多个 provider 并发刷新时的返回顺序。
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderWorkspace(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

beforeEach(() => {
  vi.mocked(fetchModelsForConfig).mockReset();
  vi.mocked(providersApi.add).mockResolvedValue(true);
  vi.mocked(providersApi.update).mockResolvedValue(true);
});

describe("Codex MultiRouter workspace route persistence helpers", () => {
  it("finishes later provider refreshes after an earlier refresh rerenders the routes page", async () => {
    const firstRefresh = createDeferred<FetchedModel[]>();
    const secondRefresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const providerA: Provider = {
      id: "codex-source-a",
      name: "Provider A",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://a.example/v1",
        auth: { OPENAI_API_KEY: "key-a" },
        modelCatalog: { models: [{ model: "old-a" }] },
      },
    };
    const providerB: Provider = {
      id: "codex-source-b",
      name: "Provider B",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://b.example/v1",
        auth: { OPENAI_API_KEY: "key-b" },
        modelCatalog: { models: [{ model: "old-b" }] },
      },
    };
    const plan = createDraftRoutingPlan(
      [providerA, providerB],
      [providerA, providerB],
    );
    const usedRouteIds = new Set<string>();
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: providerA.name,
          targetProviderId: providerA.id,
          match: { models: ["model-a"] },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          label: providerB.name,
          targetProviderId: providerB.id,
          match: { models: ["model-b"] },
        },
        1,
        usedRouteIds,
      ),
    ];
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [providerA, providerB, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));

    firstRefresh.resolve([{ id: "model-a", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([provider]) => provider.id === providerA.id),
      ).toBe(true),
    );

    secondRefresh.resolve([{ id: "model-b", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([provider]) => provider.id === providerB.id),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getAllByText("已读取并更新 1 个模型。")).toHaveLength(2),
    );
  });

  it("reports a later provider refresh error after an earlier refresh rerenders the routes page", async () => {
    const firstRefresh = createDeferred<FetchedModel[]>();
    const secondRefresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise);
    const providerA: Provider = {
      id: "codex-error-source-a",
      name: "Provider A",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://a.example/v1",
        auth: { OPENAI_API_KEY: "key-a" },
        modelCatalog: { models: [{ model: "old-a" }] },
      },
    };
    const providerB: Provider = {
      id: "codex-error-source-b",
      name: "Provider B",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://b.example/v1",
        auth: { OPENAI_API_KEY: "key-b" },
        modelCatalog: { models: [{ model: "old-b" }] },
      },
    };
    const plan = createDraftRoutingPlan(
      [providerA, providerB],
      [providerA, providerB],
    );
    const usedRouteIds = new Set<string>();
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: providerA.name,
          targetProviderId: providerA.id,
          match: { models: ["model-a"] },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          label: providerB.name,
          targetProviderId: providerB.id,
          match: { models: ["model-b"] },
        },
        1,
        usedRouteIds,
      ),
    ];
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: routes[0].id,
          routes,
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [providerA, providerB, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));

    firstRefresh.resolve([{ id: "model-a", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(([provider]) => provider.id === providerA.id),
      ).toBe(true),
    );

    secondRefresh.reject(new Error("network timeout"));
    await waitFor(() =>
      expect(
        screen.getByText(
          "获取模型列表失败，请检查当前 provider 配置：network timeout",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("does not force the workspace back to routes after the initial jump is consumed", async () => {
    const source: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const providers = [source, plan];
    const props = {
      providers,
      isProxyRunning: true,
      isCodexTakeoverActive: true,
      activeProviderId: plan.id,
      initialProviderId: plan.id,
      initialTab: "routes" as const,
      onEditProvider: vi.fn(),
      onDeletePlan: vi.fn(),
      onCreateProvider: vi.fn(),
    };

    const { rerender } = renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, props),
    );

    expect(screen.getByRole("tab", { name: "路由规则" })).toHaveAttribute(
      "data-state",
      "active",
    );

    const user = userEvent.setup();
    const statusTab = screen.getByRole("tab", { name: "状态" });
    await user.click(statusTab);
    await waitFor(() =>
      expect(statusTab).toHaveAttribute("data-state", "active"),
    );

    rerender(
      React.createElement(
        QueryClientProvider,
        {
          client: new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        },
        React.createElement(CodexRouterWorkspacePage, {
          ...props,
          providers: [...providers],
        }),
      ),
    );

    await waitFor(() =>
      expect(statusTab).toHaveAttribute("data-state", "active"),
    );
  });

  it("exposes a delete action for routing plans inside the workspace", async () => {
    const source: Provider = {
      id: "codex-qwen",
      name: "Qwen Local",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const onDeletePlan = vi.fn();

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan,
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: "删除" })[0]);

    expect(onDeletePlan).toHaveBeenCalledWith(plan);
  });

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

  it("reads legacy array codexRouting without clearing routes", () => {
    const plan: Provider = {
      id: "codex-multirouter",
      name: "Codex GPT + DeepSeek 自动路由",
      category: "custom",
      settingsConfig: {
        codexRouting: [
          {
            id: "router-codex-official",
            label: "OpenAI Official",
            providerId: "codex-official",
            models: ["gpt-5.5"],
          },
          {
            id: "router-deepseek",
            label: "DeepSeek",
            providerId: "codex-deepseek",
            modelPrefixes: ["deepseek-"],
          },
        ],
      },
    };

    const routing = readCodexRouting(plan);

    expect(isRoutingPlan(plan)).toBe(true);
    expect(routing?.enabled).toBe(true);
    expect(routing?.routes).toHaveLength(2);
    expect(routing?.routes?.[0].id).toBe("router-codex-official");
    expect(routing?.routes?.[0].targetProviderId).toBe("codex-official");
    expect(routing?.routes?.[0].match?.models).toEqual(["gpt-5.5"]);
    expect(routing?.routes?.[1].match?.prefixes).toEqual(["deepseek-"]);
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
          models: [
            {
              model: "deepseek-v4-flash",
              contextWindow: 1000000,
              inputModalities: ["text"],
              textOnly: true,
              supportsImage: false,
            },
          ],
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
      {
        model: "deepseek-v4-flash",
        contextWindow: 1000000,
        inputModalities: ["text"],
        textOnly: true,
        supportsImage: false,
        capabilities: { inputModalities: ["text"], textOnly: true },
      },
    ]);
    expect(savedPlan.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "qwen3.6",
      "deepseek-v4-flash",
    ]);
  });

  it("rebuilds route catalog from current targets instead of keeping stale fallback models", () => {
    const qwen: Provider = {
      id: "codex-qwen-local",
      name: "Qwen Local vLLM",
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
    };
    const plan = createDraftRoutingPlan([], []);
    const stalePlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        modelCatalog: {
          models: [
            { model: "gpt-5.5" },
            { model: "gpt-5.4" },
            { model: "gpt-5.4-mini" },
            { model: "gpt-5.3-codex-spark" },
          ],
          spawnAgentModels: ["gpt-5.5", "gpt-5.4"],
        },
      },
    };
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: qwen.name,
          targetProviderId: qwen.id,
          match: { models: ["qwen3.6"], prefixes: ["qwen"] },
        },
        0,
        new Set<string>(),
      ),
    ];

    const rebuilt = buildModelCatalogForRoutes(
      stalePlan,
      routes,
      new Map([[qwen.id, qwen]]),
    );

    expect(rebuilt.models).toEqual([
      {
        model: "qwen3.6",
        displayName: "Qwen 3.6",
        contextWindow: 262144,
      },
    ]);
    expect(rebuilt.spawnAgentModels).toEqual(["qwen3.6"]);
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
      { model: "gpt-5.5", contextWindow: 272000 },
      { model: "gpt-5.4", contextWindow: 272000 },
      { model: "gpt-5.4-mini", contextWindow: 128000 },
      { model: "gpt-5.3-codex-spark", contextWindow: 128000 },
    ]);
    expect(plan.settingsConfig.modelCatalog.spawnAgentModels).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
  });

  it("rebuilds official fallback route catalog with full Codex context windows", () => {
    const officialBackup: Provider = {
      id: "codex-official-backup",
      name: "OpenAI Official Backup",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };
    const plan = createDraftRoutingPlan([officialBackup], [officialBackup]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: officialBackup.name,
          targetProviderId: officialBackup.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt-"] },
        },
        0,
        new Set<string>(),
      ),
    ];

    const rebuilt = buildModelCatalogForRoutes(
      plan,
      routes,
      new Map([[officialBackup.id, officialBackup]]),
    );

    expect(rebuilt.models).toContainEqual({
      model: "gpt-5.5",
      contextWindow: 272000,
    });
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
        enabledRouteCount: 1,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: "other-router",
      }).label,
    ).toBe("未发布");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 1,
        isProxyRunning: false,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }).label,
    ).toBe("代理未启动");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 0,
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
      }).label,
    ).toBe("无启用规则");

    expect(
      buildMultiRouterRuntimeStatus({
        selectedPlan: plan,
        selectedRouting: readCodexRouting(plan),
        enabledRouteCount: 1,
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
