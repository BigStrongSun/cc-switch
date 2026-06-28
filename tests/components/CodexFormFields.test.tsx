import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSplitCodexProviderSuggestionForFetchedModels,
  CodexFormFields,
  splitFetchedModelsByLikelyCodexProtocol,
} from "@/components/providers/forms/CodexFormFields";
import { fetchModelsForConfig } from "@/lib/api/model-fetch";
import type { CodexCatalogModel, CodexRoutingConfig } from "@/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

vi.mock("@/lib/api/model-fetch", () => ({
  fetchModelsForConfig: vi.fn(),
  showFetchModelsError: vi.fn(),
}));

vi.mock("@/components/ui/form", () => ({
  FormLabel: ({ children }: { children: ReactNode }) => (
    <label>{children}</label>
  ),
}));

beforeEach(() => {
  vi.mocked(fetchModelsForConfig).mockReset();
});

function renderRoutingHarness(
  initialRouting?: CodexRoutingConfig,
  options: { shouldShowSpeedTest?: boolean } = {},
) {
  const onRoutingChange = vi.fn();
  let latestRouting: CodexRoutingConfig = initialRouting ?? {
    enabled: true,
    defaultRouteId: "",
    routes: [],
  };

  function Harness() {
    const [routing, setRouting] = useState<CodexRoutingConfig>(latestRouting);

    // 测试壳同步保存最新 route 配置，模拟 ProviderForm 对受控字段的回写。
    const handleRoutingChange = (next: CodexRoutingConfig) => {
      latestRouting = next;
      onRoutingChange(next);
      setRouting(next);
    };

    return (
      <CodexFormFields
        codexApiKey="sk-test"
        onApiKeyChange={vi.fn()}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={options.shouldShowSpeedTest ?? true}
        codexBaseUrl="https://api.example.com"
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={true}
        onTakeoverEnabledChange={vi.fn()}
        apiFormat="openai_chat"
        onApiFormatChange={vi.fn()}
        codexRouting={routing}
        onCodexRoutingChange={handleRoutingChange}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  return {
    ...render(<Harness />),
    onRoutingChange,
    latestRouting: () => latestRouting,
  };
}

function renderCatalogHarness(initialCatalog: CodexCatalogModel[]) {
  const onCatalogChange = vi.fn();
  let latestCatalog = initialCatalog;

  function Harness() {
    const [catalog, setCatalog] = useState<CodexCatalogModel[]>(initialCatalog);

    // 测试壳模拟 ProviderForm 对 modelCatalog 的受控回写。
    const handleCatalogChange = (next: CodexCatalogModel[]) => {
      latestCatalog = next;
      onCatalogChange(next);
      setCatalog(next);
    };

    return (
      <CodexFormFields
        providerId="codex-thirdparty"
        codexApiKey="sk-test"
        onApiKeyChange={vi.fn()}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={false}
        codexBaseUrl="https://api.thirdparty.example/v1"
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={true}
        onTakeoverEnabledChange={vi.fn()}
        apiFormat="openai_chat"
        onApiFormatChange={vi.fn()}
        catalogModels={catalog}
        onCatalogModelsChange={handleCatalogChange}
        spawnAgentModels={[]}
        onSpawnAgentModelsChange={vi.fn()}
        codexRouting={{ enabled: false, defaultRouteId: "", routes: [] }}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  return {
    ...render(<Harness />),
    onCatalogChange,
    latestCatalog: () => latestCatalog,
  };
}

function renderAutoSplitHarness() {
  const onCatalogChange = vi.fn();
  const onRoutingChange = vi.fn();
  const onTakeoverEnabledChange = vi.fn();
  const onApiFormatChange = vi.fn();
  const onProviderSplitSuggestionChange = vi.fn();
  let latestRouting: CodexRoutingConfig = {
    enabled: false,
    defaultRouteId: "",
    routes: [],
  };

  function Harness() {
    const [catalog, setCatalog] = useState<CodexCatalogModel[]>([]);
    const [routing, setRouting] = useState<CodexRoutingConfig>(latestRouting);

    /// 测试壳同时接住 catalog 和 routing 回写，模拟第一次配置 provider 时的受控状态。
    const handleCatalogChange = (next: CodexCatalogModel[]) => {
      onCatalogChange(next);
      setCatalog(next);
    };
    const handleRoutingChange = (next: CodexRoutingConfig) => {
      latestRouting = next;
      onRoutingChange(next);
      setRouting(next);
    };

    return (
      <CodexFormFields
        providerId="relay-provider"
        providerName="Relay"
        codexApiKey="sk-relay"
        onApiKeyChange={vi.fn()}
        category="custom"
        shouldShowApiKeyLink={false}
        websiteUrl=""
        shouldShowSpeedTest={false}
        codexBaseUrl="https://relay.example/v1"
        onBaseUrlChange={vi.fn()}
        isFullUrl={false}
        onFullUrlChange={vi.fn()}
        isEndpointModalOpen={false}
        onEndpointModalToggle={vi.fn()}
        autoSelect={false}
        onAutoSelectChange={vi.fn()}
        takeoverEnabled={true}
        onTakeoverEnabledChange={onTakeoverEnabledChange}
        apiFormat="openai_chat"
        onApiFormatChange={onApiFormatChange}
        catalogModels={catalog}
        onCatalogModelsChange={handleCatalogChange}
        spawnAgentModels={[]}
        onSpawnAgentModelsChange={vi.fn()}
        codexRouting={routing}
        onCodexRoutingChange={handleRoutingChange}
        onProviderSplitSuggestionChange={onProviderSplitSuggestionChange}
        speedTestEndpoints={[]}
        customUserAgent=""
        onCustomUserAgentChange={vi.fn()}
        localProxyHeadersOverride=""
        onLocalProxyHeadersOverrideChange={vi.fn()}
        localProxyBodyOverride=""
        onLocalProxyBodyOverrideChange={vi.fn()}
      />
    );
  }

  return {
    ...render(<Harness />),
    latestRouting: () => latestRouting,
    onCatalogChange,
    onRoutingChange,
    onTakeoverEnabledChange,
    onApiFormatChange,
    onProviderSplitSuggestionChange,
  };
}

describe("CodexFormFields local model routing", () => {
  it("classifies fetched relay models into Responses and Chat groups", () => {
    expect(
      splitFetchedModelsByLikelyCodexProtocol([
        { id: "openai/gpt-5.5", ownedBy: null },
        { id: "gpt-5.4-mini", ownedBy: null },
        { id: "qwen3.6", ownedBy: null },
        { id: "deepseek-v4-flash", ownedBy: null },
      ]),
    ).toEqual({
      responses: ["openai/gpt-5.5", "gpt-5.4-mini"],
      chat: ["qwen3.6", "deepseek-v4-flash"],
    });
  });

  it("builds split provider suggestion with -responses and -chat model groups", () => {
    const split = buildSplitCodexProviderSuggestionForFetchedModels({
      providerName: "Relay",
      models: [
        { id: "gpt-5.5", ownedBy: null },
        { id: "qwen3.6", ownedBy: null },
      ],
    });

    expect(split).toMatchObject({
      providerName: "Relay",
      responsesModels: ["gpt-5.5"],
      chatModels: ["qwen3.6"],
    });
  });

  it("prompts before preparing split providers after fetching mixed relay models", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
      { id: "qwen3.6", ownedBy: null, contextWindow: 128000 },
    ]);
    const {
      latestRouting,
      onRoutingChange,
      onTakeoverEnabledChange,
      onApiFormatChange,
      onProviderSplitSuggestionChange,
    } = renderAutoSplitHarness();

    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.fetchModels" }),
    );

    expect(await screen.findByText("检测到混合协议模型")).toBeInTheDocument();
    expect(screen.getByText("Relay-responses")).toBeInTheDocument();
    expect(screen.getByText("Relay-chat")).toBeInTheDocument();
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(latestRouting().routes).toHaveLength(0);

    fireEvent.click(
      screen.getByRole("button", { name: "确认生成两个 provider" }),
    );

    await waitFor(() => {
      expect(onProviderSplitSuggestionChange).toHaveBeenCalledWith(
        expect.objectContaining({
          providerName: "Relay",
          responsesModels: ["gpt-5.5"],
          chatModels: ["qwen3.6"],
        }),
      );
    });
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(latestRouting().routes).toHaveLength(0);
    expect(onTakeoverEnabledChange).toHaveBeenCalledWith(true);
    expect(onApiFormatChange).not.toHaveBeenCalled();
  });

  it("keeps routing and provider split untouched when mixed relay split prompt is cancelled", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
      { id: "qwen3.6", ownedBy: null, contextWindow: 128000 },
    ]);
    const {
      latestRouting,
      onRoutingChange,
      onTakeoverEnabledChange,
      onApiFormatChange,
      onProviderSplitSuggestionChange,
    } = renderAutoSplitHarness();

    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.fetchModels" }),
    );

    expect(await screen.findByText("检测到混合协议模型")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂不拆分" }));

    await waitFor(() => {
      expect(screen.queryByText("检测到混合协议模型")).not.toBeInTheDocument();
    });
    expect(onRoutingChange).not.toHaveBeenCalled();
    expect(onProviderSplitSuggestionChange).toHaveBeenCalledWith(null);
    expect(latestRouting().routes).toHaveLength(0);
    expect(onTakeoverEnabledChange).not.toHaveBeenCalled();
    expect(onApiFormatChange).not.toHaveBeenCalled();
  });

  it("keeps the previous model as upstream when the visible catalog model is renamed", async () => {
    const { latestCatalog } = renderCatalogHarness([
      { model: "gpt-5.5", displayName: "Third-party GPT" },
    ]);

    fireEvent.change(screen.getByLabelText("候选模型名"), {
      target: { value: "gpt-5.5-thirdparty" },
    });

    await waitFor(() => {
      expect(latestCatalog()).toMatchObject([
        {
          model: "gpt-5.5-thirdparty",
          upstreamModel: "gpt-5.5",
        },
      ]);
    });
  });

  it("merges fetched models by upstream model without overwriting a visible alias", async () => {
    vi.mocked(fetchModelsForConfig).mockResolvedValueOnce([
      { id: "gpt-5.5", ownedBy: null, contextWindow: 272000 },
    ]);
    const { latestCatalog } = renderCatalogHarness([
      {
        model: "gpt-5.5-thirdparty",
        upstreamModel: "gpt-5.5",
        displayName: "Third-party GPT",
      },
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "providerForm.fetchModels" }),
    );

    await waitFor(() => {
      expect(latestCatalog()).toEqual([
        {
          model: "gpt-5.5-thirdparty",
          upstreamModel: "gpt-5.5",
          displayName: "Third-party GPT",
          contextWindow: "272000",
        },
      ]);
    });
  });

  it("shows local model routing even when endpoint speed tools are hidden", () => {
    renderRoutingHarness(
      { enabled: false, defaultRouteId: "", routes: [] },
      { shouldShowSpeedTest: false },
    );

    expect(screen.getByText("Codex 多模型路由")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "添加路由" }),
    ).toBeInTheDocument();
  });

  it("adds and edits a route through the dialog without persisting rowId", async () => {
    const { latestRouting } = renderRoutingHarness();

    fireEvent.click(screen.getByRole("button", { name: "添加路由" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(latestRouting().routes).toHaveLength(1);
    });

    fireEvent.change(screen.getByPlaceholderText("路由 ID"), {
      target: { value: "deepseek" },
    });
    fireEvent.change(screen.getByPlaceholderText("路由名称"), {
      target: { value: "DeepSeek" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("匹配模型，多个用英文逗号分隔"),
      {
        target: { value: "deepseek-v4-flash, deepseek-v4-pro" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText("匹配前缀，多个用英文逗号分隔"),
      {
        target: { value: "deepseek-" },
      },
    );
    fireEvent.change(screen.getByPlaceholderText("上游 Base URL"), {
      target: { value: "https://api.deepseek.example" },
    });
    fireEvent.change(screen.getByPlaceholderText("路由 API Key"), {
      target: { value: "sk-route" },
    });
    fireEvent.change(screen.getByPlaceholderText("codex模型=上游模型"), {
      target: { value: "deepseek-v4-flash=deepseek-chat" },
    });

    await waitFor(() => {
      expect(latestRouting().routes?.[0]).toMatchObject({
        id: "deepseek",
        label: "DeepSeek",
        match: {
          models: ["deepseek-v4-flash", "deepseek-v4-pro"],
          prefixes: ["deepseek-"],
        },
        upstream: {
          baseUrl: "https://api.deepseek.example",
          apiKey: "sk-route",
          modelMap: { "deepseek-v4-flash": "deepseek-chat" },
        },
      });
    });
    expect(latestRouting().routes?.[0]).not.toHaveProperty("rowId");
  });

  it("removes a route from the list and writes the shortened routing config", async () => {
    const { latestRouting, container } = renderRoutingHarness({
      enabled: true,
      defaultRouteId: "",
      routes: [
        {
          id: "deepseek",
          label: "DeepSeek",
          enabled: true,
          match: { models: ["deepseek-v4-flash"], prefixes: [] },
          upstream: {
            baseUrl: "https://api.deepseek.example",
            apiFormat: "openai_chat",
            auth: { source: "provider_config" },
          },
          capabilities: { textOnly: true, inputModalities: ["text"] },
        },
      ],
    });

    const deleteButton = container.querySelector('button[title="删除"]');
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    await waitFor(() => {
      expect(latestRouting().routes).toEqual([]);
    });
  });
});
