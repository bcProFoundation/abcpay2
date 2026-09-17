import { Link } from 'react-router-dom';
import { useWallets } from '../context/WalletContext';
import { API_URL } from '../lib/api';

export function SettingsPage() {
  const { wallets, credentialsFor, removeWallet } = useWallets();

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Settings</h1>
      </header>

      <div className="px-4 py-6 space-y-2">
        <SettingsItem label="Wallet server" value={API_URL} />
        <SettingsItem label="Supported coins" value="XEC, DOGE" />
        <SettingsItem label="Version" value="0.2.0" />

        <Link
          to="/restore"
          className="block p-4 bg-[var(--abcpay-surface)] rounded-xl hover:bg-[var(--abcpay-surface-2)]"
        >
          Restore from recovery phrase
        </Link>

        {wallets.map(wallet => {
          const creds = credentialsFor(wallet.id);
          return (
            <details key={wallet.id} className="p-4 bg-[var(--abcpay-surface)] rounded-xl">
              <summary className="cursor-pointer font-medium">{wallet.name} backup</summary>
              {creds ? (
                <p className="mt-3 font-mono text-xs leading-6">{creds.mnemonic}</p>
              ) : (
                <p className="mt-3 text-sm text-[var(--abcpay-muted)]">No keys stored on this device.</p>
              )}
              <button
                type="button"
                onClick={() => removeWallet(wallet.id)}
                className="mt-3 text-sm text-red-400"
              >
                Remove from this device
              </button>
            </details>
          );
        })}

        <Link to="/" className="block w-full py-3 text-center text-[var(--abcpay-accent)] hover:underline">
          Back to Home
        </Link>
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
