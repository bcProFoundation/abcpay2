import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode';
import { validateAddress } from '@bcpros/abcpay-wallet-core';
import { useWallets } from '../context/WalletContext';

function parsePayload(
  raw: string
): { kind: 'address' | 'wallet'; value: string; amount?: string; coin?: 'xec' | 'doge' } | null {
  const text = raw.trim();
  if (/^[a-f0-9]{32}$/i.test(text)) return { kind: 'wallet', value: text };

  try {
    const url = new URL(text.includes(':') && !text.startsWith('http') ? text.replace(/^([^:]+):/, '$1://') : text);
    const amount = url.searchParams.get('amount') ?? undefined;
    const hostAndPath = `${url.hostname}${url.pathname}`.replace(/^\/*/, '');
    const address = text.includes('?') ? text.split('?')[0] : text;
    if (validateAddress('xec', address) || text.startsWith('ecash:')) {
      return { kind: 'address', value: address, amount, coin: 'xec' };
    }
    if (validateAddress('doge', hostAndPath) || text.startsWith('dogecoin:')) {
      return { kind: 'address', value: hostAndPath, amount, coin: 'doge' };
    }
  } catch {
    if (validateAddress('xec', text)) return { kind: 'address', value: text, coin: 'xec' };
    if (validateAddress('doge', text)) return { kind: 'address', value: text, coin: 'doge' };
  }
  return null;
}

async function stopScanner(qr: Html5Qrcode): Promise<void> {
  try {
    // Do not call clear() here: it throws while SCANNING if stop() has not
    // finished, and that uncaught cleanup error blanked the other tabs.
    if (qr.getState() !== Html5QrcodeScannerState.NOT_STARTED) {
      await qr.stop();
    }
  } catch {
    // Already stopped / never started / camera revoked.
  }
}

export function ScanPage() {
  const navigate = useNavigate();
  const { wallets } = useWallets();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  // Unique id per mount so React StrictMode remounts do not share a stale scanner DOM.
  const reactId = useId().replace(/:/g, '');
  const regionId = `abcpay-qr-reader-${reactId}`;
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;
  const navigatingRef = useRef(false);

  function handlePayload(raw: string) {
    const parsed = parsePayload(raw);
    if (!parsed) {
      setError('Unrecognized QR payload');
      return;
    }
    if (parsed.kind === 'wallet') {
      navigatingRef.current = true;
      navigate(`/join-wallet?walletId=${parsed.value}`);
      return;
    }
    const list = walletsRef.current;
    const wallet =
      list.find(w => (parsed.coin ? w.coin === parsed.coin : true) && w.status === 'complete') ?? list[0];
    if (!wallet) {
      setError('Create a wallet first');
      return;
    }
    const qs = new URLSearchParams({ to: parsed.value });
    if (parsed.amount) qs.set('amount', parsed.amount);
    navigatingRef.current = true;
    navigate(`/wallet/${wallet.id}/send?${qs.toString()}`);
  }

  useEffect(() => {
    let cancelled = false;
    const qr = new Html5Qrcode(regionId);

    const start = async () => {
      try {
        await qr.start(
          { facingMode: 'environment' },
          { fps: 8, qrbox: 220 },
          (decoded: string) => {
            if (cancelled || navigatingRef.current) return;
            navigatingRef.current = true;
            void (async () => {
              await stopScanner(qr);
              if (!cancelled) handlePayload(decoded);
            })();
          },
          () => undefined
        );
        // Tab switched away while getUserMedia was still starting.
        if (cancelled) {
          await stopScanner(qr);
        }
      } catch {
        if (!cancelled) {
          setError('Camera unavailable. Paste an address or wallet ID below.');
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      // Await stop in cleanup without calling clear() — clear() races stop() and
      // throws ("Cannot clear while scan is ongoing"), which blanked other tabs.
      void stopScanner(qr);
    };
    // regionId is stable for this mount; wallets read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regionId]);

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Scan QR Code</h1>
      </header>
      <div className="px-4 py-6">
        <div id={regionId} className="w-full overflow-hidden rounded-2xl bg-black aspect-square mb-6" />
        <p className="text-sm text-[var(--abcpay-muted)] mb-3">Or paste an address / wallet ID below</p>
        <input
          value={manual}
          onChange={e => setManual(e.target.value)}
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 font-mono text-sm mb-3 outline-none focus:border-[var(--abcpay-accent)]"
        />
        <button
          type="button"
          onClick={() => handlePayload(manual)}
          className="w-full py-3 bg-[var(--abcpay-accent)] rounded-xl"
        >
          Continue
        </button>
        {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      </div>
    </div>
  );
}
