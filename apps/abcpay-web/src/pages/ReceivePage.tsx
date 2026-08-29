import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { useWallets } from '../context/WalletContext';
import { api } from '../lib/api';

export function ReceivePage() {
  const { id } = useParams<{ id: string }>();
  const { wallets, authFor } = useWallets();
  const wallet = wallets.find(w => w.id === id);
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const auth = id ? authFor(id) : undefined;
    if (!auth) return;
    void api
      .getMainAddress(auth)
      .then(a => setAddress(a.address))
      .catch(err => setError((err as Error).message));
  }, [id, authFor]);

  if (!wallet) {
    return <p className="p-8 text-center text-[var(--abcpay-muted)]">Wallet not found</p>;
  }

  const config = COIN_CONFIGS[wallet.coin];

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Receive {config.unitName}</h1>
      </header>
      <div className="px-4 py-8 flex flex-col items-center">
        <div className="bg-white p-4 rounded-2xl mb-6">
          {address ? <QRCodeSVG value={address} size={220} /> : <div className="w-[220px] h-[220px]" />}
        </div>
        <p className="font-mono text-sm break-all text-center mb-4 px-2">{address || 'Generating address…'}</p>
        <button
          type="button"
          disabled={!address}
          onClick={async () => {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl"
        >
          {copied ? 'Copied' : 'Copy address'}
        </button>
        {error && <p className="text-red-400 text-sm mt-4">{error}</p>}
      </div>
    </div>
  );
}
