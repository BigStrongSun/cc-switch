import { describe, expect, it } from "vitest";
import { resolveManagedAccountId } from "@/lib/authBinding";
import type { ProviderMeta } from "@/types";

describe("resolveManagedAccountId", () => {
  it("uses Codex OAuth shortcut bindings and keeps default-account fallback", () => {
    const defaultCodexMeta: ProviderMeta = {
      providerType: "codex_oauth",
      authBinding: { source: "managed_codex_oauth" },
    };
    const explicitCodexMeta: ProviderMeta = {
      providerType: "codex_oauth",
      authBinding: {
        source: "managed_codex_oauth",
        accountId: "codex-account-1",
      },
    };
    const legacyCodexMeta: ProviderMeta = {
      providerType: "codex_oauth",
      authBinding: {
        source: "managed_codex_oauth",
        account_id: "codex-account-2",
      },
    };

    expect(resolveManagedAccountId(defaultCodexMeta, "codex_oauth")).toBeNull();
    expect(resolveManagedAccountId(explicitCodexMeta, "codex_oauth")).toBe(
      "codex-account-1",
    );
    expect(resolveManagedAccountId(legacyCodexMeta, "codex_oauth")).toBe(
      "codex-account-2",
    );
  });

  it("requires provider matches for generic managed account bindings", () => {
    const codexMeta: ProviderMeta = {
      authBinding: {
        source: "managed_account",
        authProvider: "codex_oauth",
        accountId: "codex-account-1",
      },
    };

    expect(resolveManagedAccountId(codexMeta, "codex_oauth")).toBe(
      "codex-account-1",
    );
    expect(resolveManagedAccountId(codexMeta, "github_copilot")).toBeNull();
  });
});
