import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  XEC_NATIVE_COIN_TYPE,
  XEC_RAIPAY_COIN_TYPE,
  XEC_TOKEN_AWARE_COIN_TYPE,
  xecRestoreCoinTypes,
  type SupportedCoin
} from '@bcpros/abcpay-models';
import { createCredentials, isValidMnemonic, type WalletCredentials } from '@bcpros/abcpay-wallet-core';
import { api } from '../lib/api';
import { saveCredentials } from '../lib/credentials-store';
import { persistJoinRecord } from '../lib/proposal-verify';
import { useWallets, walletFromResponse } from '../context/WalletContext';

function credentialsForPhrase(phrase: string): WalletCredentials[] {
  const out: WalletCredentials[] = [];
  for (const coin of ['xec', 'doge'] as SupportedCoin[]) {
    for (const isMultisig of [false, true]) {
      const coinTypes = coin === 'xec' ? xecRestoreCoinTypes(isMultisig) : [undefined];
      for (const coinType of coinTypes) {
        out.push(
          createCredentials({
            coin,
            mnemonic: phrase,
            isMultisig,
            usePurpose48: isMultisig,
            coinType
          })
        );
      }
    }
  }
  return out;
}

export function RestorePage() {
  const navigate = useNavigate();
  const { addWallet } = useWallets();
  const [mnemonic, setMnemonic] = useState('');
  const [walletId, setWalletId] = useState('');
  const [name, setName] = useState('Restored');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(phrase)) {
      setError('Invalid recovery phrase');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const candidates = credentialsForPhrase(phrase);
      const byCopayer = new Map(candidates.map(c => [c.copayerId, c]));
      const byXpub = new Map(candidates.map(c => [c.xPubKey, c]));

      let matches = (
        await api.recoverWallets({
          copayerIds: [...byCopayer.keys()],
          xPubKeys: [...byXpub.keys()]
        })
      ).wallets;

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
        matches = [{ ...info, copayerId: creds.copayerId }];
      }

      if (matches.length === 0) {
        setError('No wallets found for this recovery phrase on the server');
        return;
      }

      let firstId: string | null = null;
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

        persistJoinRecord(info.id, [
          creds.xPubKey,
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
              mnemonic: creds.mnemonic,
              xPrivKey: creds.xPrivKey,
              xPubKey: creds.xPubKey,
              requestPrivKey: creds.requestPrivKey,
              requestPubKey: creds.requestPubKey,
              copayerId: info.copayerId,
              walletPrivKey: creds.walletPrivKey,
              walletPubKey: creds.walletPubKey,
              coinType: creds.coinType ?? info.coinType
            }
          })
        );
        addWallet(walletFromResponse(walletResponse, info.copayerId, name));
        firstId ??= walletResponse.id;
      }

      navigate(firstId ? `/wallet/${firstId}` : '/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto">
      <header className="px-4 py-4 border-b border-white/10">
        <h1 className="text-lg font-medium text-center">Restore Wallet</h1>
      </header>
      <form onSubmit={onSubmit} className="px-4 py-6 space-y-5">
        <p className="text-sm text-[var(--abcpay-muted)]">
          Enter your 12-word recovery phrase. We look up your wallets from the migrated server
          database using keys derived from the phrase — no wallet ID required. Private keys stay on
          this device.
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
          {loading ? 'Restoring…' : 'Restore'}
        </button>
      </form>
    </div>
  );
}
