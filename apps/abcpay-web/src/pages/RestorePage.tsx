import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { XEC_NATIVE_COIN_TYPE, XEC_RAIPAY_COIN_TYPE, XEC_TOKEN_AWARE_COIN_TYPE } from '@bcpros/abcpay-models';
import { createCredentials, isValidMnemonic } from '@bcpros/abcpay-wallet-core';
import { api } from '../lib/api';
import { saveCredentials } from '../lib/credentials-store';
import { useWallets, walletFromResponse } from '../context/WalletContext';

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
    if (!walletId.trim()) {
      setError('Wallet ID is required to re-attach an existing wallet');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const info = await api.getJoinInfo(walletId.trim());
      const isMultisig = info.n > 1;
      let creds = createCredentials({
        coin: info.coin,
        mnemonic: phrase,
        isMultisig,
        usePurpose48: isMultisig,
        coinType: info.coinType
      });

      if (!info.coinType && info.coin === 'xec') {
        const candidates = [
          isMultisig ? XEC_TOKEN_AWARE_COIN_TYPE : XEC_NATIVE_COIN_TYPE,
          XEC_RAIPAY_COIN_TYPE
        ];
        for (const coinType of candidates) {
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
            // try the next candidate variant
          }
        }
      }

      let walletResponse;
      try {
        const joined = await api.joinWallet(info.id, {
          name,
          coin: info.coin,
          xPubKey: creds.xPubKey,
          requestPubKey: creds.requestPubKey
        });
        walletResponse = 'wallet' in joined ? joined.wallet : joined;
      } catch {
        walletResponse = await api.getWallet({
          walletId: info.id,
          copayerId: creds.copayerId,
          requestPrivKey: creds.requestPrivKey
        });
      }

      saveCredentials(
        info.id,
        JSON.stringify({
          walletId: info.id,
          copayerId: creds.copayerId,
          coin: info.coin,
          m: info.m,
          n: info.n,
          keys: {
            mnemonic: creds.mnemonic,
            xPrivKey: creds.xPrivKey,
            xPubKey: creds.xPubKey,
            requestPrivKey: creds.requestPrivKey,
            requestPubKey: creds.requestPubKey,
            copayerId: creds.copayerId,
            walletPrivKey: creds.walletPrivKey,
            walletPubKey: creds.walletPubKey
          }
        })
      );
      addWallet(walletFromResponse(walletResponse, creds.copayerId, name));
      navigate(`/wallet/${walletResponse.id}`);
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
          Enter your 12-word phrase and the wallet ID from AbcPay. Private keys stay on this device.
        </p>
        <textarea
          value={mnemonic}
          onChange={e => setMnemonic(e.target.value)}
          rows={4}
          placeholder="twelve words …"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
        />
        <input
          value={walletId}
          onChange={e => setWalletId(e.target.value)}
          placeholder="Wallet ID"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 font-mono text-sm outline-none focus:border-[var(--abcpay-accent)]"
        />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          className="w-full px-4 py-3 bg-[var(--abcpay-surface)] rounded-xl border border-white/10 outline-none focus:border-[var(--abcpay-accent)]"
        />
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
