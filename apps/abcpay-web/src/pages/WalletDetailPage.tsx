import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { TxProposal, WalletResponse } from '@bcpros/abcpay-models';
import { CoinBadge, MultisigBadge } from '../components/ui';
import { useWallets } from '../context/WalletContext';
import { api } from '../lib/api';
import { signAndMaybeBroadcast } from '../lib/tx';

export function WalletDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { wallets, showBalance, authFor, credentialsFor, refreshBalances } = useWallets();
  const wallet = wallets.find(w => w.id === id);
  const [remote, setRemote] = useState<WalletResponse | null>(null);
  const [proposals, setProposals] = useState<TxProposal[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const auth = id ? authFor(id) : undefined;
  const creds = id ? credentialsFor(id) : undefined;

  async function load() {
    if (!auth) return;
    try {
      const [w, p] = await Promise.all([api.getWallet(auth), api.getTxProposals(auth)]);
      setRemote(w);
      setProposals(p.filter(item => item.status === 'pending' || item.status === 'accepted'));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [id]);

  if (!wallet) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <p className="text-[var(--abcpay-muted)]">Wallet not found</p>
      </div>
    );
  }

  const config = COIN_CONFIGS[wallet.coin];
  const complete = (remote?.status ?? wallet.status) === 'complete';

  return (
    <div className="max-w-lg mx-auto pb-8">
      <header
        className="px-4 py-8 text-center"
        style={{ background: `linear-gradient(180deg, ${config.backgroundColor}44 0%, transparent 100%)` }}
      >
        <div className="flex items-center justify-center gap-2 mb-4">
          <CoinBadge coin={wallet.coin} />
          <MultisigBadge m={remote?.m ?? wallet.m} n={remote?.n ?? wallet.n} />
        </div>
        <h1 className="text-xl font-medium mb-2">{wallet.name}</h1>
        <p className="text-3xl font-bold">
          {showBalance
            ? `${(wallet.balance / config.unitToSatoshi).toFixed(config.unitDecimals)} ${config.unitName}`
            : '****'}
        </p>
        <p className="text-[var(--abcpay-muted)] mt-1">{showBalance ? wallet.fiatBalance : '****'}</p>
      </header>

      <div className="grid grid-cols-3 gap-3 px-4 py-6">
        <ActionButton label="Send" icon="send" to={complete ? `/wallet/${wallet.id}/send` : undefined} disabled={!complete} />
        <ActionButton label="Receive" icon="receive" to={complete ? `/wallet/${wallet.id}/receive` : undefined} disabled={!complete} />
        <ActionButton label="History" icon="history" to={complete ? `/wallet/${wallet.id}/history` : undefined} disabled={!complete} />
      </div>

      {wallet.n > 1 && (
        <div className="mx-4 p-4 bg-[var(--abcpay-surface)] rounded-2xl mb-4">
          <h3 className="font-medium mb-2">Shared Wallet</h3>
          <p className="text-sm text-[var(--abcpay-muted)] mb-3">
            {(remote?.m ?? wallet.m)}-of-{(remote?.n ?? wallet.n)} multisig · {remote?.copayers.length ?? 0}/
            {remote?.n ?? wallet.n} copayers
          </p>
          <p className="text-xs text-[var(--abcpay-muted)] font-mono break-all">Wallet ID: {wallet.id}</p>
          <Link to={`/join-wallet?walletId=${wallet.id}`} className="text-sm text-[var(--abcpay-accent)] mt-2 inline-block">
            Invitation link
          </Link>
          {remote?.copayers?.length ? (
            <ul className="mt-3 space-y-1 text-sm">
              {remote.copayers.map(c => (
                <li key={c.id}>
                  {c.name}
                  {c.id === wallet.copayerId ? ' (you)' : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <div className="mx-4 p-4 bg-[var(--abcpay-surface)] rounded-2xl mb-4">
        <h3 className="font-medium mb-2">Status</h3>
        <p className="text-sm capitalize text-[var(--abcpay-muted)]">{remote?.status ?? wallet.status}</p>
      </div>

      {proposals.length > 0 && creds && auth && (
        <div className="mx-4 p-4 bg-[var(--abcpay-surface)] rounded-2xl">
          <h3 className="font-medium mb-3">Transaction proposals</h3>
          <div className="space-y-3">
            {proposals.map(p => (
              <div key={p.id} className="p-3 bg-[var(--abcpay-surface-2)] rounded-xl">
                <p className="text-sm">
                  {(p.amount / config.unitToSatoshi).toFixed(config.unitDecimals)} {config.unitName} →{' '}
                  {p.outputs[0]?.toAddress.slice(0, 18)}…
                </p>
                <p className="text-xs text-[var(--abcpay-muted)] mt-1">
                  {Object.keys(p.signatures ?? {}).length}/{p.requiredSignatures} signatures · {p.status}
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    disabled={Boolean(busy) || Boolean(p.signatures?.[wallet.copayerId])}
                    onClick={async () => {
                      setBusy(p.id);
                      setError('');
                      try {
                        await signAndMaybeBroadcast(p, creds, auth, remote?.copayers ?? []);
                        await load();
                        await refreshBalances();
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setBusy('');
                      }
                    }}
                    className="flex-1 py-2 bg-[var(--abcpay-accent)] rounded-lg text-sm disabled:opacity-40"
                  >
                    {busy === p.id ? 'Signing…' : 'Sign'}
                  </button>
                  <button
                    disabled={Boolean(busy)}
                    onClick={async () => {
                      setBusy(p.id);
                      try {
                        await api.rejectTxProposal(auth, p.id);
                        await load();
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setBusy('');
                      }
                    }}
                    className="flex-1 py-2 bg-red-500/20 text-red-300 rounded-lg text-sm"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mx-4 mt-4 text-red-400 text-sm">{error}</p>}
    </div>
  );
}

function ActionButton({
  label,
  icon,
  to,
  disabled
}: {
  label: string;
  icon: string;
  to?: string;
  disabled?: boolean;
}) {
  const icons: Record<string, ReactNode> = {
    send: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
      </svg>
    ),
    receive: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
    ),
    history: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    )
  };

  const className =
    'flex flex-col items-center gap-2 p-4 bg-[var(--abcpay-surface)] rounded-xl hover:bg-[var(--abcpay-surface-2)] disabled:opacity-40 transition-colors';

  if (to && !disabled) {
    return (
      <Link to={to} className={className}>
        {icons[icon]}
        <span className="text-sm">{label}</span>
      </Link>
    );
  }

  return (
    <button disabled className={className}>
      {icons[icon]}
      <span className="text-sm">{label}</span>
    </button>
  );
}
