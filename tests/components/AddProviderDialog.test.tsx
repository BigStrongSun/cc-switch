import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AddProviderDialog,
  buildSplitCodexProviderData,
} from "@/components/providers/AddProviderDialog";
import type { Provider } from "@/types";
import type { ProviderFormValues } from "@/components/providers/forms/ProviderForm";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

let mockFormValues: ProviderFormValues;

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    onSubmit,
  }: {
    onSubmit: (values: ProviderFormValues) => void;
  }) => {
    return (
      <form
        id="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(mockFormValues);
        }}
      />
    );
  },
}));

describe("AddProviderDialog", () => {
  beforeEach(() => {
    mockFormValues = {
      name: "Test Provider",
      websiteUrl: "https://provider.example.com",
      settingsConfig: JSON.stringify({ env: {}, config: {} }),
      meta: {
        custom_endpoints: {
          "https://api.new-endpoint.com": {
            url: "https://api.new-endpoint.com",
            addedAt: 1,
          },
        },
      },
    };
  });

  it("使用 ProviderForm 返回的自定义端点", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);
    const handleOpenChange = vi.fn();

    render(
      <AddProviderDialog
        open
        onOpenChange={handleOpenChange}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.meta?.custom_endpoints).toEqual(
      mockFormValues.meta?.custom_endpoints,
    );
    expect(handleOpenChange).toHaveBeenCalledWith(false);
  });

  it("在缺少自定义端点时回退到配置中的 baseUrl", async () => {
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    mockFormValues = {
      name: "Base URL Provider",
      websiteUrl: "",
      settingsConfig: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "https://claude.base" },
        config: {},
      }),
    };

    render(
      <AddProviderDialog
        open
        onOpenChange={vi.fn()}
        appId="claude"
        onSubmit={handleSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "common.add",
      }),
    );

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));

    const submitted = handleSubmit.mock.calls[0][0];
    expect(submitted.meta?.custom_endpoints).toEqual({
      "https://claude.base": {
        url: "https://claude.base",
        addedAt: expect.any(Number),
        lastUsed: undefined,
      },
    });
  });

  it("确认 Codex 混合协议拆分后构造两个 provider", () => {
    const split = {
      providerName: "Relay",
      responsesModels: ["gpt-5.5"],
      chatModels: ["qwen3.6"],
    };
    const providerData: Omit<Provider, "id"> = {
      name: "Relay",
      websiteUrl: "https://relay.example",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "sk-relay" },
        config: 'model = "gpt-5.5"\nwire_api = "responses"',
        modelCatalog: {
          models: [
            {
              model: "gpt-5.5",
              upstreamModel: "gpt-5.5",
              displayName: "GPT",
            },
            {
              model: "qwen3.6",
              upstreamModel: "qwen3.6",
              displayName: "Qwen",
            },
          ],
          spawnAgentModels: ["gpt-5.5", "qwen3.6"],
        },
      },
      meta: { apiFormat: "openai_responses" },
    };

    const responsesProvider = buildSplitCodexProviderData(
      providerData,
      split,
      "responses",
    );
    const chatProvider = buildSplitCodexProviderData(
      providerData,
      split,
      "chat",
    );

    expect(responsesProvider).toMatchObject({
      name: "Relay-responses",
      meta: { apiFormat: "openai_responses" },
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "gpt-5.5" }],
          spawnAgentModels: ["gpt-5.5"],
        },
      },
    });
    expect(chatProvider).toMatchObject({
      name: "Relay-chat",
      meta: { apiFormat: "openai_chat" },
      settingsConfig: {
        modelCatalog: {
          models: [{ model: "qwen3.6" }],
          spawnAgentModels: ["qwen3.6"],
        },
      },
    });
  });
});
