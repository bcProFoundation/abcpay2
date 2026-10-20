import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE,
  XEC_TOKEN_AWARE_COIN_TYPE
} from '@bcpros/abcpay-models';
import {
  accountIdForCredentials,
  createCredentials,
  isValidMnemonic,
  restoreCandidatesForMnemonic,
  sortAccountWallets
} from '@bcpros/abcpay-wallet-core';
import { api } from '../lib/api';
import { saveCredentials } from '../lib/credentials-store';
import { persistJoinRecord } from '../lib/proposal-verify';
import { useWallets, walletFromResponse, type LocalWallet } from '../context/WalletContext';

export function RestorePage() {
  const navigate = useNavigate();
  const { addWallets } = useWallets();
  const [mnemonic, setMnemonic] = useState('');
  const [walletId, setWalletId] = useState('');
  const [name, setName] = useState('Restored');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restored, setRestored] = useState<LocalWallet[] | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(phrase)) {
      setError('Invalid recovery phrase');
      return;
    }
    setLoading(true);
    setError('');
    setRestored(null);
    try {
      // One seed = one Account. Derive every account variant under it
      // (XEC 1899/899/145 and DOGE 3, single-sig 44' and multisig 48') and
      // ask the server for all migrated wallets matching any of them.
      const candidates = restoreCandidatesForMnemonic(phrase);
      const byCopayer = new Map(candidates.map(c => [c.copayerId, c]));
      const byXpub = new Map(candidates.map(c => [c.xPubKey, c]));

      const recovered = (
        await api.recoverWallets({
          copayerIds: [...byCopayer.keys()],
          xPubKeys: [...byXpub.keys()]
        })
      ).wallets;
      const byWalletId = new Map(recovered.map(w => [w.id, w]));
      let matches = [...byWalletId.values()];

      const pinId = walletId.trim();
      if (pinId) {
        const info = await api.getJoinInfo(pinId);
        const isMultisig = info.n > 1;
        let creds = createCredentials({
          coin: info.coin,
          mnemonic: phrase,
          isMultisig,
          usePurpose48: isMultisig,
          coinType: info.coinType
        });

        if (!info.coinType && info.coin === 'xec') {
          const fallbackTypes = [
            isMultisig ? XEC_TOKEN_AWARE_COIN_TYPE : XEC_NATIVE_COIN_TYPE,
            XEC_RAIPAY_COIN_TYPE
          ];
          for (const coinType of fallbackTypes) {
            const candidate = createCredentials({
              coin: info.coin,
              mnemonic: phrase,
              isMultisig,
              usePurpose48: isMultisig,
              coinType
            });
            try {
              const probe = await api.probeJoinWallet(info.id, {
                name,
                coin: info.coin,
                xPubKey: candidate.xPubKey,
                requestPubKey: candidate.requestPubKey
              });
              if (probe.copayerExists) {
                creds = candidate;
                break;
              }
            } catch {
              // try next variant
            }
          }
        }
        byCopayer.set(creds.copayerId, creds);
        // Merge the pinned wallet in — never discard the other accounts
        // recovered from the same seed.
        if (!byWalletId.has(info.id)) {
          matches.push({ ...info, copayerId: creds.copayerId });
        }
      }

      if (matches.length === 0) {
        setError('No wallets found for this recovery phrase on the server');
        return;
      }

      const restoredWallets: LocalWallet[] = [];
      for (const info of matches) {
        const isMultisig = info.n > 1;
        const creds =
          byCopayer.get(info.copayerId) ??
          createCredentials({
            coin: info.coin,
            mnemonic: phrase,
            isMultisig,
            usePurpose48: isMultisig,
            coinType: info.coinType
          });

        let walletResponse;
        try {
          walletResponse = await api.getWallet({
            walletId: info.id,
            copayerId: info.copayerId,
            requestPrivKey: creds.requestPrivKey
          });
        } catch {
          const joined = await api.joinWallet(info.id, {
            name,
            coin: info.coin,
            xPubKey: creds.xPubKey,
            requestPubKey: creds.requestPubKey
          });
          walletResponse = 'wallet' in joined ? joined.wallet : joined;
        }

        // If the server copayer record uses a different xpub than the
        // copayerId lookup suggested, prefer the candidate that matches it.
        const matchedCopayer = walletResponse.copayers?.find(c => c.id === info.copayerId);
        const effectiveCreds =
          (matchedCopayer && byXpub.get(matchedCopayer.xPubKey)) || creds;

        persistJoinRecord(info.id, [
          effectiveCreds.xPubKey,
          ...(walletResponse.copayers ?? []).map(c => c.xPubKey)
        ]);
        saveCredentials(
          info.id,
          JSON.stringify({
            walletId: info.id,
            copayerId: info.copayerId,
            coin: info.coin,
            m: info.m,
            n: info.n,
            keys: {
              mnemonic: effectiveCreds.mnemonic,
              xPrivKey: effectiveCreds.xPrivKey,
              xPubKey: effectiveCreds.xPubKey,
              requestPrivKey: effectiveCreds.requestPrivKey,
              requestPubKey: effectiveCreds.requestPubKey,
              copayerId: info.copayerId,
              walletPrivKey: effectiveCreds.walletPrivKey,
              walletPubKey: effectiveCreds.walletPubKey,
              coinType: effectiveCreds.coinType ?? info.coinType,
              accountPath: effectiveCreds.accountPath
            }
          })
        );
        restoredWallets.push(
          walletFromResponse(walletResponse, info.copayerId, name, {
            creds: effectiveCreds,
            coinType: effectiveCreds.coinType ?? info.coinType,
            accountId: accountIdForCredentials(effectiveCreds)
          })
        );
      }

      const sorted = sortAccountWallets(restoredWallets);
      addWallets(sorted);
      setRestored(sorted);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (restored) {
    return (
      <div className="max-w-lg mx-auto">
        <header className="px-4 py-4 border-b border-white/10">
          <h1 className="text-lg font-medium text-center">Account Restored</h1>
        </header>
        <div className="px-4 py-6 space-y-4">
          <p className="text-sm text-[var(--abcpay-muted)]">
            One seed is one Account. We recovered {restored.length}{' '}
            {restored.length === 1 ? 'wallet' : 'wallets'} under this seed — single-sig and
            multisig, across every derivation (1899, 899, 145, DOGE).
          </p>
          <div className="space-y-2">
            {restored.map(wallet => (
              <button
                key={wallet.id}
                type="button"
                onClick={() => navigate(`/wallet/${wallet.id}`)}
                className="w-full text-left p-4 bg-[var(--abcpay-surface)] rounded-xl hover:bg-[var(--abcpay-surface-2)]"
              >
                <span className="font-medium">{wallet.name}</span>
                <span className="block text-xs text-[var(--abcpay-muted)] mt-1">
                  {wallet.coin.toUpperCase()}
                  {wallet.coinType ? ` · ${wallet.coinType}` : ''}
                  {wallet.n > 1 ? ` · ${wallet.m}-of-${wallet.n} multisig` : ' · single-sig'} ·{' '}
                  {wallet.status}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium"
          >
            Go to Account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Restore Account</h1>
      </header>
      <form onSubmit={onSubmit} className="px-4 py-6 space-y-5">
        <p className="text-sm text-[var(--abcpay-muted)]">
          Enter your 12-word recovery phrase. One seed is one Account: we recover{' '}
          <strong>all</strong> wallets under it — XEC 1899, 899 and RaiPay 145, single-sig and
          multisig, plus DOGE — from the migrated server database. No wallet ID required. Private
          keys stay on this device.
        </p>
        <textarea
          value={mnemonic}
          onChange={e => setMnemonic(e.target.value)}
          rows={4}
          placeholder="twelve words …"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
        />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
        />
        <details className="text-sm text-[var(--abcpay-muted)]">
          <summary className="cursor-pointer">Advanced: pin a wallet ID</summary>
          <input
            value={walletId}
            onChange={e => setWalletId(e.target.value)}
            placeholder="Optional wallet ID"
            className="mt-3 w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 font-mono text-sm outline-none focus:border-[var(--abcpay-accent)]"
          />
        </details>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium disabled:opacity-50"
        >
          {loading ? 'Restoring all wallets…' : 'Restore Account'}
        </button>
      </form>
    </div>
  );
}
