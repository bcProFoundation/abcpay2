import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { toSatoshis } from '@bcpros/abcpay-wallet-core';
import { createAndPublishTx, signAndBroadcastTx } from '../lib/bwc';
import { useWallets } from '../context/WalletContext';

export function SendPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { wallets, getWalletCredentials, refreshBalances } = useWallets();
  const wallet = wallets.find(w => w.id === id);

  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [txid, setTxid] = useState('');

  if (!wallet) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <p className="text-[var(--abcpay-muted)]">Wallet not found</p>
      </div>
    );
  }

  const config = COIN_CONFIGS[wallet.coin];

  const handleSend = async () => {
    setLoading(true);
    setError('');
    setTxid('');

    try {
      const creds = getWalletCredentials(wallet.id);
      if (!creds) throw new Error('Wallet credentials not found');

      const satoshis = toSatoshis(wallet.coin, parseFloat(amount));
      if (satoshis <= 0) throw new Error('Invalid amount');
      if (!toAddress.trim()) throw new Error('Recipient address is required');

      const txp = await createAndPublishTx({
        credentialsJson: creds,
        toAddress: toAddress.trim(),
        amount: satoshis,
        message: message || undefined
      });

      const broadcastTxid = await signAndBroadcastTx(creds, txp);
      setTxid(broadcastTxid);
      await refreshBalances();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10 flex items-center">
        <button onClick={() => navigate(-1)} className="p-2 text-[var(--abcpay-muted)]">
          ← Back
        </button>
        <h1 className="text-lg font-medium flex-1 text-center pr-10">Send {config.unitName}</h1>
      </header>

      <div className="px-4 py-6 space-y-5">
        {txid ? (
          <div className="text-center py-8">
            <p className="text-green-400 font-medium mb-2">Transaction sent!</p>
            <p className="text-xs font-mono break-all text-[var(--abcpay-muted)] mb-6">{txid}</p>
            <button
              onClick={() => navigate(`/wallet/${wallet.id}`)}
              className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl font-medium"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div>
              <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Recipient Address</label>
              <input
                value={toAddress}
                onChange={e => setToAddress(e.target.value)}
                placeholder={`${config.unitName} address`}
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm text-[var(--abcpay-muted)] mb-2">
                Amount ({config.unitName})
              </label>
              <input
                type="number"
                step="any"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
              />
              <p className="text-xs text-[var(--abcpay-muted)] mt-1">
                Available: {(wallet.balance / config.unitToSatoshi).toFixed(config.unitDecimals)}{' '}
                {config.unitName}
              </p>
            </div>

            <div>
              <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Message (optional)</label>
              <input
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Payment for..."
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
              />
            </div>

            {wallet.n > 1 && (
              <p className="text-sm text-[var(--abcpay-muted)] bg-[var(--abcpay-surface)] p-3 rounded-xl">
                This is a {wallet.m}-of-{wallet.n} multisig wallet. Other copayers may need to sign before
                broadcast.
              </p>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              onClick={handleSend}
              disabled={loading}
              className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
