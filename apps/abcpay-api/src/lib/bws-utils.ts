import sjcl from 'sjcl';
import {
  BitcoreLib as Bitcore,
  BitcoreLibDoge,
  BitcoreLibXec
} from '@bcpros/crypto-wallet-core';

export interface PublicKeyRingEntry {
  xPubKey: string;
  requestPubKey: string;
}

export function xPubToCopayerId(chain: string, xpub: string): string {
  const normalized = chain.toLowerCase();
  const str = normalized === 'btc' ? xpub : normalized + xpub;
  const hash = sjcl.hash.sha256.hash(str);
  return sjcl.codec.hex.fromBits(hash);
}

export function deriveAddressFromRing(opts: {
  scriptType: string;
  publicKeyRing: PublicKeyRingEntry[];
  path: string;
  m: number;
  network: string;
  chain: string;
}): { address: string; publicKeys: string[] } {
  const { scriptType, publicKeyRing, path, m, network, chain } = opts;
  const chainLower = chain.toLowerCase();

  const bitcoreLibs: Record<string, typeof Bitcore> = {
    btc: Bitcore,
    doge: BitcoreLibDoge,
    xec: BitcoreLibXec
  };

  const bitcore = bitcoreLibs[chainLower] ?? Bitcore;

  const publicKeys = publicKeyRing.map(item => {
    const xpub = new bitcore.HDPublicKey(item.xPubKey);
    return xpub.deriveChild(path).publicKey;
  });

  let bitcoreAddress;
  if (scriptType === 'P2SH') {
    bitcoreAddress = bitcore.Address.createMultisig(publicKeys, m, network);
  } else if (scriptType === 'P2PKH') {
    bitcoreAddress = bitcore.Address.fromPublicKey(publicKeys[0], network);
  } else {
    bitcoreAddress = bitcore.Address.createMultisig(publicKeys, m, network);
  }

  return {
    address: bitcoreAddress.toString(),
    publicKeys: publicKeys.map(pk => pk.toString())
  };
}

export function formatWalletId(hexId: string): string {
  const hex = hexId.replace(/-/g, '');
  if (hex.length !== 32) return hexId;
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function normalizeWalletId(id: string): string {
  return id.replace(/-/g, '');
}
