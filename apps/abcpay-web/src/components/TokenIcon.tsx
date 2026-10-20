import { useEffect, useState } from 'react';
import {
  TOKEN_ICON_FALLBACK,
  loadTokenIcon,
  tokenIconUrl,
  type TokenIconSize
} from '../lib/token-icons';

export function TokenIcon({
  tokenId,
  size = 64,
  className = 'w-5 h-5'
}: {
  tokenId: string;
  size?: TokenIconSize;
  className?: string;
}) {
  // Start with the same-origin proxy URL so Brave can paint immediately
  // without waiting on a JS fetch that Shields may block.
  const [src, setSrc] = useState(() => tokenIconUrl(tokenId, size));

  useEffect(() => {
    let cancelled = false;
    const direct = tokenIconUrl(tokenId, size);
    setSrc(direct);
    void loadTokenIcon(tokenId, size).then(url => {
      if (!cancelled && url !== direct) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [tokenId, size]);

  return (
    <img
      src={src}
      alt=""
      className={`rounded-full shrink-0 object-cover bg-black/20 ${className}`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (src !== TOKEN_ICON_FALLBACK) setSrc(TOKEN_ICON_FALLBACK);
      }}
    />
  );
}
