import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { defaultFeePerKb, toSatoshis, validateAddress } from '@bcpros/abcpay-wallet-core';
import { useWallets } from '../context/WalletContext';
import { api } from '../lib/api';
import { signAndMaybeBroadcast } from '../lib/tx';

export function SendPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { wallets, authFor, credentialsFor, refreshBalances } = useWallets();
  const wallet = wallets.find(w => w.id === id);
  const [address, setAddress] = useState(params.get('to') ?? '');
  const [amount, setAmount] = useState(params.get('amount') ?? '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [txid, setTxid] = useState('');

  const config = wallet ? COIN_CONFIGS[wallet.coin] : null;
  const satoshis = useMemo(() => {
    const n = Number(amount);
    if (!wallet || !Number.isFinite(n) || n <= 0) return 0;
    return toSatoshis(wallet.coin, n);
  }, [amount, wallet]);

  if (!wallet || !config) {
    return <p className="p-8 text-center text-[var(--abcpay-muted)]">Wallet not found</p>;
  }

  const auth = authFor(wallet.id);
  const creds = credentialsFor(wallet.id);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!auth || !creds) {
      setError('Missing keys for this wallet');
      return;
    }
    if (!validateAddress(wallet.coin, address.trim())) {
      setError('Invalid destination address');
      return;
    }
    if (satoshis <= 0) {
      setError('Enter an amount');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const remote = await api.getWallet(auth);
      const proposal = await api.createTxProposal(auth, {
        proposals: [
          {
            outputs: [{ toAddress: address.trim(), amount: satoshis, message: message || undefined }],
            feePerKb: defaultFeePerKb(wallet.coin),
            message: message || undefined
          }
        ]
      });
      const result = await signAndMaybeBroadcast(proposal, creds, auth, remote.copayers);
      if (result.txid) {
        setTxid(result.txid);
        await refreshBalances();
      } else {
        navigate(`/wallet/${wallet.id}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (txid) {
    return (
      <div className="max-w-lg mx-auto px-4 py-8 text-center">
        <h1 className="text-lg font-medium mb-4">Transaction sent</h1>
        <p className="font-mono text-xs break-all text-[var(--abcpay-muted)] mb-6">{txid}</p>
        <button
          type="button"
          onClick={() => navigate(`/wallet/${wallet.id}`)}
          className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl"
        >
          Back to wallet
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Send {config.unitName}</h1>
      </header>
      <form onSubmit={onSubmit} className="px-4 py-6 space-y-5">
        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">To</label>
          <input
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder={wallet.coin === 'xec' ? 'ecash:q…' : 'D…'}
            className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 font-mono text-sm outline-none focus:border-[var(--abcpay-accent)]"
          />
        </div>
        <div>
          <div className="flex justify-between mb-2">
            <label className="text-sm text-[var(--abcpay-muted)]">Amount ({config.unitName})</label>
            <button
              type="button"
              className="text-sm text-[var(--abcpay-accent)]"
              onClick={() => setAmount((wallet.balance / config.unitToSatoshi).toFixed(config.unitDecimals))}
            >
              Max
            </button>
          </div>
          <input
            value={amount}
            onChange={e => setAmount(e.target.value)}
            type="number"
            step="any"
            placeholder="0"
            className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
          />
        </div>
        <div>
          <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Note (optional)</label>
          <input
            value={message}
            onChange={e => setMessage(e.target.value)}
            className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
          />
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium disabled:opacity-50"
        >
          {loading ? 'Sending…' : wallet.n > 1 ? 'Propose transaction' : 'Send'}
        </button>
      </form>
    </div>
  );
}
