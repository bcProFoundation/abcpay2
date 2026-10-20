import { Link } from 'react-router-dom';
import { isTokenVisible, walletDisplayId } from '@bcpros/abcpay-wallet-core';
import {
  useWallets,
  accountDisplayTitle,
  accountNetworkLabel,
  labelForAccount
} from '../context/WalletContext';
import { API_URL } from '../lib/api';
import { tokenLabel } from '../lib/token-format';

export function SettingsPage() {
  const {
    seedWallets,
    activeAccount,
    setActiveAccount,
    credentialsFor,
    removeAccount,
    tokenVisibility,
    setTokenVisible,
    knownTokens
  } = useWallets();

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Settings</h1>
      </header>

      <div className="px-4 py-6 space-y-2">
        <SettingsItem label="Account server" value={API_URL} />
        <SettingsItem label="Supported coins" value="XEC, DOGE" />
        <SettingsItem label="Version" value="0.2.0" />

        <Link
          to="/restore"
          className="block p-4 bg-[var(--abcpay-surface)] rounded-xl hover:bg-[var(--abcpay-surface-2)]"
        >
          Restore Wallet from seed phrase
        </Link>

        <div className="p-4 bg-[var(--abcpay-surface)] rounded-xl">
          <p className="font-medium mb-1">Tokens</p>
          <p className="text-xs text-[var(--abcpay-muted)] mb-3">
            App-level setting — applies to every Account in this app. Tokens are hidden by
            default; tick the ones you want to show under each Account.
          </p>
          {knownTokens.length === 0 ? (
            <p className="text-sm text-[var(--abcpay-muted)]">
              No tokens held yet. Tokens you receive will appear here to opt in.
            </p>
          ) : (
            <div className="space-y-2">
              {knownTokens.map(token => (
                <label
                  key={token.tokenId}
                  className="flex items-center justify-between gap-3 cursor-pointer"
                >
                  <span className="text-sm truncate">
                    {tokenLabel(token)}
                    <span className="block text-xs text-[var(--abcpay-muted)] font-mono truncate">
                      {token.tokenId.slice(0, 16)}…
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={isTokenVisible(tokenVisibility, token.tokenId)}
                    onChange={e => setTokenVisible(token.tokenId, e.target.checked)}
                    className="w-5 h-5 shrink-0"
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {seedWallets.map(wallet => (
          <div key={wallet.id} className="p-4 bg-[var(--abcpay-surface)] rounded-xl">
            <p className="font-medium mb-1">Wallet</p>
            <p className="text-xs text-[var(--abcpay-muted)] font-mono mb-1">
              {walletDisplayId(wallet.id)}
            </p>
            <p className="text-xs text-[var(--abcpay-muted)] mb-3">
              {wallet.groupedAccounts.length}{' '}
              {wallet.groupedAccounts.length === 1 ? 'Account' : 'Accounts'} across coins
              (HD path). Pick one to make it current.
            </p>
            <div className="space-y-2">
              {wallet.groupedAccounts.map(group => {
                const entry = group.entries[0];
                const isCurrent = group.entries.some(e => e.id === activeAccount?.id);
                return (
                  <div key={group.key} className="flex items-center justify-between gap-3">
                    <span className={`text-sm truncate ${isCurrent ? 'font-medium' : ''}`}>
                      <span className="font-mono">
                        Account {accountNetworkLabel(group.coin)}{' '}
                        {accountDisplayTitle({ ...entry, accountPath: group.accountPath })}
                        {isCurrent ? ' · current' : ''}
                      </span>
                      {group.network !== 'livenet' && (
                        <span className="block text-xs text-[var(--abcpay-muted)]">
                          {group.network}
                        </span>
                      )}
                    </span>
                    {!isCurrent && (
                      <button
                        type="button"
                        onClick={() => setActiveAccount(entry.id)}
                        className="text-xs px-3 py-1 rounded-full border border-white/10 text-[var(--abcpay-accent)] shrink-0"
                      >
                        Use
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {seedWallets.map(wallet => {
          const first = wallet.accounts[0];
          const creds = first ? credentialsFor(first.id) : undefined;
          return (
            <details key={wallet.id} className="p-4 bg-[var(--abcpay-surface)] rounded-xl">
              <summary className="cursor-pointer font-medium">Wallet backup (seed)</summary>
              <p className="text-xs text-[var(--abcpay-muted)] mt-2 font-mono">
                {walletDisplayId(wallet.id)}
              </p>
              {creds ? (
                <p className="mt-3 font-mono text-xs leading-6">{creds.mnemonic}</p>
              ) : (
                <p className="mt-3 text-sm text-[var(--abcpay-muted)]">No keys stored on this device.</p>
              )}
              <div className="mt-3 space-y-1">
                {wallet.accounts.map(account => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => removeAccount(account.id)}
                    className="block text-sm text-red-400"
                  >
                    Remove Account {labelForAccount(account)} from this device
                  </button>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function SettingsItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center p-4 bg-[var(--abcpay-surface)] rounded-xl gap-4">
      <span className="text-[var(--abcpay-muted)]">{label}</span>
      <span className="text-sm font-mono text-right break-all">{value}</span>
    </div>
  );
}