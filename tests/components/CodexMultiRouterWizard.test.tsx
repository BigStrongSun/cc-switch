import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { Provider } from "@/types";
import { CodexMultiRouterWizard } from "@/components/codex/CodexMultiRouterWizard";
import { CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY } from "@/lib/codexMultiRouterWizard";
import { providersApi } from "@/lib/api/providers";
import {
  fetchModelsForConfig,
  probeCodexResponsesForConfig,
} from "@/lib/api/model-fetch";

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    add: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  probeCodexResponsesForConfig: vi.fn(),
}));

// 构造最小 Codex provider，避免 UI 测试依赖真实数据库返回结构。
function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: overrides.id ?? "deepseek",
    name: overrides.name ?? "DeepSeek",
    category: overrides.category,
    settingsConfig: overrides.settingsConfig ?? {
      base_url: "https://api.deepseek.com/v1",
      auth: { OPENAI_API_KEY: "sk-test" },
      modelCatalog: { models: [{ model: "deepseek-chat" }] },
    },
    meta: overrides.meta,
  };
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("CodexMultiRouterWizard", () => {
  it("explains the first step with user-facing guidance before technical details", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    expect(screen.getByText("这套向导会帮你完成 4 件事")).toBeInTheDocument();
    expect(screen.getByText(/你不用手动改配置文件/)).toBeInTheDocument();
    expect(
      screen.getByText(/技术备注：Codex 最后仍只连接本机/),
    ).toBeInTheDocument();
  });

  it("opens, navigates steps, and stores dismissed flag when skipped", () => {
    const onOpenChange = vi.fn();

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={onOpenChange}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    expect(screen.getAllByText("理解 MultiRouter").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getAllByText("创建模型源").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    expect(localStorage.getItem(CODEX_MULTI_ROUTER_WIZARD_DISMISSED_KEY)).toBe(
      "true",
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not reset to the intro step when parent rerenders with a new providers array", () => {
    const deepseekProvider = provider();
    const { rerender } = renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[deepseekProvider]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(
      screen.getByText(/当前识别到 1 个普通 Codex provider/),
    ).toBeInTheDocument();

    rerender(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <CodexMultiRouterWizard
          open
          providers={[{ ...deepseekProvider }]}
          onOpenChange={vi.fn()}
          onCreateProvider={vi.fn()}
          onOpenWorkspace={vi.fn()}
          onEnablePlan={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByText(/当前识别到 1 个普通 Codex provider/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("这套向导会帮你完成 4 件事"),
    ).not.toBeInTheDocument();
  });

  it("marks catalog-only providers as continuable instead of requiring full config", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[
          provider({
            id: "catalog-only",
            name: "Catalog Only",
            settingsConfig: {
              modelCatalog: { models: [{ model: "manual-model" }] },
            },
          }),
        ]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "配置核心参数" }));

    expect(screen.getByText("已有模型目录，可继续")).toBeInTheDocument();
    expect(screen.queryByText("需补全配置")).not.toBeInTheDocument();
  });

  it("stays in needSources state when advancing without model sources", () => {
    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByText("状态机：needSources")).toBeInTheDocument();
    expect(screen.getByText(/请先添加一个普通 Codex/)).toBeInTheDocument();
  });

  it("moves to saveFailed state when publishing the generated plan fails", async () => {
    vi.mocked(providersApi.add).mockRejectedValueOnce(new Error("db locked"));

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    const publishButtons = screen.getAllByRole("button", {
      name: "保存并发布",
    });
    fireEvent.click(publishButtons[publishButtons.length - 1]);

    expect(await screen.findByText("状态机：saveFailed")).toBeInTheDocument();
    expect(screen.getByText("MultiRouter 保存失败")).toBeInTheDocument();
    expect(screen.getAllByText("db locked").length).toBeGreaterThan(0);
  });

  it("probes /v1/responses connectivity and records pass state", async () => {
    vi.mocked(probeCodexResponsesForConfig).mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "https://api.deepseek.com/v1/responses",
      model: "deepseek-chat",
      detail: "ok",
    });

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    fireEvent.click(
      screen.getByRole("button", { name: "测试 /v1/responses 连通性" }),
    );

    expect(
      await screen.findByText("状态机：connectivityPassed"),
    ).toBeInTheDocument();
    expect(probeCodexResponsesForConfig).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1",
      "sk-test",
      "deepseek-chat",
      false,
      undefined,
    );
  });

  it("shows fetched model exceptions in the wizard issue panel", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.mocked(fetchModelsForConfig).mockRejectedValueOnce(
      new Error("upstream /models timeout"),
    );

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    fireEvent.click(
      screen.getByRole("button", { name: "自动获取并写入模型列表" }),
    );

    expect(await screen.findByText("模型列表获取失败")).toBeInTheDocument();
    expect(screen.getByText("upstream /models timeout")).toBeInTheDocument();
    expect(screen.getByText("可继续")).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("shows responses probe command exceptions and blocks continuation", async () => {
    vi.mocked(probeCodexResponsesForConfig).mockRejectedValueOnce(
      new Error("ipc invoke failed"),
    );

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider({ meta: { apiFormat: "openai_responses" } })]}
        onOpenChange={vi.fn()}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    fireEvent.click(
      screen.getByRole("button", { name: "测试 /v1/responses 连通性" }),
    );

    expect(
      await screen.findByText("Responses 探测命令异常"),
    ).toBeInTheDocument();
    expect(screen.getByText("ipc invoke failed")).toBeInTheDocument();
    expect(screen.getByText("需处理后继续")).toBeInTheDocument();
    expect(screen.getByText("状态机：connectivityFailed")).toBeInTheDocument();
  });

  it("closes the overlay after enabling so the status-page handoff can continue", async () => {
    const onOpenChange = vi.fn();
    const onEnablePlan = vi.fn().mockResolvedValue(undefined);

    renderWithQueryClient(
      <CodexMultiRouterWizard
        open
        providers={[provider()]}
        onOpenChange={onOpenChange}
        onCreateProvider={vi.fn()}
        onOpenWorkspace={vi.fn()}
        onEnablePlan={onEnablePlan}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存并发布" }));
    const publishButtons = screen.getAllByRole("button", {
      name: "保存并发布",
    });
    fireEvent.click(publishButtons[publishButtons.length - 1]);

    expect(
      await screen.findByText(/启用成功后向导会自动关闭/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "启用这个多路路由" }));

    expect(onEnablePlan).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("状态机：completed")).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
