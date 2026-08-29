import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createCredentials } from '@bcpros/abcpay-wallet-core';
import type { JoinInfo } from '@bcpros/abcpay-models';
import { api } from '../lib/api';
import { useWallets, walletFromResponse, type StoredCredentials } from '../context/WalletContext';

export function JoinWalletPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { addWallet, setPendingMnemonic } = useWallets();
  const [walletId, setWalletId] = useState(params.get('walletId') ?? '');
  const [name, setName] = useState('');
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const id = walletId.trim();
    if (id.length < 16) {
      setInfo(null);
      return;
    }
    void api
      .getJoinInfo(id)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [walletId]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!info) {
      setError('Enter a valid wallet invitation ID');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const creds = createCredentials({
        coin: info.coin,
        isMultisig: info.n > 1,
        usePurpose48: info.n > 1
      });
      const wallet = await api.joinWallet(info.id, {
        name,
        coin: info.coin,
        xPubKey: creds.xPubKey,
        requestPubKey: creds.requestPubKey
      });
      const me = wallet.copayers.find(c => c.xPubKey === creds.xPubKey);
      const stored: StoredCredentials = {
        ...creds,
        walletId: wallet.id,
        copayerId: me?.id ?? creds.copayerId,
        copayerName: name
      };
      addWallet(walletFromResponse(wallet, stored.copayerId, name), stored);
      setPendingMnemonic(creds.mnemonic);
      navigate(`/wallet/${wallet.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Join Shared Wallet</h1>
      </header>

      <form onSubmit={onSubmit} className="px-4 py-6 space-y-5">
        <p className="text-sm text-[var(--abcpay-muted)]">
          Enter the wallet invitation ID shared by the wallet creator.
        </p>

        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Wallet ID</label>
          <input
            value={walletId}
            onChange={e => setWalletId(e.target.value.trim())}
            placeholder="Paste wallet ID"
            className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none font-mono text-sm"
          />
        </div>

        {info && (
          <div className="p-4 bg-[var(--abcpay-surface)] rounded-xl text-sm">
            <p className="font-medium">{info.name}</p>
            <p className="text-[var(--abcpay-muted)]">
              {info.coin.toUpperCase()} · {info.m}-of-{info.n} · {info.copayerCount}/{info.n} joined
            </p>
          </div>
        )}

        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Your Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Bob"
            className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
          />
        </div>

        {error && <p className="text-red-400 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={loading || !name || !info}
          className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Joining...' : 'Join Wallet'}
        </button>
      </form>
    </div>
  );
}
