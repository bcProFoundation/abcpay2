import { describe, expect, it } from 'vitest';
import { addressMatchesDerivation, scriptKey } from '../address-validation';

const XPUB_899_1OF1 =
  'xpub6CAze4BpcKMCeXFLj2Ww1vWVBUojskTKjB4LixbgjZgQogGMpSKCzCYC6a7MnX9Pi2E7WREFVegFcSaKqSeSnk5sdnHETA8sfK3qUQPP7PY';
const ADDR_M00 = 'qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang';
const ADDR_M01 = 'ecash:qrtmy72hp7ks80xalvlt8jxczd6l3wr5zga5vct0s4';

function matches(path: string, address: string) {
  return addressMatchesDerivation({
    coin: 'xec',
    network: 'livenet',
    xPubKeys: [XPUB_899_1OF1],
    m: 1,
    n: 1,
    path,
    address
  });
}

describe('addressMatchesDerivation', () => {
  it('accepts derived addresses in prefixed and prefixless casing', () => {
    expect(matches('m/0/0', ADDR_M00)).toBe(true);
    expect(matches('m/0/0', `ecash:${ADDR_M00}`)).toBe(true);
    expect(matches('m/0/1', ADDR_M01)).toBe(true);
  });

  it('accepts legacy full derivation paths', () => {
    expect(matches("m/44'/899'/0'/0/0", ADDR_M00)).toBe(true);
  });

  it('rejects addresses that do not belong to the wallet', () => {
    expect(matches('m/0/0', ADDR_M01)).toBe(false);
    expect(
      matches('m/0/0', 'ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg')
    ).toBe(false);
  });

  it('rejects unparseable paths and addresses', () => {
    expect(matches('nonsense', ADDR_M00)).toBe(false);
    expect(matches('m/0/0', 'not-an-address')).toBe(false);
  });
});

describe('scriptKey', () => {
  it('normalizes encodings to the same script key', () => {
    expect(scriptKey('xec', ADDR_M00)).toBe(scriptKey('xec', `ecash:${ADDR_M00}`));
    expect(scriptKey('xec', ADDR_M00)).not.toBe(scriptKey('xec', ADDR_M01));
  });
});
