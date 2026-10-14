import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { TxHistoryItem } from '@bcpros/abcpay-models';
import { useWallets } from '../context/WalletContext';
import { useNotifications } from '../context/NotificationContext';
import { api } from '../lib/api';

export function HistoryPage() {
  const { id } = useParams<{ id: string }>();
  const { wallets, authFor } = useWallets();
  const { subscribe } = useNotifications();
  const wallet = wallets.find(w => w.id === id);
  const [items, setItems] = useState<TxHistoryItem[]>([]);
  const [error, setError] = useState('');

  const copayerId = id ? authFor(id)?.copayerId : undefined;

  useEffect(() => {
    if (!id) return;
    const auth = authFor(id);
    if (!auth) return;

    const load = () =>
      api
        .getHistory(auth)
        .then(setItems)
        .catch(err => setError((err as Error).message));

    void load();
    return subscribe(id, () => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, copayerId]);

  if (!wallet) {
    return <p className="p-8 text-center text-[var(--abcpay-muted)]">Wallet not found</p>;
  }

  const config = COIN_CONFIGS[wallet.coin];

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">History</h1>
      </header>
      <div className="px-4 py-4 space-y-3">
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {items.length === 0 && !error ? (
          <p className="text-center text-[var(--abcpay-muted)] py-12">No transactions yet</p>
        ) : (
          items.map(item => (
            <div key={item.txid} className="p-4 bg-[var(--abcpay-surface)] rounded-2xl">
              <div className="flex justify-between">
                <span className={item.action === 'received' ? 'text-green-400' : 'text-red-300'}>
                  {item.action === 'received' ? '+' : '-'}
                  {(item.amount / config.unitToSatoshi).toFixed(config.unitDecimals)} {config.unitName}
                </span>
                <span className="text-xs text-[var(--abcpay-muted)]">
                  {item.confirmations ? 'Confirmed' : 'Unconfirmed'}
                </span>
              </div>
              <p className="font-mono text-xs text-[var(--abcpay-muted)] mt-2 break-all">{item.txid}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
