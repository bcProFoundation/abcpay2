import { useCallback, useEffect, useState } from 'react';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';
import type { WalletResponse } from '@bcpros/abcpay-models';
import { useWallets } from '../context/WalletContext';
import { api } from '../lib/api';
import {
  createPaymentRequest,
  listPaymentRequests,
  payPaymentRequest,
  syncPaymentRequests,
  type PaymentRequestRecord
} from '../lib/payment-requests';

const SYNC_INTERVAL_MS = 20000;
const SETTINGS_KEY = 'abcpay_v2_payjoin_settings';

interface PayjoinSettings {
  payerPayjoin: boolean;
  responder: boolean;
}

function loadSettings(walletId: string): PayjoinSettings {
  try {
    const all = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<
      string,
      PayjoinSettings
    >;
    return all[walletId] ?? { payerPayjoin: false, responder: false };
  } catch {
    return { payerPayjoin: false, responder: false };
  }
}

function saveSettings(walletId: string, settings: PayjoinSettings): void {
  let all: Record<string, PayjoinSettings> = {};
  try {
    all = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, PayjoinSettings>;
  } catch {
    all = {};
  }
  all[walletId] = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
}

function shortKey(key: string): string {
  return key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-400/15 text-amber-300 border-amber-400/30',
  claimed: 'bg-sky-400/15 text-sky-300 border-sky-400/30',
  paid: 'bg-green-400/15 text-green-300 border-green-400/30',
  rejected: 'bg-red-400/15 text-red-300 border-red-400/30'
};

export function PaymentRequestsCard({ walletId }: { walletId: string }) {
  const { authFor, credentialsFor } = useWallets();
  const [records, setRecords] = useState<PaymentRequestRecord[]>([]);
  const [remote, setRemote] = useState<WalletResponse | null>(null);
  const [settings, setSettings] = useState<PayjoinSettings>(() => loadSettings(walletId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [payerIdentity, setPayerIdentity] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [useMainAddress, setUseMainAddress] = useState(false);

  const auth = authFor(walletId);
  const creds = credentialsFor(walletId);

  const refresh = useCallback(async () => {
    if (!auth || !creds) return;
    setBusy(previous => previous ?? 'sync');
    setError('');
    try {
      const wallet = await api.getWallet(auth);
      setRemote(wallet);
      await syncPaymentRequests({
        auth,
        creds,
        wallet,
        payjoinResponder: loadSettings(walletId).responder
      });
      setRecords(listPaymentRequests(walletId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(previous => (previous === 'sync' ? null : previous));
    }
  }, [auth, creds, walletId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const updateSettings = (patch: Partial<PayjoinSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(walletId, next);
  };

  const config = remote ? COIN_CONFIGS[remote.coin] : null;
  const amountLabel = (record: PaymentRequestRecord): string => {
    if (record.tokenId) {
      return `${record.atoms ?? '0'} ${shortKey(record.tokenId)}`;
    }
    if (!config || record.amountSat === undefined) return 'Any amount';
    return `${(record.amountSat / config.unitToSatoshi).toFixed(config.unitDecimals)} ${config.unitName}`;
  };

  const handleCreate = async () => {
    if (!auth || !creds || !remote) return;
    const identity = payerIdentity.trim();
    if (!/^[0-9a-fA-F]{66}$/.test(identity)) {
      setError('Payer identity must be a 66-character compressed public key');
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a positive amount');
      return;
    }
    setBusy('create');
    setError('');
    setNotice('');
    try {
      const address = useMainAddress
        ? (await api.getMainAddress(auth)).address
        : (await api.createAddress(auth, false)).address;
      const amountSat = Math.round(parsed * config!.unitToSatoshi);
      await createPaymentRequest({
        auth,
        creds,
        wallet: remote,
        payerIdentityKey: identity,
        address,
        amountSat,
        memo: memo.trim() || undefined
      });
      setPayerIdentity('');
      setAmount('');
      setMemo('');
      setNotice(`Request sent to ${shortKey(identity)}`);
      setRecords(listPaymentRequests(walletId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handlePay = async (record: PaymentRequestRecord) => {
    if (!auth || !creds || !remote) return;
    setBusy(record.requestId);
    setError('');
    setNotice('');
    try {
      const outcome = await payPaymentRequest({
        auth,
        creds,
        wallet: remote,
        record,
        payjoin: settings.payerPayjoin && !record.tokenId
      });
      if (outcome.txid) {
        setNotice(
          outcome.mode === 'payjoin'
            ? `Paid ${amountLabel(record)} with PayJoin — txid ${shortKey(outcome.txid)}`
            : `Paid ${amountLabel(record)} — txid ${shortKey(outcome.txid)}`
        );
      } else {
        setNotice(`Payment proposed — waiting for ${outcome.pendingSignatures ?? 0} more signature(s)`);
      }
      setRecords(listPaymentRequests(walletId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!auth || !creds) return null;

  const incoming = records.filter(record => record.direction === 'incoming' && record.status === 'pending');
  const outgoing = records.filter(record => record.direction === 'outgoing');
  const expired = (record: PaymentRequestRecord) => record.expiresAt * 1000 < Date.now();

  return (
    <div className="px-4 pb-10 mt-4">
      <div className="rounded-2xl border border-white/10 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Payment requests</h2>
          <button
            onClick={() => void refresh()}
            disabled={busy === 'sync'}
            className="text-xs text-[var(--abcpay-muted)] disabled:opacity-50"
          >
            {busy === 'sync' ? 'Syncing…' : 'Refresh'}
          </button>
        </div>

        {error && <p className="text-sm text-red-400 break-words">{error}</p>}
        {notice && <p className="text-sm text-green-400 break-words">{notice}</p>}

        {incoming.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-[var(--abcpay-muted)]">To pay</p>
            {incoming.map(record => (
              <div key={record.requestId} className="rounded-xl bg-white/5 p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{amountLabel(record)}</p>
                    {record.memo && <p className="text-xs text-[var(--abcpay-muted)]">{record.memo}</p>}
                    <p className="text-[10px] text-[var(--abcpay-muted)] break-all">
                      from {shortKey(record.counterpartyIdentity)}
                      {expired(record) ? ' · expired' : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => void handlePay(record)}
                    disabled={busy === record.requestId || expired(record)}
                    className="px-4 py-2 bg-[var(--abcpay-accent)] rounded-xl text-sm font-medium disabled:opacity-50 shrink-0"
                  >
                    {busy === record.requestId ? 'Paying…' : 'Pay'}
                  </button>
                </div>
              </div>
            ))}
            <label className="flex items-center gap-2 text-xs text-[var(--abcpay-muted)]">
              <input
                type="checkbox"
                checked={settings.payerPayjoin}
                onChange={event => updateSettings({ payerPayjoin: event.target.checked })}
              />
              Use PayJoin when the requester supports it (falls back automatically)
            </label>
          </div>
        )}

        {outgoing.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-[var(--abcpay-muted)]">Your requests</p>
            {outgoing.map(record => (
              <div
                key={record.requestId}
                className="rounded-xl bg-white/5 p-3 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{amountLabel(record)}</p>
                  {record.memo && <p className="text-xs text-[var(--abcpay-muted)]">{record.memo}</p>}
                  <p className="text-[10px] text-[var(--abcpay-muted)] break-all">
                    from {shortKey(record.counterpartyIdentity)}
                  </p>
                  {record.txid && (
                    <p className="text-[10px] text-[var(--abcpay-muted)] break-all">
                      txid {shortKey(record.txid)}
                    </p>
                  )}
                </div>
                <span
                  className={`text-[10px] px-2 py-1 rounded-full border shrink-0 ${STATUS_STYLE[record.status] ?? ''}`}
                >
                  {record.status}
                </span>
              </div>
            ))}
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--abcpay-accent)]">
            Request a payment
          </summary>
          <div className="space-y-2 pt-3">
            <input
              value={payerIdentity}
              onChange={event => setPayerIdentity(event.target.value)}
              placeholder="Payer identity key (66 hex chars)"
              className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 font-mono text-xs"
            />
            <input
              value={amount}
              onChange={event => setAmount(event.target.value)}
              placeholder={`Amount (${config?.unitName ?? 'XEC'})`}
              inputMode="decimal"
              className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10"
            />
            <input
              value={memo}
              onChange={event => setMemo(event.target.value)}
              placeholder="Memo (optional)"
              className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10"
            />
            <label className="flex items-center gap-2 text-xs text-[var(--abcpay-muted)]">
              <input
                type="checkbox"
                checked={useMainAddress}
                onChange={event => setUseMainAddress(event.target.checked)}
              />
              Use my main address (PayJoin needs funds at the requested address)
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--abcpay-muted)]">
              <input
                type="checkbox"
                checked={settings.responder}
                onChange={event => updateSettings({ responder: event.target.checked })}
              />
              Accept PayJoin contributions to my requests
            </label>
            <button
              onClick={() => void handleCreate()}
              disabled={busy === 'create'}
              className="w-full px-4 py-3 bg-[var(--abcpay-accent)] rounded-xl font-medium disabled:opacity-50"
            >
              {busy === 'create' ? 'Sending…' : 'Send request'}
            </button>
            <p className="text-[11px] text-[var(--abcpay-muted)]">
              The payer needs their own envelope identity; share keys out of band (QR or chat).
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
