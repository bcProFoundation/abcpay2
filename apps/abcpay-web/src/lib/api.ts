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

interface RequestHeaders {
  walletId?: string;
  copayerId?: string;
  requestPrivKey?: string;
}

function headersFromAuth(auth: AuthContext): RequestHeaders {
  return {
    walletId: auth.walletId,
    copayerId: auth.copayerId,
    requestPrivKey: auth.requestPrivKey
  };
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
    reqHeaders['x-signature'] = signRequest(headers.requestPrivKey, method, path, JSON.stringify(body));
  }

  const res = await fetch(`${BWS_URL}${path}`, { ...options, headers: reqHeaders });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message ?? 'Request failed');
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  createWallet(data: CreateWalletRequest): Promise<{ walletId: string; id?: string }> {
    return bwsFetch('/v2/wallets/', { method: 'POST', body: JSON.stringify(data) });
  },

  joinWallet(
    walletId: string,
    data: Omit<JoinWalletRequest, 'walletId'>
  ): Promise<{ wallet: WalletResponse } | WalletResponse> {
    return bwsFetch(`/v2/wallets/${walletId}/copayers`, {
      method: 'POST',
      body: JSON.stringify({ ...data, walletId })
    });
  },

  probeJoinWallet(
    walletId: string,
    data: Omit<JoinWalletRequest, 'walletId'>
  ): Promise<{ dryRun: boolean; copayerExists: boolean }> {
    return bwsFetch(`/v2/wallets/${walletId}/copayers`, {
      method: 'POST',
      body: JSON.stringify({ ...data, walletId, dryRun: true })
    });
  },

  getWalletInfo(walletId: string): Promise<{ m: number; n: number; coin: SupportedCoin; status: string }> {
    return bwsFetch(`/v1/wallets/${walletId}/info`);
  },

  getJoinInfo(walletId: string): Promise<JoinInfo> {
    return bwsFetch(`/v1/wallets/${walletId}/join-info/`);
  },

  getWallet(
    authOrWalletId: AuthContext | string,
    copayerId?: string,
    requestPrivKey?: string
  ): Promise<WalletResponse> {
    const path = '/v3/wallets/?includeExtendedInfo=1&serverMessageArray=1';
    const headers =
      typeof authOrWalletId === 'string'
        ? { walletId: authOrWalletId, copayerId: copayerId!, requestPrivKey: requestPrivKey! }
        : headersFromAuth(authOrWalletId);
    return bwsFetch<{ wallet: WalletResponse }>(path, {}, headers).then(res => res.wallet);
  },

  createAddress(
    authOrWalletId: AuthContext | string,
    copayerIdOrIsChange?: string | boolean,
    requestPrivKey?: string,
    isChange = false
  ): Promise<AddressResponse> {
    const headers =
      typeof authOrWalletId === 'string'
        ? {
            walletId: authOrWalletId,
            copayerId: copayerIdOrIsChange as string,
            requestPrivKey: requestPrivKey!
          }
        : headersFromAuth(authOrWalletId);
    const change =
      typeof authOrWalletId === 'string'
        ? typeof copayerIdOrIsChange === 'boolean'
          ? copayerIdOrIsChange
          : isChange
        : typeof copayerIdOrIsChange === 'boolean'
          ? copayerIdOrIsChange
          : false;

    return bwsFetch(
      '/v4/addresses/',
      {
        method: 'POST',
        body: JSON.stringify({ isChange: change })
      },
      headers
    );
  },

  getMainAddress(auth: AuthContext): Promise<AddressResponse> {
    return bwsFetch('/v1/addresses/main/', {}, headersFromAuth(auth));
  },

  getBalance(
    authOrWalletId: AuthContext | string,
    copayerId?: string,
    requestPrivKey?: string
  ): Promise<BalanceResponse> {
    const headers =
      typeof authOrWalletId === 'string'
        ? { walletId: authOrWalletId, copayerId: copayerId!, requestPrivKey: requestPrivKey! }
        : headersFromAuth(authOrWalletId);
    return bwsFetch('/v1/balance/', {}, headers);
  },

  getUtxos(auth: AuthContext) {
    return bwsFetch<
      Array<{
        txid: string;
        vout: number;
        satoshis: number;
        address: string;
        path?: string;
        publicKeys?: string[];
      }>
    >('/v1/utxos/', {}, headersFromAuth(auth));
  },

  getHistory(auth: AuthContext): Promise<TxHistoryItem[]> {
    return bwsFetch('/v1/txhistory/', {}, headersFromAuth(auth));
  },

  getTxProposals(
    authOrWalletId: AuthContext | string,
    copayerId?: string,
    requestPrivKey?: string
  ): Promise<TxProposal[]> {
    const headers =
      typeof authOrWalletId === 'string'
        ? { walletId: authOrWalletId, copayerId: copayerId!, requestPrivKey: requestPrivKey! }
        : headersFromAuth(authOrWalletId);
    return bwsFetch('/v1/txproposals/', {}, headers);
  },

  createTxProposal(auth: AuthContext, data: CreateTxProposalRequest): Promise<TxProposal> {
    return bwsFetch('/v3/txproposals/', { method: 'POST', body: JSON.stringify(data) }, headersFromAuth(auth));
  },

  signTxProposal(auth: AuthContext, id: string, signatures: string[]): Promise<TxProposal> {
    return bwsFetch(
      `/v1/txproposals/${id}/signatures/`,
      { method: 'POST', body: JSON.stringify({ signatures }) },
      headersFromAuth(auth)
    );
  },

  rejectTxProposal(auth: AuthContext, id: string, reason?: string): Promise<TxProposal> {
    return bwsFetch(
      `/v1/txproposals/${id}/rejections/`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      headersFromAuth(auth)
    );
  },

  broadcastTxProposal(auth: AuthContext, id: string, raw: string): Promise<TxProposal> {
    return bwsFetch(
      `/v1/txproposals/${id}/broadcast/`,
      { method: 'POST', body: JSON.stringify({ raw }) },
      headersFromAuth(auth)
    );
  },

  getFiatRate(coin: SupportedCoin): Promise<{ rate: number; fetchedOn: number }> {
    return bwsFetch(`/v3/fiatrates/${coin}/`);
  },

  getFeeLevels(coin: SupportedCoin) {
    return bwsFetch(`/v2/feelevels/?coin=${coin}`);
  }
};
