import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { NotificationEvent } from '@bcpros/abcpay-models';
import { getReceiveAddress, deserializeWallet } from '../lib/bwc';
import { useWallets } from '../context/WalletContext';
import { useNotifications } from '../context/NotificationContext';

interface PaymentToast {
  txid?: string;
  amount?: number;
  confirmed: boolean;
}

const TOAST_TIMEOUT_MS = 15000;

export function ReceivePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { wallets, getWalletCredentials } = useWallets();
  const { subscribe } = useNotifications();
  const wallet = wallets.find(w => w.id === id);
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [payment, setPayment] = useState<PaymentToast | null>(null);

  useEffect(() => {
    if (!wallet || !id) return;

    const creds = getWalletCredentials(id);
    if (!creds) {
      setError('Wallet credentials not found');
      setLoading(false);
      return;
    }

    getReceiveAddress(deserializeWallet(creds))
      .then(setAddress)
      .catch(err => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [wallet, id, getWalletCredentials]);

  useEffect(() => {
    if (!id) return;
    return subscribe(id, (event: NotificationEvent) => {
      if (event.type !== 'wallet.activity' || event.direction !== 'received') return;
      const confirmed = event.msgType !== 'TX_ADDED_TO_MEMPOOL';
      setPayment(previous =>
        previous && previous.txid === event.txid
          ? { ...previous, confirmed: previous.confirmed || confirmed, amount: previous.amount ?? event.amount }
          : { txid: event.txid, amount: event.amount, confirmed }
      );
    });
  }, [id, subscribe]);

  useEffect(() => {
    if (!payment) return;
    const timer = window.setTimeout(() => setPayment(null), TOAST_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [payment]);

  if (!wallet) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <p className="text-[var(--abcpay-muted)]">Wallet not found</p>
      </div>
    );
  }

  const config = COIN_CONFIGS[wallet.coin];
  const amountLabel =
    payment?.amount !== undefined
      ? `+${(payment.amount / config.unitToSatoshi).toFixed(config.unitDecimals)} ${config.unitName}`
      : '';

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10 flex items-center">
        <button onClick={() => navigate(-1)} className="p-2 text-[var(--abcpay-muted)]">
          ← Back
        </button>
        <h1 className="text-lg font-medium flex-1 text-center pr-10">Receive {config.unitName}</h1>
      </header>

      <div className="px-4 py-8 text-center">
        {loading && <p className="text-[var(--abcpay-muted)]">Generating address...</p>}
        {error && <p className="text-red-400">{error}</p>}

        {address && (
          <>
            <div className="inline-block p-4 bg-white rounded-2xl mb-6">
              <QRCodeSVG value={address} size={200} />
            </div>
            <p className="text-sm text-[var(--abcpay-muted)] mb-2">Your receiving address</p>
            <p className="font-mono text-sm break-all px-4 mb-6">{address}</p>
            <button
              onClick={() => navigator.clipboard.writeText(address)}
              className="px-6 py-3 bg-[var(--abcpay-accent)] rounded-xl font-medium"
            >
              Copy Address
            </button>
          </>
        )}
      </div>

      {payment && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm z-50">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 p-4 rounded-2xl bg-green-500/15 border border-green-400/30 backdrop-blur"
          >
            <span className="flex items-center justify-center w-8 h-8 rounded-full bg-green-400/20 text-green-300 shrink-0">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <div className="flex-1 text-left">
              <p className="font-medium">Payment received</p>
              <p className="text-sm text-[var(--abcpay-muted)]">
                {amountLabel ? `${amountLabel} · ` : ''}
                {payment.confirmed ? 'Confirmed' : 'Waiting for confirmation…'}
              </p>
            </div>
            <button
              onClick={() => setPayment(null)}
              aria-label="Dismiss"
              className="p-1 text-[var(--abcpay-muted)]"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
