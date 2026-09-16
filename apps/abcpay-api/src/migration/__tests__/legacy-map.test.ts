import { describe, expect, it } from 'vitest';
import {
  addressScriptKey,
  legacyCoinTypeFor,
  mapLegacyCopayer,
  mapLegacyWallet,
  nextAddressIndex,
  publicKeyRingFromCopayers,
  type LegacyWallet
} from '../legacy-map';

const XPUB =
  'xpub6DGBtfszz1UB9KBsaw28ECjcuq2yisQ3HB369qVivipaGqVZRFtoG1ur22t3fv4y7h7QK157Cdezu4asuF4LNo8c2QDWTrWWRgoms8SzFcb';
const REQUEST_PUB =
  '033149a83d3e162e0d82484da0b081857dd7eb605701036f454b5f1831da86c3dd';

function wallet(overrides: Partial<LegacyWallet> = {}): LegacyWallet {
  return {
    id: 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90',
    name: 'Legacy wallet',
    m: 2,
    n: 3,
    coin: 'xec',
    chain: 'xec',
    network: 'livenet',
    status: 'complete',
    ...overrides
  };
}

describe('legacyCoinTypeFor', () => {
  it('maps main XEC wallets to the native 899 path', () => {
    expect(legacyCoinTypeFor(wallet())).toBe(899);
  });

  it('maps SLP XEC wallets to 1899 and isPath899 wallets to 899', () => {
    expect(legacyCoinTypeFor(wallet({ isSlpToken: true }))).toBe(1899);
    expect(legacyCoinTypeFor(wallet({ isSlpToken: true, isPath899: true }))).toBe(899);
  });

  it('maps RaiPay XEC wallets to the 145 path', () => {
    expect(legacyCoinTypeFor(wallet({ isSlpToken: true, isFromRaipay: true }))).toBe(145);
    const mapped = mapLegacyWallet(wallet({ isSlpToken: true, isFromRaipay: true }));
    expect(mapped && !('skip' in mapped) && mapped.coinType).toBe(145);
  });

  it('maps DOGE to 3', () => {
    expect(legacyCoinTypeFor(wallet({ coin: 'doge', chain: 'doge' }))).toBe(3);
  });

  it('rejects other coins', () => {
    expect(legacyCoinTypeFor(wallet({ coin: 'btc' }))).toBeNull();
  });
});

describe('mapLegacyWallet', () => {
  it('maps a multisig wallet with coin type and status', () => {
    const mapped = mapLegacyWallet(wallet({ usePurpose48: true, pubKey: '02ab' }));
    expect('skip' in mapped).toBe(false);
    if ('skip' in mapped) return;
    expect(mapped).toMatchObject({
      walletId: 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90',
      coin: 'xec',
      m: 2,
      n: 3,
      addressType: 'P2SH',
      coinType: 899,
      status: 'complete',
      usePurpose48: true
    });
  });

  it('maps single-sig to P2PKH and preserves explicit P2SH', () => {
    const single = mapLegacyWallet(wallet({ m: 1, n: 1 }));
    const singleP2sh = mapLegacyWallet(wallet({ m: 1, n: 1, addressType: 'P2SH' }));
    expect(single && !('skip' in single) && single.addressType).toBe('P2PKH');
    expect(singleP2sh && !('skip' in singleP2sh) && singleP2sh.addressType).toBe('P2SH');
  });

  it('skips unsupported coins and invalid wallets', () => {
    expect(mapLegacyWallet(wallet({ coin: 'btc' }))).toMatchObject({ skip: true });
    expect(mapLegacyWallet(wallet({ id: undefined }))).toMatchObject({ skip: true });
    expect(mapLegacyWallet(wallet({ m: 4, n: 3 }))).toMatchObject({ skip: true });
  });

  it('skips non-livenet wallets until v2 has testnet Chronik endpoints', () => {
    expect(mapLegacyWallet(wallet({ network: 'testnet' }))).toMatchObject({ skip: true });
  });
});

describe('mapLegacyCopayer', () => {
  it('preserves the legacy id and derives the expected copayer id', () => {
    const mapped = mapLegacyCopayer('w1', 'xec', {
      id: '8fed5ef1f1b5c842295e871ae84e430f1fae419521ee6fe173afbeb53b4f1e2e',
      name: 'Alice',
      xPubKey: XPUB,
      requestPubKey: REQUEST_PUB
    });
    expect('skip' in mapped).toBe(false);
    if ('skip' in mapped) return;
    expect(mapped.derivedCopayerId).toBe(
      '8fed5ef1f1b5c842295e871ae84e430f1fae419521ee6fe173afbeb53b4f1e2e'
    );
    expect(mapped.copayerId).toBe(mapped.derivedCopayerId);
  });

  it('falls back to requestPubKeys and computes the copayer id when missing', () => {
    const mapped = mapLegacyCopayer('w1', 'xec', {
      name: 'Bob',
      xPubKey: XPUB,
      requestPubKeys: [{ key: REQUEST_PUB }]
    });
    expect('skip' in mapped).toBe(false);
    if ('skip' in mapped) return;
    expect(mapped.requestPubKey).toBe(REQUEST_PUB);
    expect(mapped.copayerId).toBe(mapped.derivedCopayerId);
  });

  it('skips copayers without keys', () => {
    expect(mapLegacyCopayer('w1', 'xec', { name: 'No keys' })).toMatchObject({ skip: true });
  });
});

describe('display names', () => {
  it('falls back for encrypted or oversized names', () => {
    const encrypted = JSON.stringify({ iv: 'x'.repeat(40), cipher: 'y'.repeat(80) });
    const mapped = mapLegacyWallet(wallet({ name: encrypted }));
    expect(mapped && !('skip' in mapped) && mapped.name).toBe('Wallet a1b2c3d4');
    const copayer = mapLegacyCopayer('w1', 'xec', {
      xPubKey: XPUB,
      requestPubKey: REQUEST_PUB,
      name: encrypted
    });
    expect(copayer && !('skip' in copayer) && copayer.name).toBe('Copayer 8fed5e');
  });

  it('keeps short plaintext names', () => {
    const mapped = mapLegacyWallet(wallet({ name: 'My wallet' }));
    expect(mapped && !('skip' in mapped) && mapped.name).toBe('My wallet');
    const copayer = mapLegacyCopayer('w1', 'xec', {
      xPubKey: XPUB,
      requestPubKey: REQUEST_PUB,
      name: 'Alice'
    });
    expect(copayer && !('skip' in copayer) && copayer.name).toBe('Alice');
  });

  it('falls back for plaintext names longer than the column', () => {
    const mapped = mapLegacyWallet(wallet({ name: 'n'.repeat(120) }));
    expect(mapped && !('skip' in mapped) && mapped.name).toBe('Wallet a1b2c3d4');
  });
});

describe('nextAddressIndex', () => {
  it('continues after the highest legacy index per branch', () => {
    const addresses = [
      { path: 'm/0/0', isChange: false },
      { path: 'm/0/1', isChange: false },
      { path: 'm/1/0', isChange: true },
      { path: 'm/1/4', isChange: true }
    ];
    expect(nextAddressIndex(addresses, false)).toBe(2);
    expect(nextAddressIndex(addresses, true)).toBe(5);
    expect(nextAddressIndex([], false)).toBe(0);
  });
});

describe('addressScriptKey', () => {
  it('treats different cashaddr encodings of the same script as equal', () => {
    const derived = 'ecash:qr6latruw4nwu94s5u838setyxn2py884v5kquhq6g';
    const legacy = 'qr6latruw4nwu94s5u838setyxn2py884vdm5hv6ul';
    expect(addressScriptKey('xec', derived)).toBe(addressScriptKey('xec', legacy));
    expect(addressScriptKey('xec', derived)).toBe('p2pkh:f5feac7c7566ee16b0a70f13c32b21a6a090e7ab');
  });

  it('accepts prefixed and prefixless ecash addresses', () => {
    const withPrefix = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang';
    const withoutPrefix = 'qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang';
    expect(addressScriptKey('xec', withPrefix)).toBe(addressScriptKey('xec', withoutPrefix));
  });

  it('distinguishes different scripts and doge addresses', () => {
    const a = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang';
    const b = 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg';
    expect(addressScriptKey('xec', a)).not.toBe(addressScriptKey('xec', b));
    expect(addressScriptKey('doge', 'DBus3bamQjgJULBJtYXpEzDWQRwF5iwxgC')).not.toBe(
      addressScriptKey('doge', 'DAcDAtJRztxBHyA6D6h8du1HguyTR43Mas')
    );
  });

  it('falls back to the raw string for undecodable addresses', () => {
    expect(addressScriptKey('xec', 'not-an-address')).toBe('raw:not-an-address');
  });
});

describe('publicKeyRingFromCopayers', () => {
  it('builds the ring in copayer order', () => {
    const ring = publicKeyRingFromCopayers([
      {
        copayerId: 'a',
        derivedCopayerId: 'a',
        walletId: 'w',
        name: 'A',
        xPubKey: 'xpub-a',
        requestPubKey: 'req-a'
      },
      {
        copayerId: 'b',
        derivedCopayerId: 'b',
        walletId: 'w',
        name: 'B',
        xPubKey: 'xpub-b',
        requestPubKey: 'req-b'
      }
    ]);
    expect(ring).toEqual([
      { xPubKey: 'xpub-a', requestPubKey: 'req-a' },
      { xPubKey: 'xpub-b', requestPubKey: 'req-b' }
    ]);
  });
});
