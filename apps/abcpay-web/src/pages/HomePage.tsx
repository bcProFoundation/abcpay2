import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { TokenBalance } from '@bcpros/abcpay-models';
import { AbcPayLogo, CoinBadge, EyeToggle, MultisigBadge } from '../components/ui';
import { hiddenTokenCount, visibleTokens, walletDisplayId } from '@bcpros/abcpay-wallet-core';
import { useWallets, labelForAccount } from '../context/WalletContext';
import { useNotifications } from '../context/NotificationContext';
import { api } from '../lib/api';
import { formatTokenAtoms, tokenLabel } from '../lib/token-format';

export function HomePage() {
  const {
    activeAccount: activeWallet,
    seedWallets,
    setActiveAccount: setActiveWallet,
    showBalance,
    setShowBalance,
    totalFiatBalance,
    refreshBalances,
    authFor,
    tokenVisibility,
    tokensByAccount
  } = useWallets();
  const { subscribe } = useNotifications();
  const [tokens, setTokens] = useState<TokenBalance[]>([]);

  const walletId = activeWallet?.id;
  const copayerId = walletId ? authFor(walletId)?.copayerId : undefined;

  const loadTokens = useCallback(async () => {
    if (!walletId) {
      setTokens([]);
      return;
    }
    const auth = authFor(walletId);
    if (!auth) {
      setTokens([]);
      return;
    }
    try {
      const balance = await api.getBalance(auth);
      setTokens(balance.tokens ?? []);
    } catch {
      // keep the previous list; the global refresh will retry
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, copayerId]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens, activeWallet?.balance]);

  useEffect(() => {
    if (!walletId) return;
    return subscribe(walletId, () => void loadTokens());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, subscribe, loadTokens]);

  if (!activeWallet) {
    return (
      <div className="max-w-lg mx-auto">
        <header className="flex items-center justify-between px-4 py-4 border-b border-white/10">
          <AbcPayLogo />
        </header>
        <div className="px-4 py-12 text-center bg-[var(--abcpay-surface)] rounded-2xl m-4">
          <p className="text-[var(--abcpay-muted)] mb-4">No Wallet on this device yet</p>
          <div className="flex flex-col gap-3 items-center">
            <Link
              to="/create-wallet"
              className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-full font-medium hover:opacity-90 transition-opacity"
            >
              Create Wallet
            </Link>
            <Link to="/restore" className="text-sm text-[var(--abcpay-accent)] hover:underline">
              Restore Wallet from seed phrase
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const config = COIN_CONFIGS[activeWallet.coin];
  const xecBalance = `${(activeWallet.balance / config.unitToSatoshi).toFixed(config.unitDecimals)} ${config.unitName}`;

  return (
    <div className="max-w-lg mx-auto">
      <header className="flex items-center justify-between px-4 py-4 border-b border-white/10">
        <AbcPayLogo />
        <button
          onClick={() => {
            void refreshBalances();
            void loadTokens();
          }}
          className="text-sm text-[var(--abcpay-accent)] hover:underline"
        >
          Refresh
        </button>
      </header>

      <div className="px-4 py-6">
        <div className="text-center mb-6">
          <p className="text-sm text-[var(--abcpay-muted)] mb-2">Total cash value</p>
          <div className="flex items-center justify-center gap-2">
            <EyeToggle show={showBalance} onToggle={() => setShowBalance(!showBalance)} />
            <span className="text-3xl font-semibold">{showBalance ? totalFiatBalance : '******'}</span>
          </div>
          <Link to={`/wallet/${activeWallet.id}`} className="inline-flex items-center gap-2 mt-3 hover:opacity-80">
            <span className="font-medium">{activeWallet.name}</span>
            <CoinBadge coin={activeWallet.coin} />
            <MultisigBadge m={activeWallet.m} n={activeWallet.n} />
          </Link>
          {activeWallet.status !== 'complete' && (
            <p className="text-xs text-amber-300 mt-2">
              Account {activeWallet.status} — open it to invite copayers
            </p>
          )}
        </div>

        {seedWallets.map(wallet => (
          <div key={wallet.id} className="mb-6 p-4 bg-[var(--abcpay-surface)] rounded-2xl">
            <div className="flex items-center justify-between mb-1">
              <p className="font-medium">Wallet</p>
              <span className="text-xs text-[var(--abcpay-muted)] font-mono">
                {walletDisplayId(wallet.id)}
              </span>
            </div>
            <p className="text-xs text-[var(--abcpay-muted)] mb-3">
              1 seed · {wallet.groupedAccounts.length}{' '}
              {wallet.groupedAccounts.length === 1 ? 'Account' : 'Accounts'} — each Account is a
              derivation path with its coins and tokens.
            </p>
            <div className="space-y-2">
              {wallet.groupedAccounts.map(group => {
                const entry = group.entries[0];
                const cfg = COIN_CONFIGS[group.coin];
                const totalSats = group.entries.reduce((sum, e) => sum + e.balance, 0);
                const amount = `${(totalSats / cfg.unitToSatoshi).toFixed(cfg.unitDecimals)} ${cfg.unitName}`;
                const accountTokens = group.entries.flatMap(e => tokensByAccount[e.id] ?? []);
                const shownTokens = visibleTokens(accountTokens, tokenVisibility);
                const hiddenCount = hiddenTokenCount(accountTokens, tokenVisibility);
                return (
                  <div key={group.key}>
                    <Link
                      to={`/wallet/${entry.id}`}
                      onClick={() => setActiveWallet(entry.id)}
                      className={`flex items-center justify-between gap-3 p-3 rounded-xl transition-colors ${
                        group.entries.some(e => e.id === activeWallet.id)
                          ? 'bg-[var(--abcpay-surface-2)] border border-[var(--abcpay-accent)]/40'
                          : 'bg-black/20 hover:bg-[var(--abcpay-surface-2)]'
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">{entry.name}</span>
                        <span className="block text-xs text-[var(--abcpay-muted)] font-mono">
                          {labelForAccount({ ...entry, accountPath: group.accountPath, network: undefined })}
                          {group.entries.some(e => e.id === activeWallet.id) ? ' · current' : ''}
                        </span>
                        <span className="block text-xs text-[var(--abcpay-muted)]">
                          {group.networks.join(' · ') || 'livenet'}
                        </span>
                      </span>
                      <span className="text-right shrink-0">
                        <span className="block font-mono text-sm">{showBalance ? amount : '****'}</span>
                        <span className="block text-xs text-[var(--abcpay-accent)]">Open →</span>
                      </span>
                    </Link>
                    {(shownTokens.length > 0 || hiddenCount > 0) && (
                      <div className="ml-3 mt-1 space-y-1">
                        {shownTokens.map(token => (
                          <p key={token.tokenId} className="text-xs text-[var(--abcpay-muted)]">
                            {tokenLabel(token)} · {formatTokenAtoms(token.atoms, token.decimals)}
                          </p>
                        ))}
                        {hiddenCount > 0 && (
                          <p className="text-xs text-[var(--abcpay-muted)]">
                            {hiddenCount} token{hiddenCount === 1 ? '' : 's'} hidden — manage in
                            Settings
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="grid grid-cols-2 gap-3">
          <div
            className="relative p-4 rounded-2xl"
            style={{ backgroundColor: config.backgroundColor + '22' }}
          >
            <Link to={`/wallet/${activeWallet.id}/send`} className="block">
              <div className="flex items-center justify-between mb-2">
                <CoinBadge coin={activeWallet.coin} />
                <span className="text-xs text-[var(--abcpay-muted)]">{config.unitName}</span>
              </div>
              <p className="font-mono text-lg">{showBalance ? xecBalance : '****'}</p>
              <p className="text-xs text-[var(--abcpay-muted)] mt-1">
                {showBalance ? activeWallet.fiatBalance : ''}
              </p>
              <p className="text-xs text-[var(--abcpay-accent)] mt-3">Send →</p>
            </Link>
            <Link
              to={`/wallet/${activeWallet.id}/receive`}
              title="Receive"
              className="absolute top-3 right-3 p-1.5 rounded-full bg-black/20 text-[var(--abcpay-muted)] hover:text-white"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
                />
              </svg>
            </Link>
          </div>

          {visibleTokens(tokens, tokenVisibility).map(token => (
            <Link
              key={token.tokenId}
              to={`/wallet/${activeWallet.id}/send-token/${token.tokenId}`}
              className="p-4 bg-[var(--abcpay-surface)] rounded-2xl hover:bg-[var(--abcpay-surface-2)] transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-[var(--abcpay-surface-2)] text-[var(--abcpay-muted)]">
                  {token.protocol ?? 'SLP'}
                </span>
                {token.isMintBaton && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/15 text-amber-300">
                    baton
                  </span>
                )}
              </div>
              <p className="font-medium truncate">{tokenLabel(token)}</p>
              {token.name && token.name !== tokenLabel(token) && (
                <p className="text-xs text-[var(--abcpay-muted)] truncate">{token.name}</p>
              )}
              <p className="font-mono text-lg mt-2">{formatTokenAtoms(token.atoms, token.decimals)}</p>
              <p className="text-xs text-[var(--abcpay-accent)] mt-3">Send →</p>
            </Link>
          ))}
        </div>

        {visibleTokens(tokens, tokenVisibility).length === 0 && (
          <p className="text-xs text-center text-[var(--abcpay-muted)] mt-4">
            Tokens are hidden by default. Choose which tokens to show in Settings.
          </p>
        )}
      </div>
    </div>
  );
}
