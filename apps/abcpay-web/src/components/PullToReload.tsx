import { useEffect, useRef, useState, type CSSProperties } from 'react';

const PULL_THRESHOLD_PX = 72;
const PULL_MAX_PX = 112;
const PULL_RESISTANCE = 0.42;

function pageScrollTop(): number {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

async function hardReload(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    // Still reload even if SW update fails.
  }
  window.location.reload();
}

/**
 * iOS standalone PWAs do not get Safari's native pull-to-refresh.
 * This adds a top-of-page pull gesture that hard-reloads (new build + balances).
 */
export function PullToReload() {
  const [pullPx, setPullPx] = useState(0);
  const [reloading, setReloading] = useState(false);
  const startYRef = useRef<number | null>(null);
  const pullPxRef = useRef(0);
  const trackingRef = useRef(false);

  useEffect(() => {
    pullPxRef.current = pullPx;
  }, [pullPx]);

  useEffect(() => {
    const reset = () => {
      trackingRef.current = false;
      startYRef.current = null;
      pullPxRef.current = 0;
      setPullPx(0);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (reloading) return;
      if (event.touches.length !== 1) return;
      if (pageScrollTop() > 1) {
        reset();
        return;
      }
      startYRef.current = event.touches[0].clientY;
      trackingRef.current = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (reloading) return;
      const startY = startYRef.current;
      if (startY == null) return;

      if (pageScrollTop() > 1) {
        reset();
        return;
      }

      const dy = event.touches[0].clientY - startY;
      if (dy <= 0) {
        if (trackingRef.current) reset();
        return;
      }

      const dist = Math.min(PULL_MAX_PX, dy * PULL_RESISTANCE);
      trackingRef.current = true;
      pullPxRef.current = dist;
      setPullPx(dist);

      // Own the overscroll so iOS rubber-banding does not swallow the gesture.
      if (event.cancelable) event.preventDefault();
    };

    const onTouchEnd = () => {
      if (reloading) return;
      if (!trackingRef.current) {
        reset();
        return;
      }
      const dist = pullPxRef.current;
      if (dist >= PULL_THRESHOLD_PX) {
        setReloading(true);
        setPullPx(PULL_THRESHOLD_PX);
        void hardReload();
        return;
      }
      reset();
    };

    const onTouchCancel = () => {
      if (!reloading) reset();
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [reloading]);

  const visible = pullPx > 4 || reloading;
  const progress = Math.min(1, pullPx / PULL_THRESHOLD_PX);
  const armed = pullPx >= PULL_THRESHOLD_PX || reloading;

  return (
    <div
      className={`ptr-indicator${visible ? ' is-visible' : ''}${armed ? ' is-armed' : ''}${
        reloading ? ' is-reloading' : ''
      }`}
      style={{ '--ptr-pull': `${pullPx}px`, '--ptr-progress': String(progress) } as CSSProperties}
      aria-hidden={!visible}
    >
      <div className="ptr-indicator-inner">
        <svg className="ptr-spinner" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray="40"
            strokeDashoffset={40 - 40 * (reloading ? 0.65 : progress)}
          />
        </svg>
        <span className="ptr-label">{reloading ? 'Reloading…' : armed ? 'Release to reload' : 'Pull to reload'}</span>
      </div>
    </div>
  );
}
