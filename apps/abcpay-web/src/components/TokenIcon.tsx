import { useEffect, useState } from 'react';
import {
  TOKEN_ICON_FALLBACK,
  loadTokenIcon,
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
  const [src, setSrc] = useState(TOKEN_ICON_FALLBACK);

  useEffect(() => {
    let cancelled = false;
    setSrc(TOKEN_ICON_FALLBACK);
    void loadTokenIcon(tokenId, size).then(url => {
      if (!cancelled) setSrc(url);
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
      onError={() => setSrc(TOKEN_ICON_FALLBACK)}
    />
  );
}
