import type { TokenBalance } from '@bcpros/abcpay-models';

/**
 * App-level token visibility. Tokens are hidden by default everywhere;
 * the user opts individual tokens in from Settings (per app, not per
 * account). Only tokenIds explicitly listed are shown.
 */
export interface TokenVisibilitySettings {
  visibleTokenIds: string[];
}

export const DEFAULT_TOKEN_VISIBILITY: TokenVisibilitySettings = { visibleTokenIds: [] };

export function isTokenVisible(settings: TokenVisibilitySettings, tokenId: string): boolean {
  return settings.visibleTokenIds.includes(tokenId);
}

export function visibleTokens<T extends Pick<TokenBalance, 'tokenId'>>(
  tokens: readonly T[],
  settings: TokenVisibilitySettings
): T[] {
  return tokens.filter(t => isTokenVisible(settings, t.tokenId));
}

export function hiddenTokenCount<T extends Pick<TokenBalance, 'tokenId'>>(
  tokens: readonly T[],
  settings: TokenVisibilitySettings
): number {
  return tokens.length - visibleTokens(tokens, settings).length;
}

export function withTokenVisibility(
  settings: TokenVisibilitySettings,
  tokenId: string,
  visible: boolean
): TokenVisibilitySettings {
  const next = new Set(settings.visibleTokenIds);
  if (visible) next.add(tokenId);
  else next.delete(tokenId);
  return { visibleTokenIds: [...next].sort() };
}
