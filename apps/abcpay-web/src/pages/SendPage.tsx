import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { dustThreshold, toSatoshis, validateAddress } from '@bcpros/abcpay-wallet-core';
import { createAndSendPayment } from '../lib/tx';
import { useWallets } from '../context/WalletContext';

interface PendingSignatures {
  signed: number;
  required: number;
}

export function SendPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { wallets, authFor, credentialsFor, refreshBalances } = useWallets();
  const wallet = wallets.find(w => w.id === id);

  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [txid, setTxid] = useState('');
  const [sentAmount, setSentAmount] = useState(0);
  const [sendMax, setSendMax] = useState(false);
  const [pending, setPending] = useState<PendingSignatures | null>(null);

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
    setSentAmount(0);
    setPending(null);

    try {
      const auth = authFor(wallet.id);
      const creds = credentialsFor(wallet.id);
      if (!auth || !creds) throw new Error('Wallet credentials not found on this device');

      const recipient = toAddress.trim();
      if (!recipient) throw new Error('Recipient address is required');
      if (!validateAddress(wallet.coin, recipient)) throw new Error('Invalid recipient address');

      let satoshis = 0;
      if (!sendMax) {
        const parsedAmount = parseFloat(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) throw new Error('Invalid amount');
        satoshis = toSatoshis(wallet.coin, parsedAmount);
        const dust = dustThreshold(wallet.coin);
        if (satoshis < dust) {
          throw new Error(
            `Minimum payment is ${(dust / config.unitToSatoshi).toFixed(config.unitDecimals)} ${config.unitName} (dust limit)`
          );
        }
      }

      const { proposal, txid: broadcastTxid } = await createAndSendPayment({
        auth,
        creds,
        toAddress: recipient,
        satoshis,
        message: message.trim() || undefined,
        sendMax
      });

      setSentAmount(proposal.amount);
      if (broadcastTxid) {
        setTxid(broadcastTxid);
      } else {
        setPending({
          signed: Object.keys(proposal.signatures ?? {}).length,
          required: proposal.requiredSignatures
        });
      }
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
            {sentAmount > 0 && (
              <p className="text-sm mb-2">
                {(sentAmount / config.unitToSatoshi).toFixed(config.unitDecimals)} {config.unitName}
              </p>
            )}
            <p className="text-xs font-mono break-all text-[var(--abcpay-muted)] mb-6">{txid}</p>
            <button
              onClick={() => navigate(`/wallet/${wallet.id}`)}
              className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl font-medium"
            >
              Done
            </button>
          </div>
        ) : pending ? (
          <div className="text-center py-8">
            <p className="text-amber-300 font-medium mb-2">Waiting for co-signers</p>
            {sentAmount > 0 && (
              <p className="text-sm mb-2">
                {(sentAmount / config.unitToSatoshi).toFixed(config.unitDecimals)} {config.unitName}
              </p>
            )}
            <p className="text-sm text-[var(--abcpay-muted)] mb-6">
              {pending.signed} of {pending.required} signatures collected. Other copayers can sign from
              the wallet page.
            </p>
            <button
              onClick={() => navigate(`/wallet/${wallet.id}`)}
              className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl font-medium"
            >
              Open wallet
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
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm text-[var(--abcpay-muted)]">
                  Amount ({config.unitName})
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setSendMax(current => !current);
                    setAmount('');
                  }}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                    sendMax
                      ? 'border-[var(--abcpay-accent)] bg-[var(--abcpay-accent)] text-slate-900 font-medium'
                      : 'border-white/10 bg-[var(--abcpay-surface)] text-[var(--abcpay-muted)]'
                  }`}
                >
                  {sendMax ? 'Sending max' : 'Send max'}
                </button>
              </div>
              <input
                type="number"
                step="any"
                value={sendMax ? '' : amount}
                onChange={e => setAmount(e.target.value)}
                disabled={sendMax}
                placeholder={sendMax ? 'All funds minus fee' : '0.00'}
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none disabled:opacity-60"
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
