import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE,
  XEC_TOKEN_AWARE_COIN_TYPE
} from '@bcpros/abcpay-models';
import {
  createCredentials,
  isValidMnemonic,
  restoreCandidatesForMnemonic,
  seedIdForCredentials,
  sortAccounts,
  walletDisplayId
} from '@bcpros/abcpay-wallet-core';
import { api } from '../lib/api';
import { saveCredentials } from '../lib/credentials-store';
import { persistJoinRecord } from '../lib/proposal-verify';
import {
  useWallets,
  walletFromResponse,
  accountDisplayTitle,
  type LocalAccount
} from '../context/WalletContext';

const SEED_ID_RE = /^(02|03)[0-9a-fA-F]{64}$/;

export function RestorePage() {
  const navigate = useNavigate();
  const { addAccounts } = useWallets();
  const [mnemonic, setMnemonic] = useState('');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('Restored');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restored, setRestored] = useState<LocalAccount[] | null>(null);

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
      // A seed is a Wallet. Derive every Account under it (XEC 1899/899/145
      // and DOGE 3, single-sig 44' and multisig 48') and ask the server for
      // all migrated Accounts matching any of them — by copayer, by xpub,
      // and by Wallet (seed) id, which alone covers every Account.
      const candidates = restoreCandidatesForMnemonic(phrase);
      const byCopayer = new Map(candidates.map(c => [c.copayerId, c]));
      const byXpub = new Map(candidates.map(c => [c.xPubKey, c]));
      const seedId = seedIdForCredentials(candidates[0]);

      const recovered = (
        await api.recoverWallets({
          copayerIds: [...byCopayer.keys()],
          xPubKeys: [...byXpub.keys()],
          requestPubKeys: [seedId]
        })
      ).wallets;
      const byAccountId = new Map(recovered.map(w => [w.id, w]));
      let matches = [...byAccountId.values()];

      const pinValue = pin.trim();
      if (pinValue && SEED_ID_RE.test(pinValue)) {
        // Wallet ID pointing at a seed: recover every Account under it.
        const seeded = (
          await api.recoverWallets({ requestPubKeys: [pinValue.toLowerCase()] })
        ).wallets;
        for (const info of seeded) {
          if (!byAccountId.has(info.id)) matches.push(info);
        }
      } else if (pinValue) {
        // Legacy internal account id — kept for compatibility, not shown in UI.
        const info = await api.getJoinInfo(pinValue);
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
        // Merge the pinned Account in — never discard the other Accounts
        // recovered from the same Wallet (seed).
        if (!byAccountId.has(info.id)) {
          matches.push({ ...info, copayerId: creds.copayerId });
        }
      }

      if (matches.length === 0) {
        setError('No Accounts found for this seed on the server');
        return;
      }

      const restoredAccounts: LocalAccount[] = [];
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

        let accountResponse;
        try {
          accountResponse = await api.getWallet({
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
          accountResponse = 'wallet' in joined ? joined.wallet : joined;
        }

        const matchedCopayer = accountResponse.copayers?.find(c => c.id === info.copayerId);
        const effectiveCreds =
          (matchedCopayer && byXpub.get(matchedCopayer.xPubKey)) || creds;

        persistJoinRecord(info.id, [
          effectiveCreds.xPubKey,
          ...(accountResponse.copayers ?? []).map(c => c.xPubKey)
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
        restoredAccounts.push(
          walletFromResponse(accountResponse, info.copayerId, name, {
            creds: effectiveCreds,
            coinType: effectiveCreds.coinType ?? info.coinType,
            seedId: seedIdForCredentials(effectiveCreds)
          })
        );
      }

      const sorted = sortAccounts(restoredAccounts);
      addAccounts(sorted);
      setRestored(sorted);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (restored) {
    const seedId = restored[0]?.seedId;
    return (
      <div className="max-w-lg mx-auto">
        <header className="px-4 py-4 border-b border-white/10">
          <h1 className="text-lg font-medium text-center">Wallet Restored</h1>
        </header>
        <div className="px-4 py-6 space-y-4">
          <p className="text-sm text-[var(--abcpay-muted)]">
            A seed is a Wallet{seedId ? ` (${walletDisplayId(seedId)})` : ''}. We recovered{' '}
            {restored.length} {restored.length === 1 ? 'Account' : 'Accounts'} under it —
            single-sig and multisig, across every derivation (1899, 899, 145, DOGE). Each
            Account shows its path and coin; tokens live under each Account and are hidden
            until you enable them in Settings.
          </p>
          <div className="space-y-2">
            {restored.map(account => (
              <button
                key={account.id}
                type="button"
                onClick={() => navigate(`/wallet/${account.id}`)}
                className="w-full text-left p-4 bg-[var(--abcpay-surface)] rounded-xl hover:bg-[var(--abcpay-surface-2)]"
              >
                <span className="font-medium font-mono">
                  Account · {accountDisplayTitle(account)}
                </span>
                <span className="block text-xs text-[var(--abcpay-muted)] mt-1">
                  {account.coin.toUpperCase()} · {account.network ?? 'livenet'} · {account.status}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium"
          >
            Go to Wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Restore Wallet</h1>
      </header>
      <form onSubmit={onSubmit} className="px-4 py-6 space-y-5">
        <p className="text-sm text-[var(--abcpay-muted)]">
          Enter your 12-word seed phrase. A seed is a Wallet: we recover <strong>all</strong>{' '}
          Accounts under it — XEC 1899, 899 and RaiPay 145, single-sig and multisig, plus DOGE —
          from the migrated server database. Private keys stay on this device.
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
          <summary className="cursor-pointer">Advanced: pin a Wallet (seed) ID</summary>
          <input
            value={pin}
            onChange={e => setPin(e.target.value)}
            placeholder="Wallet (seed) ID — or a legacy account ID"
            className="mt-3 w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 font-mono text-sm outline-none focus:border-[var(--abcpay-accent)]"
          />
        </details>
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-4 bg-[var(--abcpay-accent)] rounded-xl font-medium disabled:opacity-50"
        >
          {loading ? 'Restoring all Accounts…' : 'Restore Wallet'}
        </button>
      </form>
    </div>
  );
}
