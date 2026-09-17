import { describe, expect, it } from 'vitest';
import {
  assembleTxHex,
  computeMaxSend,
  copayerIdFromXpub,
  createCredentials,
  decodeAddress,
  derivePublicKey,
  deriveWalletAddress,
  encodeP2pkhAddress,
  isSpendableUtxo,
  isValidMnemonic,
  relativePath,
  selectUtxos,
  signAndAssemble,
  signRequest,
  sighashForInput,
  sortPublicKeys,
  summarizeUtxos,
  validateAddress,
  verifyInputSignature,
  verifyRequest
} from '../index';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('credentials', () => {
  it('creates deterministic keys from a mnemonic', () => {
    const a = createCredentials({ coin: 'xec', mnemonic: MNEMONIC });
    const b = createCredentials({ coin: 'xec', mnemonic: MNEMONIC });
    expect(isValidMnemonic(MNEMONIC)).toBe(true);
    expect(a.xPubKey).toBe(b.xPubKey);
    expect(a.copayerId).toBe(copayerIdFromXpub('xec', a.xPubKey));
    expect(a.requestPubKey).toHaveLength(66);
  });

  it('uses purpose 48 for multisig accounts', () => {
    const single = createCredentials({ coin: 'xec', mnemonic: MNEMONIC });
    const multi = createCredentials({ coin: 'xec', mnemonic: MNEMONIC, isMultisig: true });
    const singleNative = createCredentials({ coin: 'xec', mnemonic: MNEMONIC, coinType: 899 });
    expect(single.accountPath.startsWith("m/44'/1899'")).toBe(true);
    expect(multi.accountPath.startsWith("m/48'/899'")).toBe(true);
    expect(singleNative.accountPath.startsWith("m/44'/899'")).toBe(true);
    expect(single.xPubKey).not.toBe(multi.xPubKey);
  });
});

describe('addresses', () => {
  it('encodes and decodes XEC P2PKH cashaddr', () => {
    const creds = createCredentials({ coin: 'xec', mnemonic: MNEMONIC });
    const derived = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [creds.xPubKey],
      m: 1,
      n: 1,
      path: relativePath(false, 0)
    });
    expect(derived.address.startsWith('ecash:q')).toBe(true);
    expect(validateAddress('xec', derived.address)).toBe(true);
    const decoded = decodeAddress('xec', derived.address);
    expect(decoded.type).toBe('p2pkh');
    expect(derived.type).toBe('P2PKH');
  });

  it('encodes DOGE P2PKH addresses starting with D', () => {
    const creds = createCredentials({ coin: 'doge', mnemonic: MNEMONIC });
    const pubkey = derivePublicKey(creds.xPubKey, relativePath(false, 0));
    const address = encodeP2pkhAddress('doge', pubkey);
    expect(address.startsWith('D')).toBe(true);
    expect(validateAddress('doge', address)).toBe(true);
    expect(decodeAddress('doge', address).type).toBe('p2pkh');
  });

  it('decodes legacy prefixless cashaddr addresses', () => {
    const prefixed = 'ecash:qr6latruw4nwu94s5u838setyxn2py884v5kquhq6g';
    const legacyPrefixless = 'qr6latruw4nwu94s5u838setyxn2py884vdm5hv6ul';
    expect(validateAddress('xec', legacyPrefixless)).toBe(true);
    expect(decodeAddress('xec', legacyPrefixless).hashHex).toBe(
      decodeAddress('xec', prefixed).hashHex
    );
  });

  it('builds the same P2SH address regardless of copayer xpub order', () => {
    const a = createCredentials({ coin: 'xec', mnemonic: MNEMONIC, isMultisig: true });
    const b = createCredentials({
      coin: 'xec',
      mnemonic:
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
      isMultisig: true
    });
    const path = relativePath(false, 0);
    const first = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [a.xPubKey, b.xPubKey],
      m: 2,
      n: 2,
      path
    });
    const second = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [b.xPubKey, a.xPubKey],
      m: 2,
      n: 2,
      path
    });
    expect(first.address).toBe(second.address);
    expect(first.address.startsWith('ecash:p')).toBe(true);
    expect(sortPublicKeys(first.publicKeys)).toEqual(sortPublicKeys(second.publicKeys));
  });
});

describe('SLP token safety', () => {
  const tokenUtxo = {
    txid: 'aa'.repeat(32),
    vout: 0,
    satoshis: 1_000_000,
    address: 'dummy',
    token: { tokenId: 'bb'.repeat(32), atoms: '1000', isMintBaton: false }
  };
  const plainUtxo = { txid: 'cc'.repeat(32), vout: 1, satoshis: 20_000, address: 'dummy' };

  it('never selects token-bearing UTXOs', () => {
    expect(isSpendableUtxo(tokenUtxo)).toBe(false);
    expect(isSpendableUtxo(plainUtxo)).toBe(true);
    const result = selectUtxos({ coin: 'xec', amount: 10_000, utxos: [tokenUtxo, plainUtxo] });
    expect(result.inputs).toEqual([plainUtxo]);
  });

  it('fails when only token UTXOs are available', () => {
    expect(() => selectUtxos({ coin: 'xec', amount: 1_000, utxos: [tokenUtxo] })).toThrow(
      'Insufficient funds'
    );
  });

  it('summarizes spendable and token balances separately', () => {
    const balances = summarizeUtxos([
      { ...plainUtxo, confirmations: 1, token: undefined },
      { ...tokenUtxo, confirmations: 1, token: { tokenId: 'bb'.repeat(32), tokenType: 1, atoms: '1000', isMintBaton: false } },
      {
        ...tokenUtxo,
        vout: 1,
        satoshis: 546,
        confirmations: 1,
        token: { tokenId: 'bb'.repeat(32), tokenType: 1, atoms: '500', isMintBaton: true }
      }
    ]);
    expect(balances.spendableSatoshis).toBe(20_000);
    expect(balances.tokenSatoshis).toBe(1_000_546);
    expect(balances.tokens).toEqual([
      {
        tokenId: 'bb'.repeat(32),
        tokenType: 1,
        atoms: '1500',
        isMintBaton: true
      }
    ]);
  });
});

describe('coinselect and tx', () => {
  it('selects utxos covering amount plus fee', () => {
    const result = selectUtxos({
      coin: 'xec',
      amount: 10_000,
      utxos: [
        { txid: 'aa'.repeat(32), vout: 0, satoshis: 8_000, address: 'dummy' },
        { txid: 'bb'.repeat(32), vout: 1, satoshis: 20_000, address: 'dummy' }
      ]
    });
    expect(result.totalInput).toBeGreaterThanOrEqual(10_000 + result.fee);
    expect(result.inputs.length).toBeGreaterThan(0);
  });

  it('donates dust change to the fee instead of rejecting', () => {
    const result = selectUtxos({
      coin: 'xec',
      amount: 546,
      utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 1_000, address: 'dummy' }]
    });
    expect(result.inputs).toHaveLength(1);
    expect(result.change).toBe(0);
    expect(result.fee).toBe(454);
  });

  it('accepts small balances when the effective fee still meets the relay minimum', () => {
    const result = selectUtxos({
      coin: 'xec',
      amount: 700,
      utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 1_000, address: 'dummy' }]
    });
    expect(result.change).toBe(0);
    expect(result.fee).toBe(300);
  });

  it('rejects when the remainder cannot cover the minimum relay fee', () => {
    expect(() =>
      selectUtxos({
        coin: 'xec',
        amount: 950,
        utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 1_000, address: 'dummy' }]
      })
    ).toThrow(/Insufficient funds: available 1000 sats, need 950/);
  });

  it('computes the max send amount for all spendable utxos', () => {
    const result = computeMaxSend({
      coin: 'xec',
      utxos: [
        { txid: 'aa'.repeat(32), vout: 0, satoshis: 1_000, address: 'dummy' },
        { txid: 'bb'.repeat(32), vout: 1, satoshis: 700, address: 'dummy' }
      ]
    });
    expect(result.totalInput).toBe(1_700);
    expect(result.fee).toBe(680);
    expect(result.amount).toBe(1_020);
  });

  it('accounts for multisig input size in max send', () => {
    const result = computeMaxSend({
      coin: 'xec',
      utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 5_000, address: 'dummy' }],
      m: 2,
      n: 2
    });
    expect(result.fee).toBe(616);
    expect(result.amount).toBe(4_384);
  });

  it('rejects max send when the remainder would be dust or only token utxos exist', () => {
    expect(() =>
      computeMaxSend({
        coin: 'xec',
        utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 900, address: 'dummy' }]
      })
    ).toThrow(/below the dust limit/);
    expect(() =>
      computeMaxSend({
        coin: 'xec',
        utxos: [
          {
            txid: 'aa'.repeat(32),
            vout: 0,
            satoshis: 100_000,
            address: 'dummy',
            token: { tokenId: 'bb'.repeat(32), atoms: '1', isMintBaton: false }
          }
        ]
      })
    ).toThrow(/No spendable balance/);
  });

  it('picks the most valuable input subset for max send', () => {
    const result = computeMaxSend({
      coin: 'xec',
      utxos: [
        { txid: 'aa'.repeat(32), vout: 0, satoshis: 1_000, address: 'dummy' },
        { txid: 'bb'.repeat(32), vout: 1, satoshis: 100, address: 'dummy' }
      ]
    });
    expect(result.inputs).toHaveLength(1);
    expect(result.amount).toBe(616);
  });

  it('never prices a transaction below the minimum relay fee', () => {
    const selection = selectUtxos({
      coin: 'xec',
      amount: 5_000,
      feePerKb: 1,
      utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 10_000, address: 'dummy' }]
    });
    expect(selection.fee).toBe(226);

    const max = computeMaxSend({
      coin: 'xec',
      feePerKb: 1,
      utxos: [{ txid: 'aa'.repeat(32), vout: 0, satoshis: 5_000, address: 'dummy' }]
    });
    expect(max.fee).toBe(192);
    expect(max.amount).toBe(4_808);
  });

  it('signs and serializes a P2PKH XEC transaction', () => {
    const creds = createCredentials({ coin: 'xec', mnemonic: MNEMONIC });
    const derived = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [creds.xPubKey],
      m: 1,
      n: 1,
      path: relativePath(false, 0)
    });
    const dest = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [creds.xPubKey],
      m: 1,
      n: 1,
      path: relativePath(false, 1)
    });

    const signed = signAndAssemble(
      {
        coin: 'xec',
        inputs: [
          {
            txid: '11'.repeat(32),
            vout: 0,
            satoshis: 100_000,
            address: derived.address,
            path: derived.path,
            publicKeys: derived.publicKeys,
            scriptPubKey: derived.scriptPubKey
          }
        ],
        outputs: [{ address: dest.address, satoshis: 90_000 }]
      },
      creds.xPrivKey
    );

    expect(signed.raw.length).toBeGreaterThan(200);
    expect(signed.txid).toHaveLength(64);
    expect(signed.signatures).toHaveLength(1);

    const tx = {
      coin: 'xec' as const,
      inputs: [
        {
          txid: '11'.repeat(32),
          vout: 0,
          satoshis: 100_000,
          address: derived.address,
          path: derived.path,
          publicKeys: derived.publicKeys,
          scriptPubKey: derived.scriptPubKey
        }
      ],
      outputs: [{ address: dest.address, satoshis: 90_000 }]
    };
    const assembled = assembleTxHex(tx, [{ [derived.publicKeys[0]]: signed.signatures[0] }]);
    expect(assembled).toBe(signed.raw);

    const sighash = sighashForInput(tx, 0);
    const pubkey = derivePublicKey(creds.xPubKey, derived.path);
    expect(verifyInputSignature(signed.signatures[0], sighash, pubkey, 'xec')).toBe(true);
    const wrongSighashType = signed.signatures[0].slice(0, -2) + '01';
    expect(verifyInputSignature(wrongSighashType, sighash, pubkey)).toBe(true);
    expect(verifyInputSignature(wrongSighashType, sighash, pubkey, 'xec')).toBe(false);
    const tampered = signed.signatures[0].slice(0, -4) + 'ffff';
    expect(verifyInputSignature(tampered, sighash, pubkey, 'xec')).toBe(false);
  });
});

describe('request auth', () => {
  it('signs and verifies BWS-compatible request signatures', () => {
    const creds = createCredentials({ coin: 'doge', mnemonic: MNEMONIC });
    const sig = signRequest(creds.requestPrivKey, 'GET', '/cws/api/v3/wallets/', '');
    expect(verifyRequest(creds.requestPubKey, sig, 'GET', '/cws/api/v3/wallets/', '')).toBe(true);
    expect(verifyRequest(creds.requestPubKey, sig, 'POST', '/cws/api/v3/wallets/', '')).toBe(false);
  });
});
