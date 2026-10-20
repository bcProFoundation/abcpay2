/**
 * Token icons come from Cashtab's CDN (icons.etokens.cash) but are served
 * same-origin via `/token-icons/...` (web proxy / Vite proxy). Brave Shields
 * often block direct third-party fetches/images to that host on desktop.
 */
export const TOKEN_ICONS_CDN = 'https://icons.etokens.cash';
export const TOKEN_ICONS_CACHE = 'abcpay-token-icons-v1';
export const TOKEN_ICON_FALLBACK = '/currencies/eToken.svg';

export type TokenIconSize = 32 | 64 | 128 | 256 | 512;

const memory = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** Same-origin display URL (proxied to Cashtab). */
export function tokenIconUrl(tokenId: string, size: TokenIconSize = 64): string {
  const id = tokenId.trim().toLowerCase();
  return `/token-icons/${size}/${id}.png`;
}

function cacheKey(tokenId: string, size: TokenIconSize): string {
  return `${size}:${tokenId.trim().toLowerCase()}`;
}

async function responseToObjectUrl(response: Response): Promise<string> {
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('empty token icon');
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('invalid token icon');
  return URL.createObjectURL(blob);
}

/**
 * Resolve a displayable token icon URL.
 * Prefers Cache API blob → same-origin proxy URL (works under Brave Shields).
 */
export async function loadTokenIcon(
  tokenId: string,
  size: TokenIconSize = 64
): Promise<string> {
  const id = tokenId.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return TOKEN_ICON_FALLBACK;

  const key = cacheKey(id, size);
  const hit = memory.get(key);
  if (hit) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const localUrl = tokenIconUrl(id, size);

  const task = (async () => {
    try {
      if (typeof caches === 'undefined') {
        memory.set(key, localUrl);
        return localUrl;
      }
      const cache = await caches.open(TOKEN_ICONS_CACHE);
      const cached = await cache.match(localUrl);
      if (cached) {
        const objectUrl = await responseToObjectUrl(cached);
        memory.set(key, objectUrl);
        return objectUrl;
      }
      const res = await fetch(localUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`icon ${res.status}`);
      try {
        await cache.put(localUrl, res.clone());
      } catch {
        // Quota / private mode — still use the image this session.
      }
      const objectUrl = await responseToObjectUrl(res);
      memory.set(key, objectUrl);
      return objectUrl;
    } catch {
      // Fall back to the same-origin proxy URL so <img> can still try;
      // TokenIcon.onError will swap to eToken.svg if that fails too.
      memory.set(key, localUrl);
      return localUrl;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/** Warm the icon cache for a set of token ids (e.g. after balance discovery). */
export function prefetchTokenIcons(
  tokenIds: Iterable<string>,
  size: TokenIconSize = 64
): void {
  for (const tokenId of tokenIds) {
    void loadTokenIcon(tokenId, size);
  }
}
