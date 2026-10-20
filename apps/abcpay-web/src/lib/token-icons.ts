/** Cashtab / eTokens icon CDN (same host Cashtab uses via VITE_TOKEN_ICONS_URL). */
export const TOKEN_ICONS_BASE_URL = 'https://icons.etokens.cash';
export const TOKEN_ICONS_CACHE = 'abcpay-token-icons-v1';
export const TOKEN_ICON_FALLBACK = '/currencies/eToken.svg';

export type TokenIconSize = 32 | 64 | 128 | 256 | 512;

const memory = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function tokenIconUrl(tokenId: string, size: TokenIconSize = 64): string {
  const id = tokenId.trim().toLowerCase();
  return `${TOKEN_ICONS_BASE_URL}/${size}/${id}.png`;
}

function cacheKey(tokenId: string, size: TokenIconSize): string {
  return `${size}:${tokenId.trim().toLowerCase()}`;
}

async function responseToObjectUrl(response: Response): Promise<string> {
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('empty token icon');
  // Some browsers omit type on Cache API blobs; still treat PNG bytes as image.
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('invalid token icon');
  return URL.createObjectURL(blob);
}

/**
 * Resolve a displayable token icon URL, preferring Cache API → network → fallback.
 * Successful fetches are stored in `abcpay-token-icons-v1` for later / offline use.
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

  const task = (async () => {
    const url = tokenIconUrl(id, size);
    try {
      if (typeof caches === 'undefined') {
        memory.set(key, url);
        return url;
      }
      const cache = await caches.open(TOKEN_ICONS_CACHE);
      const cached = await cache.match(url);
      if (cached) {
        const objectUrl = await responseToObjectUrl(cached);
        memory.set(key, objectUrl);
        return objectUrl;
      }
      const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error(`icon ${res.status}`);
      try {
        await cache.put(url, res.clone());
      } catch {
        // Quota / private mode — still use the image this session.
      }
      const objectUrl = await responseToObjectUrl(res);
      memory.set(key, objectUrl);
      return objectUrl;
    } catch {
      memory.set(key, TOKEN_ICON_FALLBACK);
      return TOKEN_ICON_FALLBACK;
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
