import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateProviderMutation } from "@/lib/query/mutations";
import { usageKeys } from "@/lib/query/usage";
import type { Provider } from "@/types";

const apiMocks = vi.hoisted(() => ({
  update: vi.fn(),
  getAll: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  providersApi: {
    update: (...args: unknown[]) => apiMocks.update(...args),
    getAll: (...args: unknown[]) => apiMocks.getAll(...args),
  },
  sessionsApi: {},
  settingsApi: {},
}));

vi.mock("@/hooks/useHermes", () => ({
  invalidateHermesProviderCaches: vi.fn(),
}));

vi.mock("@/hooks/useOpenClaw", () => ({
  openclawKeys: {
    health: ["openclaw", "health"],
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { wrapper, invalidateSpy };
}

function createProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-1",
    name: "Test Provider",
    settingsConfig: {},
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.update.mockReset().mockResolvedValue(true);
  apiMocks.getAll.mockReset().mockResolvedValue({});
});

describe("useUpdateProviderMutation", () => {
  it("invalidates the updated provider usage query", async () => {
    const { wrapper, invalidateSpy } = createWrapper();
    const provider = createProvider({ id: "provider-b" });
    const { result } = renderHook(() => useUpdateProviderMutation("codex"), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({ provider });
    });

    expect(apiMocks.update).toHaveBeenCalledWith(provider, "codex", undefined);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["providers", "codex"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: usageKeys.script("provider-b", "codex"),
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: usageKeys.all,
    });
  });

  it("syncs affected Codex MultiRouter plans and returns removed subagent candidates", async () => {
    const { wrapper } = createWrapper();
    const provider = createProvider({
      id: "provider-b",
      settingsConfig: {
        modelCatalog: { models: [{ model: "new-model" }] },
      },
    });
    const plan = createProvider({
      id: "router",
      name: "Codex MultiRouter",
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "old-model" }],
          spawnAgentModels: ["old-model"],
        },
        codexRouting: {
          enabled: true,
          routes: [
            {
              id: "route-provider-b",
              targetProviderId: "provider-b",
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
    apiMocks.getAll.mockResolvedValue({
      [provider.id]: provider,
      [plan.id]: plan,
    });
    const { result } = renderHook(() => useUpdateProviderMutation("codex"), {
      wrapper,
    });

    let mutationResult:
      | Awaited<ReturnType<typeof result.current.mutateAsync>>
      | undefined;
    await act(async () => {
      mutationResult = await result.current.mutateAsync({ provider });
    });

    expect(apiMocks.getAll).toHaveBeenCalledWith("codex");
    expect(apiMocks.update).toHaveBeenNthCalledWith(
      1,
      provider,
      "codex",
      undefined,
    );
    expect(apiMocks.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: "router",
        settingsConfig: expect.objectContaining({
          modelCatalog: expect.objectContaining({
            spawnAgentModels: [],
          }),
        }),
      }),
      "codex",
    );
    expect(
      mutationResult?.codexMultiRouterSyncResults?.[0]?.removedSpawnAgentModels,
    ).toEqual(["old-model"]);
  });

  it("also invalidates the previous usage query when provider id changes", async () => {
    const { wrapper, invalidateSpy } = createWrapper();
    const provider = createProvider({ id: "provider-new" });
    const { result } = renderHook(() => useUpdateProviderMutation("openclaw"), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        provider,
        originalId: "provider-old",
      });
    });

    expect(apiMocks.update).toHaveBeenCalledWith(
      provider,
      "openclaw",
      "provider-old",
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: usageKeys.script("provider-new", "openclaw"),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: usageKeys.script("provider-old", "openclaw"),
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: usageKeys.all,
    });
  });
});
