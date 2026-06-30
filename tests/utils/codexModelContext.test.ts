import { describe, expect, it } from "vitest";
import { resolveFetchedCodexModelContextWindow } from "@/utils/codexModelContext";

describe("Codex model context inference", () => {
  it("prefers explicit context windows returned by the remote /models endpoint", () => {
    expect(
      resolveFetchedCodexModelContextWindow(
        { id: "deepseek-chat", contextWindow: 128000 },
        { baseUrl: "https://api.deepseek.com" },
      ),
    ).toBe(128000);
  });

  it("preserves an existing user catalog context when the remote model has no context", () => {
    expect(
      resolveFetchedCodexModelContextWindow(
        { id: "deepseek-v4-flash" },
        {
          baseUrl: "https://api.deepseek.com",
          existingModels: [
            { model: "deepseek-v4-flash", contextWindow: 640000 },
          ],
        },
      ),
    ).toBe(640000);
  });

  it("fills DeepSeek preset contexts when the remote /models endpoint only returns ids", () => {
    expect(
      resolveFetchedCodexModelContextWindow(
        { id: "deepseek-v4-flash" },
        { providerName: "DeepSeek", baseUrl: "https://api.deepseek.com" },
      ),
    ).toBe(1000000);
  });

  it("fills DeepSeek compatible alias contexts from local provider knowledge", () => {
    expect(
      resolveFetchedCodexModelContextWindow(
        { id: "deepseek-reasoner" },
        { providerName: "DeepSeek", baseUrl: "https://api.deepseek.com" },
      ),
    ).toBe(1000000);
  });

  it("does not invent a context window for unknown third-party models", () => {
    expect(
      resolveFetchedCodexModelContextWindow(
        { id: "vendor-custom-model" },
        { baseUrl: "https://example.com/v1" },
      ),
    ).toBeUndefined();
  });
});
