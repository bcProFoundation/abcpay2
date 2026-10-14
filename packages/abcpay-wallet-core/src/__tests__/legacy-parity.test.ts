import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultWalletCoinType } from '@bcpros/abcpay-models';
import {
  copayerIdFromXpub,
  createCredentials,
  deriveWalletAddress,
  signRequest,
  verifyRequest
} from '../index';

interface LegacyCopayer {
  label: string;
  mnemonic: string;
  rootPath: string;
  xPrivKey: string;
  xPubKey: string;
  requestPrivKey: string;
  requestPubKey: string;
  copayerId: string;
}

interface LegacyWallet {
  id: string;
  coin: 'xec' | 'doge';
  coinType: number;
  isSlpToken: boolean;
  m: number;
  n: number;
  addressType: string;
  copayers: LegacyCopayer[];
  addresses: Array<{ path: string; isChange: boolean; address: string; publicKeys: string[] }>;
}

interface LegacyFixture {
  network: string;
  account: number;
  wallets: LegacyWallet[];
  auth: {
    copayerId: string;
    requestPubKey: string;
    vectors: Array<{ message: string; signature: string }>;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-parity.json', import.meta.url), 'utf8')
) as LegacyFixture;

function normalizeXecAddress(address: string): string {
  return address.toLowerCase().replace(/^ecash:/, '').replace(/^bitcoincash:/, '');
}

function normalizeAddress(coin: 'xec' | 'doge', address: string): string {
  return coin === 'xec' ? normalizeXecAddress(address) : address;
}

function splitRequestMessage(message: string): { method: string; path: string; body: string } {
  const first = message.indexOf('|');
  const second = message.indexOf('|', first + 1);
  return {
    method: message.slice(0, first),
    path: message.slice(first + 1, second),
    body: message.slice(second + 1)
  };
}

describe('legacy BWC parity (AbcPay v1 fixtures)', () => {
  it('fixture covers XEC 899, XEC 1899 and DOGE wallets', () => {
    expect(fixture.wallets.map(w => w.id)).toEqual([
      'xec-899-1of1',
      'xec-899-2of2',
      'xec-899-2of3',
      'xec-1899-1of1',
      'xec-1899-2of2',
      'xec-1899-2of3',
      'doge-3-1of1',
      'doge-3-2of2',
      'doge-3-2of3'
    ]);
  });

  it('uses the product default coin types (single-sig 1899, multisig 899)', () => {
    expect(defaultWalletCoinType('xec', false)).toBe(1899);
    expect(defaultWalletCoinType('xec', true)).toBe(899);
    expect(defaultWalletCoinType('doge', false)).toBe(3);
    expect(defaultWalletCoinType('doge', true)).toBe(3);
  });

  for (const wallet of fixture.wallets) {
    describe(wallet.id, () => {
      it('derives legacy credentials, request keys and copayer ids', () => {
        for (const copayer of wallet.copayers) {
          const creds = createCredentials({
            coin: wallet.coin,
            mnemonic: copayer.mnemonic,
            isMultisig: wallet.n > 1,
            usePurpose48: wallet.n > 1,
            coinType: wallet.coinType
          });
          expect(creds.accountPath).toBe(copayer.rootPath);
          expect(creds.xPubKey).toBe(copayer.xPubKey);
          expect(creds.xPrivKey).toBe(copayer.xPrivKey);
          expect(creds.requestPrivKey).toBe(copayer.requestPrivKey);
          expect(creds.requestPubKey).toBe(copayer.requestPubKey);
          expect(creds.copayerId).toBe(copayer.copayerId);
          expect(copayerIdFromXpub(wallet.coin, copayer.xPubKey)).toBe(copayer.copayerId);
        }
      });

      it('derives legacy addresses and public key ring order', () => {
        const xPubKeys = wallet.copayers.map(c => c.xPubKey);
        for (const addr of wallet.addresses) {
          const derived = deriveWalletAddress({
            coin: wallet.coin,
            xPubKeys,
            m: wallet.m,
            n: wallet.n,
            path: addr.path
          });
          expect(normalizeAddress(wallet.coin, derived.address)).toBe(
            normalizeAddress(wallet.coin, addr.address)
          );
          expect(derived.publicKeys).toEqual(addr.publicKeys);
        }
      });
    });
  }

  describe('request auth', () => {
    it('verifies and reproduces legacy request signatures byte-for-byte', () => {
      expect(fixture.auth.vectors.length).toBeGreaterThan(0);
      for (const vector of fixture.auth.vectors) {
        const { method, path, body } = splitRequestMessage(vector.message);
        expect(
          verifyRequest(fixture.auth.requestPubKey, vector.signature, method, path, body)
        ).toBe(true);
        expect(
          signRequest(fixture.wallets[0].copayers[0].requestPrivKey, method, path, body)
        ).toBe(vector.signature);
      }
    });

    it('rejects a signature for a different url', () => {
      const vector = fixture.auth.vectors[0];
      const { method, path, body } = splitRequestMessage(vector.message);
      expect(
        verifyRequest(fixture.auth.requestPubKey, vector.signature, method, `${path}x`, body)
      ).toBe(false);
    });
  });
});
