import { Link } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import { AbcPayLogo, CoinIcon, EyeToggle } from '../components/ui';
import { hiddenTokenCount, visibleTokens, walletDisplayId } from '@bcpros/abcpay-wallet-core';
import {
  useWallets,
  accountDisplayTitle,
  accountNetworkLabel
} from '../context/WalletContext';
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
          onClick={() => void refreshBalances()}
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
            <span className="text-3xl font-semibold">
              {showBalance ? totalFiatBalance : '******'}
            </span>
          </div>
        </div>

        {seedWallets.map(wallet => (
          <div key={wallet.id} className="mb-6 p-4 bg-[var(--abcpay-surface)] rounded-2xl">
            <div className="flex items-center justify-between mb-3">
              <p className="font-medium">Wallet</p>
              <span className="text-xs text-[var(--abcpay-muted)] font-mono">
                {walletDisplayId(wallet.id)}
              </span>
            </div>
            <div className="space-y-3">
              {wallet.groupedAccounts.map(group => {
                const entry = group.entries[0];
                const cfg = COIN_CONFIGS[group.coin];
                const totalSats = group.entries.reduce((sum, e) => sum + e.balance, 0);
                const coinAmount = (totalSats / cfg.unitToSatoshi).toFixed(cfg.unitDecimals);
                const accountTokens = group.entries.flatMap(e => tokensByAccount[e.id] ?? []);
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
                      className="block mb-2 hover:opacity-80"
                    >
                      <span className="block text-sm font-medium font-mono truncate">
                        Account {accountNetworkLabel(group.coin)}{' '}
                        {accountDisplayTitle({ ...entry, accountPath: group.accountPath })}
                      </span>
                      {(group.network !== 'livenet' || incomplete) && (
                        <span className="block text-xs text-[var(--abcpay-muted)]">
                          {[
                            group.network !== 'livenet' ? group.network : null,
                            incomplete ? 'pending' : null
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </Link>
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
