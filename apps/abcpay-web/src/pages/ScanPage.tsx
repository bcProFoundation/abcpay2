import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Html5Qrcode } from 'html5-qrcode';
import { validateAddress } from '@bcpros/abcpay-wallet-core';
import { useWallets } from '../context/WalletContext';

function parsePayload(raw: string): { kind: 'address' | 'wallet'; value: string; amount?: string; coin?: 'xec' | 'doge' } | null {
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

export function ScanPage() {
  const navigate = useNavigate();
  const { wallets } = useWallets();
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  const regionId = 'abcpay-qr-reader';
  const scanner = useRef<Html5Qrcode | null>(null);

  function handlePayload(raw: string) {
    const parsed = parsePayload(raw);
    if (!parsed) {
      setError('Unrecognized QR payload');
      return;
    }
    if (parsed.kind === 'wallet') {
      navigate(`/join-wallet?walletId=${parsed.value}`);
      return;
    }
    const wallet = wallets.find(w => (parsed.coin ? w.coin === parsed.coin : true) && w.status === 'complete') ?? wallets[0];
    if (!wallet) {
      setError('Create a wallet first');
      return;
    }
    const qs = new URLSearchParams({ to: parsed.value });
    if (parsed.amount) qs.set('amount', parsed.amount);
    navigate(`/wallet/${wallet.id}/send?${qs.toString()}`);
  }

  useEffect(() => {
    const qr = new Html5Qrcode(regionId);
    scanner.current = qr;
    qr.start(
      { facingMode: 'environment' },
      { fps: 8, qrbox: 220 },
      (decoded: string) => {
        void qr.stop().catch(() => undefined);
        handlePayload(decoded);
      },
      () => undefined
    ).catch(() => {
      setError('Camera unavailable. Paste an address or wallet ID below.');
    });
    return () => {
      void qr.stop().catch(() => undefined);
      qr.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Scan QR Code</h1>
      </header>
      <div className="px-4 py-6">
        <div id={regionId} className="w-full overflow-hidden rounded-2xl bg-black aspect-square mb-6" />
        <p className="text-sm text-[var(--abcpay-muted)] mb-3">Or paste an address / wallet ID</p>
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
