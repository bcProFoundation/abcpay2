import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useWallets } from '../context/WalletContext';

const SOFT_THRESHOLD_PX = 64;
const HARD_THRESHOLD_PX = 118;
const PULL_MAX_PX = 140;
const PULL_RESISTANCE = 0.42;
const UPDATE_CHECK_MS = 2000;

type PtrPhase = 'idle' | 'pulling' | 'checking' | 'refreshing' | 'uptodate' | 'reloading';

function pageScrollTop(): number {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function currentBundleName(): string | null {
  for (const script of document.scripts) {
    const match = script.src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (match) return match[1];
  }
  return null;
}

/** Fast no-cache HTML peek — true when the deployed JS bundle hash changed. */
async function hasNewWebBuild(): Promise<boolean> {
  const current = currentBundleName();
  if (!current) return false;
  try {
    const res = await fetch(`/?_ptr=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'text/html' }
    });
    if (!res.ok) return false;
    const html = await res.text();
    const match = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
    if (!match) return false;
    return match[1] !== current;
  } catch {
    return false;
  }
}

async function requestServiceWorkerUpdate(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update();
  } catch {
    // ignore
  }
}

function forceReload(): void {
  // Kick SW update in the background; don't wait — user asked for a full reload.
  void requestServiceWorkerUpdate();
  window.location.reload();
}

function ptrLabel(phase: PtrPhase, pullPx: number): string {
  if (phase === 'checking') return 'Checking for updates…';
  if (phase === 'refreshing') return 'Refreshing balances…';
  if (phase === 'uptodate') return 'Up to date';
  if (phase === 'reloading') return 'Reloading…';
  if (pullPx >= HARD_THRESHOLD_PX) return 'Release to force reload';
  if (pullPx >= SOFT_THRESHOLD_PX) return 'Release to check for updates';
  return 'Pull to check';
}

/**
 * Two-stage pull-to-reload for iOS standalone PWAs (no native Safari PTR):
 * - Short pull: peek for a new web build; reload only if one exists, else soft-refresh balances
 * - Long pull: force a full page reload immediately
 */
export function PullToReload() {
  const { refreshBalances } = useWallets();
  const [pullPx, setPullPx] = useState(0);
  const [phase, setPhase] = useState<PtrPhase>('idle');
  const startYRef = useRef<number | null>(null);
  const pullPxRef = useRef(0);
  const trackingRef = useRef(false);
  const phaseRef = useRef<PtrPhase>('idle');
  const refreshBalancesRef = useRef(refreshBalances);
  refreshBalancesRef.current = refreshBalances;

  useEffect(() => {
    pullPxRef.current = pullPx;
  }, [pullPx]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const busy = () => {
      const p = phaseRef.current;
      return p === 'checking' || p === 'refreshing' || p === 'uptodate' || p === 'reloading';
    };

    const resetPull = () => {
      trackingRef.current = false;
      startYRef.current = null;
      pullPxRef.current = 0;
      setPullPx(0);
    };

    const runSoftCheck = async () => {
      setPhase('checking');
      setPullPx(SOFT_THRESHOLD_PX);
      const hasUpdate = await Promise.race([
        hasNewWebBuild(),
        sleep(UPDATE_CHECK_MS).then(() => false)
      ]);
      if (hasUpdate) {
        setPhase('reloading');
        await requestServiceWorkerUpdate();
        window.location.reload();
        return;
      }
      setPhase('refreshing');
      try {
        await refreshBalancesRef.current();
      } catch {
        // Balance refresh is best-effort.
      }
      setPhase('uptodate');
      await sleep(700);
      setPhase('idle');
      resetPull();
    };

    const onTouchStart = (event: TouchEvent) => {
      if (busy()) return;
      if (event.touches.length !== 1) return;
      if (pageScrollTop() > 1) {
        resetPull();
        return;
      }
      startYRef.current = event.touches[0].clientY;
      trackingRef.current = false;
      setPhase('pulling');
    };

    const onTouchMove = (event: TouchEvent) => {
      if (busy()) return;
      const startY = startYRef.current;
      if (startY == null) return;

      if (pageScrollTop() > 1) {
        resetPull();
        setPhase('idle');
        return;
      }

      const dy = event.touches[0].clientY - startY;
      if (dy <= 0) {
        if (trackingRef.current) {
          resetPull();
          setPhase('idle');
        }
        return;
      }

      const dist = Math.min(PULL_MAX_PX, dy * PULL_RESISTANCE);
      trackingRef.current = true;
      pullPxRef.current = dist;
      setPullPx(dist);
      setPhase('pulling');

      if (event.cancelable) event.preventDefault();
    };

    const onTouchEnd = () => {
      if (busy()) return;
      if (!trackingRef.current) {
        resetPull();
        setPhase('idle');
        return;
      }
      const dist = pullPxRef.current;
      if (dist >= HARD_THRESHOLD_PX) {
        setPhase('reloading');
        setPullPx(HARD_THRESHOLD_PX);
        forceReload();
        return;
      }
      if (dist >= SOFT_THRESHOLD_PX) {
        trackingRef.current = false;
        startYRef.current = null;
        void runSoftCheck();
        return;
      }
      resetPull();
      setPhase('idle');
    };

    const onTouchCancel = () => {
      if (!busy()) {
        resetPull();
        setPhase('idle');
      }
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
  }, []);

  const active = phase !== 'idle' || pullPx > 4;
  const softArmed = pullPx >= SOFT_THRESHOLD_PX || phase === 'checking' || phase === 'refreshing';
  const hardArmed = pullPx >= HARD_THRESHOLD_PX || phase === 'reloading';
  const spinning =
    phase === 'checking' || phase === 'refreshing' || phase === 'reloading';
  const progress = Math.min(1, pullPx / HARD_THRESHOLD_PX);

  return (
    <div
      className={`ptr-indicator${active ? ' is-visible' : ''}${softArmed ? ' is-armed' : ''}${
        hardArmed ? ' is-force' : ''
      }${spinning ? ' is-reloading' : ''}${phase === 'uptodate' ? ' is-done' : ''}`}
      style={{ '--ptr-pull': `${pullPx}px`, '--ptr-progress': String(progress) } as CSSProperties}
      aria-hidden={!active}
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
            strokeDashoffset={40 - 40 * (spinning ? 0.65 : progress)}
          />
        </svg>
        <span className="ptr-label">{ptrLabel(phase, pullPx)}</span>
      </div>
    </div>
  );
}
