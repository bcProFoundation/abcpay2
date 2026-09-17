import Mnemonic from '@bcpros/bitcore-mnemonic';
import {
  BitcoreLib as Bitcore
} from '@bcpros/crypto-wallet-core';
import type { SupportedCoin } from '@bcpros/abcpay-models';
import { defaultWalletCoinType } from '@bcpros/abcpay-models';
import { copayerIdFromXpub, signMessage } from '@bcpros/abcpay-wallet-core';
import { api } from './api';

const REQUEST_KEY_PATH = "m/1'/0";

export interface WalletKeys {
  mnemonic: string;
  xPrivKey: string;
  xPubKey: string;
  requestPrivKey: string;
  requestPubKey: string;
  copayerId: string;
  walletPrivKey: string;
  walletPubKey: string;
  coinType: number;
}

export function generateKeys(coin: SupportedCoin, n: number): WalletKeys {
  const mnemonic = new Mnemonic(Mnemonic.Words.ENGLISH);
  const xPrivKey = mnemonic.toHDPrivateKey('', 'livenet');
  const purpose = n > 1 ? 48 : 44;
  const coinType = defaultWalletCoinType(coin, n > 1);
  const path = `m/${purpose}'/${coinType}'/0'`;
  const accountKey = xPrivKey.deriveChild(path);
  const requestKey = xPrivKey.deriveChild(REQUEST_KEY_PATH);
  const walletPrivKey = new Bitcore.PrivateKey().toString();

  return {
    mnemonic: mnemonic.phrase,
    xPrivKey: accountKey.toString(),
    xPubKey: accountKey.hdPublicKey.toString(),
    requestPrivKey: requestKey.privateKey.toString(),
    requestPubKey: requestKey.hdPublicKey.publicKey.toString(),
    copayerId: copayerIdFromXpub(coin, accountKey.hdPublicKey.toString()),
    walletPrivKey,
    walletPubKey: new Bitcore.PrivateKey(walletPrivKey).toPublicKey().toString(),
    coinType
  };
}

export interface StoredWallet {
  walletId: string;
  copayerId: string;
  coin: SupportedCoin;
  m: number;
  n: number;
  keys: WalletKeys;
  secret?: string;
}

function buildSecret(walletId: string, walletPrivKey: string, coin: SupportedCoin): string {
  const widHex = Buffer.from(walletId.replace(/-/g, ''), 'hex');
  const B58 = Bitcore.encoding.Base58;
  const widBase58 = new B58(widHex).toString();
  const wif = new Bitcore.PrivateKey(walletPrivKey).toWIF();
  return widBase58.padEnd(22, '0') + wif + 'L' + coin;
}

function parseSecret(secret: string): { walletId: string; walletPrivKey: string; coin: SupportedCoin } {
  const widBase58 = secret.slice(0, 22).replace(/0/g, '');
  const widHex = Bitcore.encoding.Base58.decode(widBase58).toString('hex');
  const walletId = [widHex.slice(0, 8), widHex.slice(8, 12), widHex.slice(12, 16), widHex.slice(16, 20), widHex.slice(20)].join('-');
  const walletPrivKey = Bitcore.PrivateKey.fromString(secret.slice(22, 74)).toString();
  const coin = secret.slice(75) as SupportedCoin;
  return { walletId, walletPrivKey, coin };
}

export async function createWallet(opts: {
  name: string;
  copayerName: string;
  coin: SupportedCoin;
  m: number;
  n: number;
}): Promise<StoredWallet> {
  const keys = generateKeys(opts.coin, opts.n);

  const createRes = await api.createWallet({
    name: opts.name,
    m: opts.m,
    n: opts.n,
    coin: opts.coin,
    coinType: keys.coinType,
    network: 'livenet',
    addressType: 'P2SH',
    pubKey: keys.walletPubKey,
    usePurpose48: opts.n > 1
  });

  const walletId = createRes.walletId ?? createRes.id;
  const copayerHash = [opts.copayerName, keys.xPubKey, keys.requestPubKey].join('|');

  await api.joinWallet(walletId, {
    name: opts.copayerName,
    coin: opts.coin,
    xPubKey: keys.xPubKey,
    requestPubKey: keys.requestPubKey,
    copayerSignature: signMessage(copayerHash, keys.walletPrivKey)
  });

  const secret = opts.n > 1 ? buildSecret(walletId, keys.walletPrivKey, opts.coin) : undefined;

  if (opts.n === 1 || opts.m === opts.n) {
    await api.createAddress(walletId, keys.copayerId, keys.requestPrivKey);
  }

  return { walletId, copayerId: keys.copayerId, coin: opts.coin, m: opts.m, n: opts.n, keys, secret };
}

export async function joinWallet(opts: {
  secret: string;
  copayerName: string;
  coin: SupportedCoin;
}): Promise<StoredWallet> {
  const { walletId, walletPrivKey, coin } = parseSecret(opts.secret);
  const walletInfo = await api.getWalletInfo(walletId);
  const keys = generateKeys(coin, walletInfo.n);

  const copayerHash = [opts.copayerName, keys.xPubKey, keys.requestPubKey].join('|');
  keys.walletPrivKey = walletPrivKey;
  keys.walletPubKey = new Bitcore.PrivateKey(walletPrivKey).toPublicKey().toString();

  await api.joinWallet(walletId, {
    name: opts.copayerName,
    coin,
    xPubKey: keys.xPubKey,
    requestPubKey: keys.requestPubKey,
    copayerSignature: signMessage(copayerHash, keys.walletPrivKey)
  });

  return {
    walletId,
    copayerId: keys.copayerId,
    coin,
    m: walletInfo.m,
    n: walletInfo.n,
    keys
  };
}

export async function getReceiveAddress(stored: StoredWallet): Promise<string> {
  const addr = await api.createAddress(
    stored.walletId,
    stored.copayerId,
    stored.keys.requestPrivKey
  );
  return addr.address;
}

export async function getBalance(stored: StoredWallet): Promise<number> {
  const balance = await api.getBalance(
    stored.walletId,
    stored.copayerId,
    stored.keys.requestPrivKey
  );
  return balance.totalAmount;
}

export function serializeWallet(stored: StoredWallet): string {
  return JSON.stringify(stored);
}

export function deserializeWallet(json: string): StoredWallet {
  return JSON.parse(json);
}
