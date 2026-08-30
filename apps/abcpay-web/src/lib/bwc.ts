import type { SupportedCoin } from '@bcpros/abcpay-models';
import {
  createWallet,
  joinWallet,
  getBalance,
  serializeWallet,
  deserializeWallet,
  type StoredWallet
} from './wallet-client';

export type { StoredWallet };
export { deserializeWallet, serializeWallet, getReceiveAddress } from './wallet-client';

export async function createWalletWithBwc(opts: {
  name: string;
  copayerName: string;
  coin: SupportedCoin;
  m: number;
  n: number;
}) {
  const stored = await createWallet(opts);
  return {
    walletId: stored.walletId,
    copayerId: stored.copayerId,
    secret: stored.secret,
    credentials: serializeWallet(stored)
  };
}

export async function joinWalletWithBwc(opts: {
  secret: string;
  copayerName: string;
  coin: SupportedCoin;
}) {
  const stored = await joinWallet(opts);
  return {
    walletId: stored.walletId,
    copayerId: stored.copayerId,
    credentials: serializeWallet(stored)
  };
}

export async function getWalletBalance(credentialsJson: string): Promise<number> {
  const stored = deserializeWallet(credentialsJson);
  return getBalance(stored);
}

export async function createAndPublishTx(_opts: {
  credentialsJson: string;
  toAddress: string;
  amount: number;
  message?: string;
}): Promise<{ id: string; status: string }> {
  throw new Error('Send transactions via the BWS tx proposal API — coming soon for multisig flows');
}

export async function signAndBroadcastTx(_credentialsJson: string, _txp: { id: string }): Promise<string> {
  throw new Error('Broadcast via BWS tx proposal API — coming soon for multisig flows');
}
