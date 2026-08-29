import type {
  BalanceResponse,
  CreateWalletRequest,
  JoinWalletRequest,
  SupportedCoin,
  TxProposal,
  WalletResponse,
  AddressResponse
} from '@bcpros/abcpay-models';
import { BitcoreLib as Bitcore } from '@bcpros/crypto-wallet-core';

const BWS_URL = import.meta.env.VITE_BWS_URL ?? '/bws/api';

interface RequestHeaders {
  walletId?: string;
  copayerId?: string;
  requestPrivKey?: string;
}

function hashMessage(message: string): Buffer {
  const msg = Buffer.from(message);
  const buf = Buffer.concat([Buffer.from('\x18Bitcoin Signed Message:\n'), Buffer.from([msg.length]), msg]);
  return Bitcore.crypto.Hash.sha256sha256(buf);
}

function signRequest(method: string, path: string, args: unknown, privKey: string): string {
  const message = `${method.toLowerCase()}|${path}|${JSON.stringify(args)}`;
  const priv = new Bitcore.PrivateKey(privKey);
  const hash = hashMessage(message);
  return Bitcore.crypto.ECDSA.sign(hash, priv, { endian: 'little' }).toString();
}

async function bwsFetch<T>(
  path: string,
  options: RequestInit = {},
  headers: RequestHeaders = {}
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>)
  };

  if (headers.walletId) reqHeaders['x-wallet-id'] = headers.walletId;
  if (headers.copayerId) {
    reqHeaders['x-copayer-id'] = headers.copayerId;
    reqHeaders['x-identity'] = headers.copayerId;
  }

  let body: unknown = {};
  if (options.body) {
    body = JSON.parse(options.body as string);
  }

  if (headers.requestPrivKey && headers.copayerId) {
    reqHeaders['x-signature'] = signRequest(method, path, body, headers.requestPrivKey);
  }

  const res = await fetch(`${BWS_URL}${path}`, { ...options, headers: reqHeaders });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? 'Request failed');
  }

  return res.json();
}

export const api = {
  createWallet(data: CreateWalletRequest): Promise<{ walletId: string; id?: string }> {
    return bwsFetch('/v2/wallets/', { method: 'POST', body: JSON.stringify(data) });
  },

  joinWallet(walletId: string, data: Omit<JoinWalletRequest, 'walletId'>): Promise<{ wallet: WalletResponse }> {
    return bwsFetch(`/v2/wallets/${walletId}/copayers`, {
      method: 'POST',
      body: JSON.stringify({ ...data, walletId })
    });
  },

  getWalletInfo(walletId: string): Promise<{ m: number; n: number; coin: SupportedCoin; status: string }> {
    return bwsFetch(`/v1/wallets/${walletId}/info`);
  },

  getWallet(walletId: string, copayerId: string, requestPrivKey: string): Promise<WalletResponse> {
    const path = '/v3/wallets/?includeExtendedInfo=1&serverMessageArray=1';
    return bwsFetch<{ wallet: WalletResponse }>(path, {}, { walletId, copayerId, requestPrivKey }).then(
      res => res.wallet
    );
  },

  createAddress(
    walletId: string,
    copayerId: string,
    requestPrivKey: string,
    isChange = false
  ): Promise<AddressResponse> {
    return bwsFetch(
      '/v4/addresses/',
      {
        method: 'POST',
        body: JSON.stringify({ isChange })
      },
      { walletId, copayerId, requestPrivKey }
    );
  },

  getBalance(walletId: string, copayerId: string, requestPrivKey: string): Promise<BalanceResponse> {
    return bwsFetch('/v1/balance/', {}, { walletId, copayerId, requestPrivKey });
  },

  getTxProposals(walletId: string, copayerId: string, requestPrivKey: string): Promise<TxProposal[]> {
    return bwsFetch('/v1/txproposals/', {}, { walletId, copayerId, requestPrivKey });
  },

  getFiatRate(coin: SupportedCoin): Promise<{ rate: number; fetchedOn: number }> {
    return bwsFetch(`/v3/fiatrates/${coin}/`);
  },

  getFeeLevels(coin: SupportedCoin) {
    return bwsFetch(`/v2/feelevels/?coin=${coin}`);
  }
};
