import { Link } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { AbcPayLogo, CoinIcon, EyeToggle } from '../components/ui';
import { formatFixed, hiddenTokenCount, visibleTokens, walletDisplayId } from '@bcpros/abcpay-wallet-core';
import { useWallets, accountNetworkLabel } from '../context/WalletContext';
import { formatTokenAtoms, tokenLabel } from '../lib/token-format';

export function HomePage() {
  const {
    activeAccount,
    seedWallets,
    setActiveAccount,
    showBalance,
    setShowBalance,
    totalFiatBalance,
    refreshBalances,
    refreshing,
    tokenVisibility,
    tokensByAccount
  } = useWallets();

  if (seedWallets.length === 0) {
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

  return (
    <div className="max-w-lg mx-auto">
      <header className="flex items-center justify-between px-4 py-4 border-b border-white/10">
        <AbcPayLogo />
        <button
          type="button"
          onClick={() => void refreshBalances()}
          disabled={refreshing}
          className="flex items-center gap-1.5 py-1 pl-3 text-sm text-[var(--abcpay-accent)] hover:underline disabled:opacity-60"
          aria-label={refreshing ? 'Refreshing balances' : 'Refresh balances'}
        >
          <svg
            className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
            />
          </svg>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <div className="px-4 pt-2 pb-6">
        <div className="text-center mb-6">
          <p className="text-sm text-[var(--abcpay-muted)] mb-2">Total cash value</p>
          <div className="flex items-center justify-center gap-2">
            <EyeToggle show={showBalance} onToggle={() => setShowBalance(!showBalance)} />
            <span className="text-3xl font-semibold">
              {showBalance ? totalFiatBalance : '******'}
            </span>
          </div>
        </div>

        {seedWallets.map(wallet => (
          <div key={wallet.id} className="mb-6 p-4 bg-[var(--abcpay-surface)] rounded-2xl">
            <div className="flex items-center justify-between mb-3">
              <p className="font-medium truncate pr-3">{wallet.name}</p>
              <span className="text-xs text-[var(--abcpay-muted)] font-mono shrink-0">
                {walletDisplayId(wallet.id)}
              </span>
            </div>
            <div className="space-y-3">
              {wallet.groupedAccounts.map(group => {
                const entry = group.entries[0];
                const cfg = COIN_CONFIGS[group.coin];
                const totalSats = group.entries.reduce((sum, e) => sum + e.balance, 0);
                const coinAmount = formatFixed(totalSats / cfg.unitToSatoshi, cfg.unitDecimals);
                // Grouped entries can hold the same token — aggregate atoms
                // per tokenId so each token shows once with its total.
                const tokensById = new Map<string, (typeof tokensByAccount)[string][number]>();
                for (const e of group.entries) {
                  for (const token of tokensByAccount[e.id] ?? []) {
                    const existing = tokensById.get(token.tokenId);
                    if (existing) {
                      try {
                        existing.atoms = (BigInt(existing.atoms) + BigInt(token.atoms)).toString();
                      } catch {
                        // keep original atoms on malformed values
                      }
                      existing.isMintBaton = existing.isMintBaton || token.isMintBaton;
                    } else {
                      tokensById.set(token.tokenId, { ...token });
                    }
                  }
                }
                const accountTokens = [...tokensById.values()];
                const shownTokens = visibleTokens(accountTokens, tokenVisibility);
                const hiddenCount = hiddenTokenCount(accountTokens, tokenVisibility);
                const isCurrent = group.entries.some(e => e.id === activeAccount?.id);
                const incomplete = group.entries.some(e => e.status !== 'complete');
                return (
                  <div
                    key={group.key}
                    className={`rounded-xl p-3 ${
                      isCurrent
                        ? 'bg-[var(--abcpay-surface-2)] border border-[var(--abcpay-accent)]/40'
                        : 'bg-black/20'
                    }`}
                  >
                    <Link
                      to={`/wallet/${entry.id}`}
                      onClick={() => setActiveAccount(entry.id)}
                      className="block hover:opacity-80"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-sm font-medium font-mono truncate">
                          {accountNetworkLabel(group.coin)} {group.accountPath}
                        </span>
                        {group.n > 1 && (
                          <span className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
                            {group.m}-of-{group.n}
                          </span>
                        )}
                      </div>
                      {(group.network !== 'livenet' || incomplete) && (
                        <p className="text-xs text-[var(--abcpay-muted)] mb-1">
                          {[
                            group.network !== 'livenet' ? group.network : null,
                            incomplete ? 'pending' : null
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    <div className="space-y-1 pl-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="inline-flex items-center gap-1.5 text-[var(--abcpay-muted)]">
                          <CoinIcon coin={group.coin} className="w-4 h-4" />
                          {cfg.unitName}
                        </span>
                        <span className="font-mono">{showBalance ? coinAmount : '****'}</span>
                      </div>
                      {shownTokens.map(token => (
                        <div
                          key={token.tokenId}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="inline-flex items-center gap-1.5 text-[var(--abcpay-muted)] truncate pr-2">
                            <img
                              src="/currencies/eToken.svg"
                              alt=""
                              className="w-4 h-4 rounded-full shrink-0"
                            />
                            <span className="truncate">{tokenLabel(token)}</span>
                          </span>
                          <span className="font-mono shrink-0">
                            {showBalance
                              ? formatTokenAtoms(token.atoms, token.decimals)
                              : '****'}
                          </span>
                        </div>
                      ))}
                      {hiddenCount > 0 && (
                        <p className="text-xs text-[var(--abcpay-muted)]">
                          {hiddenCount} token{hiddenCount === 1 ? '' : 's'} hidden — manage in
                          Settings
                        </p>
                      )}
                    </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
