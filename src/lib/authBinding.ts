import type { ProviderMeta } from "@/types";

export function resolveManagedAccountId(
  meta: ProviderMeta | undefined,
  authProvider: string,
): string | null {
  const binding = meta?.authBinding;
  const accountId = binding?.accountId ?? binding?.account_id ?? null;

  // Codex MultiRouter 的 OpenAI 子路由会把 OAuth 绑定写成 managed_codex_oauth 简写。
  // 这里返回 null 时后端会回退到默认账号，避免无 accountId 的旧配置丢失额度查询。
  if (
    authProvider === "codex_oauth" &&
    binding?.source === "managed_codex_oauth"
  ) {
    return accountId;
  }

  // 其他自管账号仍然要求显式匹配 authProvider，防止不同账号体系互相串用。
  if (
    binding?.source === "managed_account" &&
    binding.authProvider === authProvider
  ) {
    return accountId;
  }

  if (authProvider === "github_copilot") {
    return meta?.githubAccountId ?? null;
  }

  return null;
}
