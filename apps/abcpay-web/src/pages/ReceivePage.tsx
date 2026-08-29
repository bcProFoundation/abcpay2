import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { getReceiveAddress, deserializeWallet } from '../lib/bwc';
import { useWallets } from '../context/WalletContext';

export function ReceivePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { wallets, getWalletCredentials } = useWallets();
  const wallet = wallets.find(w => w.id === id);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!wallet || !id) return;

    const creds = getWalletCredentials(id);
    if (!creds) {
      setError('Wallet credentials not found');
      setLoading(false);
      return;
    }

    getReceiveAddress(deserializeWallet(creds))
      .then(setAddress)
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [wallet, id, getWalletCredentials]);

  if (!wallet) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <p className="text-[var(--abcpay-muted)]">Wallet not found</p>
      </div>
    );
  }

  const config = COIN_CONFIGS[wallet.coin];

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10 flex items-center">
        <button onClick={() => navigate(-1)} className="p-2 text-[var(--abcpay-muted)]">
          ← Back
        </button>
        <h1 className="text-lg font-medium flex-1 text-center pr-10">Receive {config.unitName}</h1>
      </header>

      <div className="px-4 py-8 text-center">
        {loading && <p className="text-[var(--abcpay-muted)]">Generating address...</p>}
        {error && <p className="text-red-400">{error}</p>}

        {address && (
          <>
            <div className="inline-block p-4 bg-white rounded-2xl mb-6">
              <QRCodeSVG value={address} size={200} />
            </div>
            <p className="text-sm text-[var(--abcpay-muted)] mb-2">Your receiving address</p>
            <p className="font-mono text-sm break-all px-4 mb-6">{address}</p>
            <button
              onClick={() => navigator.clipboard.writeText(address)}
              className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl font-medium"
            >
              Copy Address
            </button>
          </>
        )}
      </div>
    </div>
  );
}
