import type {
  AddressResponse,
  BalanceResponse,
  CreateTxProposalRequest,
  CreateWalletRequest,
  JoinInfo,
  JoinWalletRequest,
  SupportedCoin,
  TxHistoryItem,
  TxProposal,
  WalletResponse
} from '@bcpros/abcpay-models';
import { signRequest } from '@bcpros/abcpay-wallet-core';

const BWS_URL = import.meta.env.VITE_BWS_URL ?? '/bws/api';

export interface AuthContext {
  walletId: string;
  copayerId: string;
  requestPrivKey: string;
}

function apiPath(path: string): string {
  const prefixed = path.startsWith('/') ? path : `/${path}`;
  const base = BWS_URL.replace(/\/$/, '');
  return `${base}${prefixed}`;
}

function signingPath(path: string): string {
  return new URL(apiPath(path), window.location.origin).pathname;
}

async function bwsFetch<T>(
  path: string,
  options: RequestInit = {},
  auth?: AuthContext
): Promise<T> {
  const body = typeof options.body === 'string' ? options.body : options.body ? JSON.stringify(options.body) : '';
  const method = (options.method ?? 'GET').toUpperCase();
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined)
  };

  if (auth) {
    reqHeaders['x-wallet-id'] = auth.walletId;
    reqHeaders['x-identity'] = auth.copayerId;
    reqHeaders['x-copayer-id'] = auth.copayerId;
    reqHeaders['x-signature'] = signRequest(
      auth.requestPrivKey,
      method,
      signingPath(path),
      method === 'GET' || method === 'HEAD' ? '' : body
    );
  }

  const res = await fetch(apiPath(path), { ...options, method, body: body || undefined, headers: reqHeaders });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? 'Request failed');
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  createWallet(data: CreateWalletRequest): Promise<WalletResponse> {
    return bwsFetch('/v2/wallets/', { method: 'POST', body: JSON.stringify(data) });
  },

  joinWallet(walletId: string, data: Omit<JoinWalletRequest, 'walletId'>): Promise<WalletResponse> {
    return bwsFetch(`/v1/wallets/${walletId}/copayers/`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  getJoinInfo(walletId: string): Promise<JoinInfo> {
    return bwsFetch(`/v1/wallets/${walletId}/join-info/`);
  },

  getWallet(auth: AuthContext): Promise<WalletResponse> {
    return bwsFetch('/v3/wallets/', {}, auth);
  },

  getMainAddress(auth: AuthContext): Promise<AddressResponse> {
    return bwsFetch('/v1/addresses/main/', {}, auth);
  },

  createAddress(auth: AuthContext, isChange = false): Promise<AddressResponse> {
    return bwsFetch('/v3/addresses/', { method: 'POST', body: JSON.stringify({ isChange }) }, auth);
  },

  getBalance(auth: AuthContext): Promise<BalanceResponse> {
    return bwsFetch('/v1/balance/', {}, auth);
  },

  getUtxos(auth: AuthContext) {
    return bwsFetch<Array<{
      txid: string;
      vout: number;
      satoshis: number;
      address: string;
      path?: string;
      publicKeys?: string[];
    }>>('/v1/utxos/', {}, auth);
  },

  getHistory(auth: AuthContext): Promise<TxHistoryItem[]> {
    return bwsFetch('/v1/txhistory/', {}, auth);
  },

  getTxProposals(auth: AuthContext): Promise<TxProposal[]> {
    return bwsFetch('/v1/txproposals/', {}, auth);
  },

  createTxProposal(auth: AuthContext, data: CreateTxProposalRequest): Promise<TxProposal> {
    return bwsFetch('/v3/txproposals/', { method: 'POST', body: JSON.stringify(data) }, auth);
  },

  signTxProposal(auth: AuthContext, id: string, signatures: string[]): Promise<TxProposal> {
    return bwsFetch(`/v1/txproposals/${id}/signatures/`, {
      method: 'POST',
      body: JSON.stringify({ signatures })
    }, auth);
  },

  rejectTxProposal(auth: AuthContext, id: string, reason?: string): Promise<TxProposal> {
    return bwsFetch(`/v1/txproposals/${id}/rejections/`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }, auth);
  },

  broadcastTxProposal(auth: AuthContext, id: string, raw: string): Promise<TxProposal> {
    return bwsFetch(`/v1/txproposals/${id}/broadcast/`, {
      method: 'POST',
      body: JSON.stringify({ raw })
    }, auth);
  },

  getFiatRate(coin: SupportedCoin): Promise<{ rate: number; fetchedOn: number }> {
    return bwsFetch(`/v3/fiatrates/${coin}/`);
  },

  getFeeLevels(coin: SupportedCoin) {
    return bwsFetch<Array<{ level: string; feePerKb: number; nbBlocks: number }>>(`/v1/feelevels/?coin=${coin}`);
  }
};
