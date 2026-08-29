import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createCredentials, isValidMnemonic } from '@bcpros/abcpay-wallet-core';
import { api } from '../lib/api';
import { useWallets, walletFromResponse, type StoredCredentials } from '../context/WalletContext';

export function RestorePage() {
  const navigate = useNavigate();
  const { addWallet } = useWallets();
  const [mnemonic, setMnemonic] = useState('');
  const [walletId, setWalletId] = useState('');
  const [name, setName] = useState('Restored');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(phrase)) {
      setError('Invalid recovery phrase');
      return;
    }
    if (!walletId.trim()) {
      setError('Wallet ID is required to re-attach a BWS wallet');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const info = await api.getJoinInfo(walletId.trim());
      const creds = createCredentials({
        coin: info.coin,
        mnemonic: phrase,
        isMultisig: info.n > 1,
        usePurpose48: info.n > 1
      });
      let wallet;
      try {
        wallet = await api.joinWallet(info.id, {
          name,
          coin: info.coin,
          xPubKey: creds.xPubKey,
          requestPubKey: creds.requestPubKey
        });
      } catch {
        wallet = await api.getWallet({
          walletId: info.id,
          copayerId: creds.copayerId,
          requestPrivKey: creds.requestPrivKey
        });
      }
      const stored: StoredCredentials = {
        ...creds,
        walletId: wallet.id,
        copayerName: name
      };
      addWallet(walletFromResponse(wallet, creds.copayerId, name), stored);
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
        <h1 className="text-lg font-medium text-center">Restore Wallet</h1>
      </header>
      <form onSubmit={onSubmit} className="px-4 py-6 space-y-5">
        <p className="text-sm text-[var(--abcpay-muted)]">
          Enter your 12-word phrase and the wallet ID from AbcPay. Private keys stay on this device.
        </p>
        <textarea
          value={mnemonic}
          onChange={e => setMnemonic(e.target.value)}
          rows={4}
          placeholder="twelve words …"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
        />
        <input
          value={walletId}
          onChange={e => setWalletId(e.target.value)}
          placeholder="Wallet ID"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 font-mono text-sm outline-none focus:border-[var(--abcpay-accent)]"
        />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium disabled:opacity-50"
        >
          {loading ? 'Restoring…' : 'Restore'}
        </button>
      </form>
    </div>
  );
}
