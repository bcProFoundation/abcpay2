import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { TokenBalance } from '@bcpros/abcpay-models';
import { validateAddress } from '@bcpros/abcpay-wallet-core';
import { createAndSendToken } from '../lib/tx';
import { formatTokenAtoms, parseTokenAtoms, tokenLabel } from '../lib/token-format';
import { api } from '../lib/api';
import { useWallets } from '../context/WalletContext';

interface PendingSignatures {
  signed: number;
  required: number;
}

export function TokenSendPage() {
  const { id, tokenId } = useParams<{ id: string; tokenId: string }>();
  const navigate = useNavigate();
  const { wallets, authFor, credentialsFor, refreshBalances } = useWallets();
  const wallet = wallets.find(w => w.id === id);

  const [token, setToken] = useState<TokenBalance | null>(null);
  const [toAddress, setToAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [txid, setTxid] = useState('');
  const [sentAtoms, setSentAtoms] = useState('');
  const [pending, setPending] = useState<PendingSignatures | null>(null);

  useEffect(() => {
    if (!id || !tokenId) return;
    const auth = authFor(id);
    if (!auth) return;
    api
      .getBalance(auth)
      .then(balance => setToken((balance.tokens ?? []).find(item => item.tokenId === tokenId) ?? null))
      .catch(err => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, tokenId]);

  if (!wallet) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <p className="text-[var(--abcpay-muted)]">Wallet not found</p>
      </div>
    );
  }

  const config = COIN_CONFIGS[wallet.coin];
  const decimals = token?.decimals ?? 0;
  const label = token ? tokenLabel(token) : tokenId?.slice(0, 8) ?? 'token';

  const handleSend = async () => {
    setLoading(true);
    setError('');
    setTxid('');
    setSentAtoms('');
    setPending(null);

    try {
      const auth = authFor(wallet.id);
      const creds = credentialsFor(wallet.id);
      if (!auth || !creds) throw new Error('Wallet credentials not found on this device');
      if (!tokenId) throw new Error('Token not found');
      if (!token) throw new Error('Token balance not loaded yet');

      const recipient = toAddress.trim();
      if (!recipient) throw new Error('Recipient address is required');
      if (!validateAddress(wallet.coin, recipient)) throw new Error('Invalid recipient address');

      const atoms = parseTokenAtoms(amount, decimals);
      if (atoms > BigInt(token.atoms)) {
        throw new Error(`Amount exceeds your balance of ${formatTokenAtoms(token.atoms, decimals)} ${label}`);
      }

      const { proposal, txid: broadcastTxid } = await createAndSendToken({
        auth,
        creds,
        tokenId,
        toAddress: recipient,
        atoms: atoms.toString(),
        message: message.trim() || undefined
      });

      setSentAtoms(atoms.toString());
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
        <h1 className="text-lg font-medium flex-1 text-center pr-10">Send {label}</h1>
      </header>

      <div className="px-4 py-6 space-y-5">
        {txid ? (
          <div className="text-center py-8">
            <p className="text-green-400 font-medium mb-2">Token transfer sent!</p>
            <p className="text-sm mb-2">
              {formatTokenAtoms(sentAtoms, decimals)} {label}
            </p>
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
            <p className="text-sm mb-2">
              {formatTokenAtoms(sentAtoms, decimals)} {label}
            </p>
            <p className="text-sm text-[var(--abcpay-muted)] mb-6">
              {pending.signed} of {pending.required} signatures collected. Other copayers can sign from the wallet
              page.
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
            <div className="p-4 bg-[var(--abcpay-surface)] rounded-2xl">
              <p className="text-sm text-[var(--abcpay-muted)]">
                {token?.protocol ?? 'SLP'} token balance
              </p>
              <p className="text-xl font-medium mt-1">
                {token ? `${formatTokenAtoms(token.atoms, decimals)} ${label}` : 'Loading…'}
              </p>
              {token?.name && token.name !== label && (
                <p className="text-xs text-[var(--abcpay-muted)] mt-1">{token.name}</p>
              )}
            </div>

            <div>
              <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Recipient Address</label>
              <input
                value={toAddress}
                onChange={e => setToAddress(e.target.value)}
                placeholder="XEC address (ecash:...)"
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none font-mono text-sm"
              />
            </div>

            <div>
              <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Amount ({label})</label>
              <input
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                inputMode="decimal"
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
              />
              {token && (
                <button
                  type="button"
                  onClick={() => setAmount(formatTokenAtoms(token.atoms, decimals))}
                  className="text-xs text-[var(--abcpay-accent)] mt-1"
                >
                  Send all {formatTokenAtoms(token.atoms, decimals)} {label}
                </button>
              )}
            </div>

            <div>
              <label className="block text-sm text-[var(--abcpay-muted)] mb-2">Message (optional)</label>
              <input
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Token transfer"
                className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 focus:border-[var(--abcpay-accent)] outline-none"
              />
            </div>

            <p className="text-sm text-[var(--abcpay-muted)] bg-[var(--abcpay-surface)] p-3 rounded-xl">
              Tokens travel as dust outputs; a small amount of {config.unitName} from this wallet covers dust and
              the network fee.
            </p>

            {wallet.n > 1 && (
              <p className="text-sm text-[var(--abcpay-muted)] bg-[var(--abcpay-surface)] p-3 rounded-xl">
                This is a {wallet.m}-of-{wallet.n} multisig wallet. Other copayers may need to sign before broadcast.
              </p>
            )}

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              onClick={handleSend}
              disabled={loading || !token}
              className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Sending…' : 'Send token'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
