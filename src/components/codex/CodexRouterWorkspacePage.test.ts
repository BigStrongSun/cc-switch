import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providersApi } from "@/lib/api";
import { fetchModelsForConfig, type FetchedModel } from "@/lib/api/model-fetch";
import type { Provider } from "@/types";
import type { PaginatedLogs, RequestLog } from "@/types/usage";
import {
  applyMultiRouterSettingsDraft,
  buildMultiRouterRuntimeStatus,
  buildCodexProxyBaseUrl,
  buildModelCatalogForRoutes,
  CodexRouterWorkspacePage,
  createDraftRoutingPlan,
  dedupeCodexRoutesBySemanticProvider,
  isRoutingPlan,
  mergeRoutePickerDraftIds,
  normalizeCodexRouteForSave,
  normalizeCodexRoutesForVisibleModelAliases,
  readCodexRouting,
  validateProxyListenDraft,
} from "./CodexRouterWorkspacePage";

const requestLogsFixture = vi.hoisted(() => ({
  value: { data: [], isLoading: false } as {
    data: PaginatedLogs | [];
    isLoading: boolean;
  },
}));

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
  useRequestLogs: () => requestLogsFixture.value,
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

/// 构造状态页所需的最小代理日志；测试只关心 Codex 最近一次真实转发是否成功。
function createCodexProxyLog(overrides: Partial<RequestLog> = {}): RequestLog {
  return {
    requestId: "req-1",
    providerId: "codex-router",
    providerName: "Codex MultiRouter",
    appType: "codex",
    model: "gpt-5.4-mini",
    requestModel: "gpt-5.4-mini",
    costMultiplier: "1",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputCostUsd: "0",
    outputCostUsd: "0",
    cacheReadCostUsd: "0",
    cacheCreationCostUsd: "0",
    totalCostUsd: "0",
    isStreaming: false,
    latencyMs: 100,
    statusCode: 200,
    createdAt: Date.now(),
    dataSource: "proxy",
    ...overrides,
  };
}

beforeEach(() => {
  requestLogsFixture.value = { data: [], isLoading: false };
  vi.mocked(fetchModelsForConfig).mockReset();
  vi.mocked(providersApi.add).mockResolvedValue(true);
  vi.mocked(providersApi.update).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
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

  it("restarts provider refresh when the api key changes and ignores the stale request", async () => {
    const staleRefresh = createDeferred<FetchedModel[]>();
    const currentRefresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig)
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(currentRefresh.promise);
    const provider: Provider = {
      id: "codex-keyed-source",
      name: "Keyed Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://keyed.example/v1",
        auth: { OPENAI_API_KEY: "old-key" },
        modelCatalog: { models: [{ model: "old-catalog" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    const usedRouteIds = new Set<string>();
    const route = normalizeCodexRouteForSave(
      {
        label: provider.name,
        targetProviderId: provider.id,
        match: { models: ["new-model"] },
      },
      0,
      usedRouteIds,
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          defaultRouteId: route.id,
          routes: [route],
        },
      },
    };
    const props = {
      providers: [provider, routedPlan],
      isProxyRunning: true,
      isCodexTakeoverActive: true,
      activeProviderId: routedPlan.id,
      initialProviderId: routedPlan.id,
      initialTab: "routes" as const,
      onEditProvider: vi.fn(),
      onDeletePlan: vi.fn(),
      onCreateProvider: vi.fn(),
    };

    const { rerender } = renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, props),
    );
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));

    const providerWithNewKey: Provider = {
      ...provider,
      settingsConfig: {
        ...provider.settingsConfig,
        auth: { OPENAI_API_KEY: "new-key" },
      },
    };
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
          providers: [providerWithNewKey, routedPlan],
        }),
      ),
    );
    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(2));

    staleRefresh.resolve([{ id: "stale-model", ownedBy: null }]);
    await Promise.resolve();
    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([savedProvider]) =>
          JSON.stringify(savedProvider.settingsConfig).includes("stale-model"),
        ),
    ).toBe(false);

    currentRefresh.resolve([{ id: "new-model", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(
            ([savedProvider]) =>
              savedProvider.id === provider.id &&
              JSON.stringify(savedProvider.settingsConfig).includes(
                "new-model",
              ),
          ),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(providersApi.update)
        .mock.calls.some(([savedProvider]) =>
          JSON.stringify(savedProvider.settingsConfig).includes("stale-model"),
        ),
    ).toBe(false);
  });

  it("settles a provider refresh when the model fetch ipc never returns", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchModelsForConfig).mockReturnValue(new Promise(() => {}));
    const provider: Provider = {
      id: "codex-timeout-source",
      name: "Timeout Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://timeout.example/v1",
        auth: { OPENAI_API_KEY: "key-timeout" },
        modelCatalog: { models: [{ model: "old-timeout" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      screen.getByText(
        "获取模型列表失败，请检查当前 provider 配置：模型列表读取或写回超过 30 秒，请检查网络、provider /models 端点或本地配置写入状态。",
      ),
    ).toBeInTheDocument();
  });

  it("settles a provider refresh when saving fetched models never returns", async () => {
    vi.useFakeTimers();
    const saveRefresh = createDeferred<boolean>();
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "model-from-upstream", ownedBy: null },
    ]);
    vi.mocked(providersApi.update).mockReturnValue(saveRefresh.promise);
    const provider: Provider = {
      id: "codex-save-timeout-source",
      name: "Save Timeout Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://save-timeout.example/v1",
        auth: { OPENAI_API_KEY: "key-save-timeout" },
        modelCatalog: { models: [{ model: "old-save-timeout" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchModelsForConfig).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("已读取 1 个模型，正在写回本地配置..."),
    ).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(
      screen.getByText(
        "获取模型列表失败，请检查当前 provider 配置：模型列表读取或写回超过 30 秒，请检查网络、provider /models 端点或本地配置写入状态。",
      ),
    ).toBeInTheDocument();

    saveRefresh.resolve(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.queryByText("已读取并更新 1 个模型。"),
    ).not.toBeInTheDocument();
  });

  it("refreshes visible route picker candidates after provider catalog save without parent refetch", async () => {
    const refresh = createDeferred<FetchedModel[]>();
    vi.mocked(fetchModelsForConfig).mockReturnValueOnce(refresh.promise);
    const provider: Provider = {
      id: "codex-empty-catalog-source",
      name: "Empty Catalog Source",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://empty-catalog.example/v1",
        auth: { OPENAI_API_KEY: "key-empty-catalog" },
        modelCatalog: { models: [] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "编辑匹配规则" }));
    expect(
      screen.getByText("未发现模型目录，保存后可在模型源补充目录"),
    ).toBeInTheDocument();

    refresh.resolve([{ id: "fresh-route-model", ownedBy: null }]);
    await waitFor(() =>
      expect(
        vi
          .mocked(providersApi.update)
          .mock.calls.some(
            ([savedProvider]) =>
              savedProvider.id === provider.id &&
              JSON.stringify(savedProvider.settingsConfig).includes(
                "fresh-route-model",
              ),
          ),
      ).toBe(true),
    );

    await waitFor(() =>
      expect(screen.getByText("fresh-route-model")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("未发现模型目录，保存后可在模型源补充目录"),
    ).not.toBeInTheDocument();
  });

  it("opens the Codex add-source flow when route picker has no model sources", async () => {
    const onCreateProvider = vi.fn();
    const plan = createDraftRoutingPlan([], []);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider,
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "编辑匹配规则" }));
    await user.click(screen.getByRole("button", { name: "添加模型源" }));

    expect(onCreateProvider).toHaveBeenCalledTimes(1);
  });

  it("scrolls to the inline route picker after opening route editing", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const provider: Provider = {
      id: "codex-qwen-scroll",
      name: "Qwen Scroll Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "编辑匹配规则" }));

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "nearest",
      }),
    );
  });

  it("resets the workspace scroll position when jumping between multirouter tabs", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const provider: Provider = {
      id: "codex-scroll-tab-source",
      name: "Scroll Tab Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);
    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "overview",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    scrollTo.mockClear();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "查看链路状态" }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 0));
  });

  it("keeps a visible alias when route page refreshes provider models from upstream ids", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
    ]);
    const provider: Provider = {
      id: "codex-thirdparty-gpt",
      name: "Third-party GPT",
      category: "custom",
      settingsConfig: {
        baseUrl: "https://thirdparty.example/v1",
        auth: { OPENAI_API_KEY: "key-thirdparty" },
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5-thirdparty",
              upstreamModel: "gpt-5.5",
              displayName: "Third-party GPT",
            },
          ],
        },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(
        vi.mocked(providersApi.update).mock.calls.some(([savedProvider]) => {
          if (savedProvider.id !== provider.id) return false;
          return (
            JSON.stringify(savedProvider.settingsConfig.modelCatalog.models) ===
            JSON.stringify([
              {
                model: "gpt-5.5-thirdparty",
                upstreamModel: "gpt-5.5",
                displayName: "Third-party GPT",
                contextWindow: 272000,
              },
            ])
          );
        }),
      ).toBe(true),
    );
  });

  it("uses Volcengine OpenAPI when the routes page refreshes AgentPlan models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "ark-code-latest", ownedBy: "volcengine", contextWindow: 262144 },
    ]);
    const provider: Provider = {
      id: "codex-volcengine-agentplan",
      name: "火山 AgentPlan",
      category: "custom",
      meta: {
        partnerPromotionKey: "volcengine_agentplan",
        usage_script: {
          enabled: true,
          language: "javascript",
          code: "",
          accessKeyId: "ak-route-refresh",
          secretAccessKey: "sk-route-refresh",
        },
      },
      settingsConfig: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: {},
        modelCatalog: { models: [{ model: "old-agentplan-model" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(fetchModelsForConfig).toHaveBeenCalledWith(
      "https://ark.cn-beijing.volces.com/api/coding/v3",
      "",
      false,
      undefined,
      undefined,
      {
        action: "ListArkAgentPlanModel",
        accessKeyId: "ak-route-refresh",
        secretAccessKey: "sk-route-refresh",
      },
    );
    await waitFor(() =>
      expect(
        vi.mocked(providersApi.update).mock.calls.some(([savedProvider]) => {
          if (savedProvider.id !== provider.id) return false;
          return JSON.stringify(savedProvider.settingsConfig).includes(
            "ark-code-latest",
          );
        }),
      ).toBe(true),
    );
  });

  it("falls back to data-plane models for AgentPlan routes when AK/SK is missing but API Key exists", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "ark-code-latest", ownedBy: "volcengine", contextWindow: 262144 },
    ]);
    const provider: Provider = {
      id: "codex-volcengine-agentplan-api-key",
      name: "火山 AgentPlan",
      category: "custom",
      meta: {
        partnerPromotionKey: "volcengine_agentplan",
      },
      settingsConfig: {
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        auth: { OPENAI_API_KEY: "sk-volc-route" },
        modelCatalog: { models: [{ model: "old-agentplan-model" }] },
      },
    };
    const plan = createDraftRoutingPlan([provider], [provider]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [provider, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "routes",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await waitFor(() => expect(fetchModelsForConfig).toHaveBeenCalledTimes(1));
    expect(fetchModelsForConfig).toHaveBeenCalledWith(
      "https://ark.cn-beijing.volces.com/api/coding/v3",
      "sk-volc-route",
      false,
      undefined,
      undefined,
      undefined,
    );
    await waitFor(() =>
      expect(
        vi.mocked(providersApi.update).mock.calls.some(([savedProvider]) => {
          if (savedProvider.id !== provider.id) return false;
          return JSON.stringify(savedProvider.settingsConfig).includes(
            "ark-code-latest",
          );
        }),
      ).toBe(true),
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

  it("preserves catalog upstream models when creating and rebuilding routing plans", () => {
    const thirdParty: Provider = {
      id: "codex-thirdparty-gpt",
      name: "Third-party GPT",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5-thirdparty",
              upstreamModel: "gpt-5.5",
              displayName: "Third-party GPT",
              contextWindow: 272000,
            },
          ],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };

    const plan = createDraftRoutingPlan([thirdParty], [thirdParty]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: thirdParty.name,
          targetProviderId: thirdParty.id,
          match: { models: ["gpt-5.5-thirdparty"], prefixes: [] },
        },
        0,
        new Set<string>(),
      ),
    ];

    expect(plan.settingsConfig.modelCatalog.models).toEqual([
      {
        model: "gpt-5.5-thirdparty",
        upstreamModel: "gpt-5.5",
        displayName: "Third-party GPT",
        contextWindow: 272000,
      },
    ]);
    expect(
      buildModelCatalogForRoutes(
        plan,
        routes,
        new Map([[thirdParty.id, thirdParty]]),
      ).models,
    ).toEqual([
      {
        model: "gpt-5.5-thirdparty",
        upstreamModel: "gpt-5.5",
        displayName: "Third-party GPT",
        contextWindow: 272000,
      },
    ]);
  });

  it("aliases duplicate provider models when saving manual multirouter routes", async () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const relay: Provider = {
      id: "codex-relay-gpt",
      name: "Relay GPT",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5",
              displayName: "Relay GPT 5.5",
              upstreamModel: "gpt-5.5",
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan([official, relay], [official, relay]);
    const officialRoute = normalizeCodexRouteForSave(
      {
        label: official.name,
        targetProviderId: official.id,
        match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
        upstream: { apiFormat: "openai_responses" },
      },
      0,
      new Set<string>(),
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          routes: [officialRoute],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [official, relay, routedPlan],
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

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "编辑匹配规则" }));
    await user.click(screen.getByRole("button", { name: "启用" }));
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    const updateCalls = vi.mocked(providersApi.update).mock.calls;
    const savedPlan = updateCalls[updateCalls.length - 1]?.[0] as Provider;
    const savedRoutes = readCodexRouting(savedPlan)?.routes ?? [];
    const relayRoute = savedRoutes.find(
      (route) => route.targetProviderId === relay.id,
    );

    expect(savedPlan.settingsConfig.modelCatalog.models).toEqual([
      { model: "gpt-5.5" },
      {
        model: "gpt-5.5-relay-gpt",
        displayName: "Relay GPT 5.5",
        upstreamModel: "gpt-5.5",
      },
    ]);
    expect(relayRoute?.match?.models).toEqual(["gpt-5.5-relay-gpt"]);
    expect(relayRoute?.upstream?.modelMap).toEqual({
      "gpt-5.5-relay-gpt": "gpt-5.5",
    });
  });

  it("repairs duplicate exact route models before saving manual routes", () => {
    const official: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
      meta: { apiFormat: "openai_responses" },
    };
    const relay: Provider = {
      id: "codex-relay-gpt",
      name: "Relay GPT",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5-relay-gpt",
              displayName: "Relay GPT 5.5",
              upstreamModel: "gpt-5.5",
            },
          ],
        },
      },
      meta: { apiFormat: "openai_chat" },
    };
    const plan = createDraftRoutingPlan([official, relay], [official, relay]);
    const usedRouteIds = new Set<string>();
    const badRoutes = [
      normalizeCodexRouteForSave(
        {
          id: "router-official",
          label: official.name,
          targetProviderId: official.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
          upstream: { apiFormat: "openai_responses" },
        },
        0,
        usedRouteIds,
      ),
      normalizeCodexRouteForSave(
        {
          id: "router-relay",
          label: relay.name,
          targetProviderId: relay.id,
          match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
          upstream: { apiFormat: "openai_chat" },
        },
        1,
        usedRouteIds,
      ),
    ];

    const normalizedRoutes = normalizeCodexRoutesForVisibleModelAliases(
      plan,
      badRoutes,
      new Map([
        [official.id, official],
        [relay.id, relay],
      ]),
    );
    const catalog = buildModelCatalogForRoutes(
      plan,
      normalizedRoutes,
      new Map([
        [official.id, official],
        [relay.id, relay],
      ]),
    );

    expect(normalizedRoutes[0].match?.models).toEqual(["gpt-5.5"]);
    expect(normalizedRoutes[1].match?.models).toEqual(["gpt-5.5-relay-gpt"]);
    expect(normalizedRoutes[1].upstream?.modelMap).toEqual({
      "gpt-5.5-relay-gpt": "gpt-5.5",
    });
    expect(catalog.models.map((model) => model.model)).toEqual([
      "gpt-5.5",
      "gpt-5.5-relay-gpt",
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

  it("keeps legacy provider references and dedupes equivalent route candidates", () => {
    const deepseek: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "deepseek-v4-flash" }],
        },
      },
    };
    const plan: Provider = {
      id: "codex-multirouter",
      name: "Legacy Router",
      category: "custom",
      settingsConfig: {
        codexRouting: [
          {
            id: "legacy-deepseek",
            label: "DeepSeek",
            provider: "deepseek",
            models: ["deepseek-v4-flash"],
          },
          {
            id: "router-deepseek",
            label: "DeepSeek",
            targetProviderId: "deepseek",
            match: { models: ["deepseek-v4-flash"] },
          },
        ],
      },
    };

    const routes = readCodexRouting(plan)?.routes ?? [];
    const deduped = dedupeCodexRoutesBySemanticProvider(routes, [deepseek]);

    expect(routes[0].targetProviderId).toBe("deepseek");
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("legacy-deepseek");
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

  it("adds and enables a new provider candidate without using select-all", async () => {
    const openai: Provider = {
      id: "codex-openai",
      name: "OpenAI Official",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "gpt-5.5" }] },
      },
    };
    const qwen: Provider = {
      id: "codex-qwen-local",
      name: "Qwen Local vLLM",
      category: "custom",
      settingsConfig: {
        modelCatalog: { models: [{ model: "qwen3.6" }] },
      },
    };
    const plan = createDraftRoutingPlan([openai, qwen], [openai, qwen]);
    const openaiRoute = normalizeCodexRouteForSave(
      {
        label: openai.name,
        targetProviderId: openai.id,
        match: { models: ["gpt-5.5"], prefixes: ["gpt"] },
      },
      0,
      new Set<string>(),
    );
    const routedPlan: Provider = {
      ...plan,
      settingsConfig: {
        ...plan.settingsConfig,
        codexRouting: {
          enabled: true,
          routes: [openaiRoute],
        },
      },
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [openai, qwen, routedPlan],
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

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "编辑匹配规则" }));
    await user.click(screen.getByRole("button", { name: "启用" }));
    await user.click(screen.getByRole("button", { name: "保存规则" }));

    await waitFor(() => expect(providersApi.update).toHaveBeenCalled());
    const updateCalls = vi.mocked(providersApi.update).mock.calls;
    const savedPlan = updateCalls[updateCalls.length - 1]?.[0];
    const savedRoutes = readCodexRouting(savedPlan as Provider)?.routes ?? [];
    const qwenRoute = savedRoutes.find(
      (route) => route.targetProviderId === qwen.id,
    );

    expect(savedRoutes).toHaveLength(2);
    expect(qwenRoute?.enabled).toBe(true);
    expect(qwenRoute?.match?.models).toContain("qwen3.6");
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

  // onRuntimeReady 测试：当本地代理运行、Codex 接管激活、当前 MultiRouter 已发布并启用路由、
  // 且最新请求转发成功（statusCode 200-399）时，onRuntimeReady 回调应被调用。
  it("calls onRuntimeReady when config is ready and latest request forward succeeds", async () => {
    const source: Provider = {
      id: "codex-online-source",
      name: "Online Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "test-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: source.name,
          targetProviderId: source.id,
          match: { models: ["test-model"] },
        },
        0,
        new Set<string>(),
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
    const onRuntimeReady = vi.fn();

    requestLogsFixture.value = {
      data: {
        data: [
          createCodexProxyLog({
            providerId: "codex-online-source",
            model: "test-model",
            requestModel: "test-model",
          }),
        ],
        total: 1,
        page: 0,
        pageSize: 500,
      },
      isLoading: false,
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
        onRuntimeReady,
      }),
    );

    await waitFor(() =>
      expect(onRuntimeReady).toHaveBeenCalledWith(routedPlan),
    );
  });

  it("shows a visible result after refreshing multirouter validation state", async () => {
    const source: Provider = {
      id: "codex-refresh-source",
      name: "Refresh Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "refresh-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, plan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: plan.id,
        initialProviderId: plan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
      }),
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新校验" }));

    await waitFor(() =>
      expect(
        screen.getByText("已刷新校验状态，请查看链路卡片和最近转发表。"),
      ).toBeInTheDocument(),
    );
  });

  // onRuntimeReady 负向测试：即使最近一条 Codex 代理日志成功，只要它没有命中当前
  // MultiRouter 方案的 route，就不能提前进入“配置成功 -> 历史修复”收尾流程。
  it("does not call onRuntimeReady when latest successful request is outside the selected route", async () => {
    const source: Provider = {
      id: "codex-online-source",
      name: "Online Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "test-model" }],
        },
      },
    };
    const unrelatedSource: Provider = {
      id: "codex-unrelated-source",
      name: "Unrelated Source",
      category: "custom",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "other-model" }],
        },
      },
    };
    const plan = createDraftRoutingPlan([source], [source]);
    const routes = [
      normalizeCodexRouteForSave(
        {
          label: source.name,
          targetProviderId: source.id,
          match: { models: ["test-model"] },
        },
        0,
        new Set<string>(),
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
    const onRuntimeReady = vi.fn();

    requestLogsFixture.value = {
      data: {
        data: [
          createCodexProxyLog({
            providerId: unrelatedSource.id,
            providerName: unrelatedSource.name,
            model: "other-model",
            requestModel: "other-model",
            statusCode: 200,
          }),
        ],
        total: 1,
        page: 0,
        pageSize: 500,
      },
      isLoading: false,
    };

    renderWorkspace(
      React.createElement(CodexRouterWorkspacePage, {
        providers: [source, unrelatedSource, routedPlan],
        isProxyRunning: true,
        isCodexTakeoverActive: true,
        activeProviderId: routedPlan.id,
        initialProviderId: routedPlan.id,
        initialTab: "status",
        onEditProvider: vi.fn(),
        onDeletePlan: vi.fn(),
        onCreateProvider: vi.fn(),
        onRuntimeReady,
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("成功 200")).toBeInTheDocument(),
    );
    expect(screen.queryByText("当前方案成功")).not.toBeInTheDocument();
    expect(onRuntimeReady).not.toHaveBeenCalled();
  });
});
