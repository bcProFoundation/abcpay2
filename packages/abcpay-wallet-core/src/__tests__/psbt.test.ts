import { describe, expect, it } from 'vitest';
import {
  addPartialSignature,
  assembleTxHex,
  bytesToHex,
  combinePsbts,
  compactSize,
  concatBytes,
  createCredentials,
  deriveWalletAddress,
  finalizePsbt,
  hexToBytes,
  isFullySigned,
  parsePsbt,
  psbtToBase64,
  readCompactSize,
  readVarSlice,
  serializePsbt,
  signAndAssemble,
  signaturesByPubkeyFromCopayer,
  signTxInputs,
  tokenSendScript,
  txToPsbt,
  txidFromRaw,
  unsignedTxFromProposal,
  u64LE,
  varSlice,
  type Psbt,
  type UnsignedTx
} from '../index';

function singleSigFixture() {
  const creds = createCredentials({ coin: 'xec' });
  const counterparty = createCredentials({ coin: 'xec' });
  const receive = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  });
  const change = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [creds.xPubKey],
    m: 1,
    n: 1,
    path: 'm/1/0'
  });
  const toAddress = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [counterparty.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  }).address;
  const tx = unsignedTxFromProposal({
    coin: 'xec',
    inputs: [
      {
        txid: 'aa'.repeat(32),
        vout: 0,
        satoshis: 10000,
        address: receive.address,
        path: 'm/0/0',
        publicKeys: receive.publicKeys,
        scriptPubKey: receive.scriptPubKey
      }
    ],
    outputs: [{ toAddress, amount: 5000 }],
    amount: 5000,
    fee: 452,
    changeAddress: { address: change.address, path: 'm/1/0' }
  });
  return { creds, tx, toAddress, change, receive };
}

function multisigFixture() {
  const a = createCredentials({ coin: 'xec' });
  const b = createCredentials({ coin: 'xec' });
  const xPubKeys = [a.xPubKey, b.xPubKey];
  const receive = deriveWalletAddress({ coin: 'xec', xPubKeys, m: 2, n: 2, path: 'm/0/0' });
  const change = deriveWalletAddress({ coin: 'xec', xPubKeys, m: 2, n: 2, path: 'm/1/0' });
  const counterparty = createCredentials({ coin: 'xec' });
  const toAddress = deriveWalletAddress({
    coin: 'xec',
    xPubKeys: [counterparty.xPubKey],
    m: 1,
    n: 1,
    path: 'm/0/0'
  }).address;
  const tx = unsignedTxFromProposal({
    coin: 'xec',
    inputs: [
      {
        txid: 'bb'.repeat(32),
        vout: 1,
        satoshis: 20000,
        address: receive.address,
        path: 'm/0/0',
        publicKeys: receive.publicKeys,
        redeemScript: receive.redeemScript,
        scriptPubKey: receive.scriptPubKey
      }
    ],
    outputs: [{ toAddress, amount: 8000 }],
    amount: 8000,
    fee: 684,
    changeAddress: { address: change.address, path: 'm/1/0' }
  });
  return { a, b, tx, toAddress, receive };
}

function withSignature(psbt: Psbt, tx: UnsignedTx, xPrivKey: string, xPubKey: string): Psbt {
  const sigs = signTxInputs(tx, xPrivKey);
  const byPubkey = signaturesByPubkeyFromCopayer(tx, xPubKey, sigs);
  return byPubkey.reduce((current, map, index) => {
    const [pubKeyHex, signatureHex] = Object.entries(map)[0]!;
    return addPartialSignature(current, index, pubKeyHex, signatureHex);
  }, psbt);
}

describe('var-slice codecs', () => {
  it('round-trips compactSize boundaries', () => {
    const values = [0, 1, 0xfc, 0xfd, 0xffff, 0x10000, 0xfffffffe, 0xffffffff];
    for (const value of values) {
      const encoded = compactSize(value);
      const read = readCompactSize(encoded, 0);
      expect(read.value).toBe(value);
      expect(read.size).toBe(encoded.length);
    }
  });

  it('round-trips var slices of every length class', () => {
    for (const length of [0, 1, 0xfc, 0xfd, 0xff, 0x100, 0x200]) {
      const data = Uint8Array.from({ length }, (_, i) => i & 0xff);
      const encoded = varSlice(data);
      const read = readVarSlice(encoded, 0);
      expect(Array.from(read.value)).toEqual(Array.from(data));
      expect(read.size).toBe(encoded.length);
    }
  });

  it('rejects truncated buffers', () => {
    expect(() => readCompactSize(new Uint8Array([]), 0)).toThrow(/past end/);
    expect(() => readVarSlice(Uint8Array.of(0x05, 0x01), 0)).toThrow(/past end/);
    expect(() => readVarSlice(concatBytes(Uint8Array.of(0xfd, 0xff), new Uint8Array(10)), 0)).toThrow(
      /past end/
    );
  });
});

describe('psbt round-trip', () => {
  it('serialize → parse → serialize is byte-identical', () => {
    const s = singleSigFixture();
    const psbt = txToPsbt({ tx: s.tx, proposalIdHex: '11'.repeat(16) });
    const raw = serializePsbt(psbt);
    const parsed = parsePsbt(raw, { coin: 'xec' });
    expect(bytesToHex(serializePsbt(parsed))).toBe(bytesToHex(raw));
  });

  it('round-trips through base64', () => {
    const s = singleSigFixture();
    const psbt = txToPsbt({ tx: s.tx });
    const base64 = psbtToBase64(psbt);
    const parsed = parsePsbt(base64, { coin: 'xec' });
    expect(bytesToHex(serializePsbt(parsed))).toBe(bytesToHex(serializePsbt(psbt)));
    expect(() => parsePsbt('not base64!!', { coin: 'xec' })).toThrow(/invalid base64/);
  });

  it('preserves proprietary token metadata', () => {
    const creds = createCredentials({ coin: 'xec' });
    const counterparty = createCredentials({ coin: 'xec' });
    const receive = deriveWalletAddress({ coin: 'xec', xPubKeys: [creds.xPubKey], m: 1, n: 1, path: 'm/0/0' });
    const change = deriveWalletAddress({ coin: 'xec', xPubKeys: [creds.xPubKey], m: 1, n: 1, path: 'm/1/0' });
    const toAddress = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [counterparty.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    }).address;
    const tokenId = 'ab'.repeat(32);
    const tx = unsignedTxFromProposal({
      coin: 'xec',
      inputs: [
        {
          txid: 'cc'.repeat(32),
          vout: 0,
          satoshis: 5000,
          address: receive.address,
          path: 'm/0/0',
          publicKeys: receive.publicKeys,
          scriptPubKey: receive.scriptPubKey
        }
      ],
      outputs: [
        { toAddress: '', amount: 0, scriptHex: bytesToHex(tokenSendScript('SLP', tokenId, 1, [60n])) },
        { toAddress, amount: 546, atoms: '60', tokenId }
      ],
      amount: 546,
      fee: 360
    });
    const psbt = txToPsbt({
      tx,
      proposalIdHex: '22'.repeat(16),
      outputMeta: [{}, { tokenId, protocol: 'SLP', atoms: '100000000' }]
    });
    const parsed = parsePsbt(serializePsbt(psbt), { coin: 'xec' });
    const outputPairs = parsed.outputs[1]!.unknownPairs.map(pair => ({
      key: new TextDecoder().decode(pair.key),
      value: new TextDecoder().decode(pair.value)
    }));
    expect(outputPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'SLP' }),
        expect.objectContaining({ value: '100000000' })
      ])
    );
    const tokenPair = parsed.outputs[1]!.unknownPairs.find(pair =>
      pair.key.includes(0x2e)
    );
    expect(tokenPair).toBeDefined();
    const proposalPair = parsed.globalUnknownPairs.find(pair => pair.key.length > 1);
    expect(proposalPair).toBeDefined();
    expect(bytesToHex(proposalPair!.value)).toBe('22'.repeat(16));
  });

  it('rejects non-decimal atom encodings', () => {
    const s = singleSigFixture();
    expect(() =>
      txToPsbt({ tx: s.tx, outputMeta: [{ atoms: '007' }, undefined] })
    ).toThrow(/unsigned decimal/);
    expect(() =>
      txToPsbt({ tx: s.tx, outputMeta: [{ atoms: '-1' }, undefined] })
    ).toThrow(/unsigned decimal/);
    expect(() =>
      txToPsbt({ tx: s.tx, outputMeta: [{ atoms: 'abc' }, undefined] })
    ).toThrow(/unsigned decimal/);
    const ok = txToPsbt({ tx: s.tx, outputMeta: [{ atoms: '18446744073709551615' }, undefined] });
    const parsed = parsePsbt(serializePsbt(ok), { coin: 'xec' });
    expect(
      parsed.outputs[0]!.unknownPairs.some(pair =>
        Array.from(pair.value).length === 20
      )
    ).toBe(true);
  });

  it('rejects malformed psbts', () => {
    const s = singleSigFixture();
    const raw = serializePsbt(txToPsbt({ tx: s.tx }));
    const badMagic = raw.slice();
    badMagic[0] = 0x00;
    expect(() => parsePsbt(badMagic, { coin: 'xec' })).toThrow(/magic/);
    expect(() => parsePsbt(raw.slice(0, raw.length - 3), { coin: 'xec' })).toThrow();
  });
});

describe('psbt assembly byte-identity', () => {
  it('single-sig finalize equals signAndAssemble', () => {
    const s = singleSigFixture();
    const psbt = withSignature(txToPsbt({ tx: s.tx }), s.tx, s.creds.xPrivKey, s.creds.xPubKey);
    expect(isFullySigned(psbt)).toBe(true);
    const finalized = finalizePsbt(psbt);
    const legacy = signAndAssemble(s.tx, s.creds.xPrivKey);
    expect(finalized.raw).toBe(legacy.raw);
    expect(finalized.txid).toBe(legacy.txid);
    expect(finalized.txid).toBe(txidFromRaw(legacy.raw));
  });

  it('multisig finalize equals mergeCopayerSignatures assembly', () => {
    const s = multisigFixture();
    let psbt = txToPsbt({ tx: s.tx });
    psbt = withSignature(psbt, s.tx, s.a.xPrivKey, s.a.xPubKey);
    expect(isFullySigned(psbt)).toBe(false);
    expect(() => finalizePsbt(psbt)).toThrow(/missing signatures/);
    psbt = withSignature(psbt, s.tx, s.b.xPrivKey, s.b.xPubKey);
    expect(isFullySigned(psbt)).toBe(true);
    const finalized = finalizePsbt(psbt);

    const sigsA = signTxInputs(s.tx, s.a.xPrivKey);
    const sigsB = signTxInputs(s.tx, s.b.xPrivKey);
    const legacy = assembleTxHex(s.tx, [
      {
        ...signaturesByPubkeyFromCopayer(s.tx, s.a.xPubKey, sigsA)[0]!,
        ...signaturesByPubkeyFromCopayer(s.tx, s.b.xPubKey, sigsB)[0]!
      }
    ]);
    expect(finalized.raw).toBe(legacy);
  });

  it('rejects a signature whose pubkey is not in the input script', () => {
    const s = singleSigFixture();
    const outsider = createCredentials({ coin: 'xec' });
    const outsiderKey = deriveWalletAddress({
      coin: 'xec',
      xPubKeys: [outsider.xPubKey],
      m: 1,
      n: 1,
      path: 'm/0/0'
    }).publicKeys[0]!;
    const psbt = txToPsbt({ tx: s.tx });
    expect(() => addPartialSignature(psbt, 0, outsiderKey, '30'.repeat(10))).toThrow(
      /does not match the input script/
    );
  });
});

describe('psbt combining', () => {
  it('combines partial signatures from both sides', () => {
    const s = multisigFixture();
    const fromA = withSignature(txToPsbt({ tx: s.tx }), s.tx, s.a.xPrivKey, s.a.xPubKey);
    const fromB = withSignature(txToPsbt({ tx: s.tx }), s.tx, s.b.xPrivKey, s.b.xPubKey);
    const combined = combinePsbts(fromA, fromB);
    expect(isFullySigned(combined)).toBe(true);
    expect(finalizePsbt(combined).raw).toBe(finalizePsbt(
      withSignature(fromA, s.tx, s.b.xPrivKey, s.b.xPubKey)
    ).raw);
  });

  it('rejects different unsigned transactions', () => {
    const s = singleSigFixture();
    const other = singleSigFixture();
    expect(() => combinePsbts(txToPsbt({ tx: s.tx }), txToPsbt({ tx: other.tx }))).toThrow(
      /unsigned transactions differ/
    );
  });

  it('rejects conflicting proprietary pairs', () => {
    const s = singleSigFixture();
    const left = txToPsbt({ tx: s.tx, proposalIdHex: '33'.repeat(16) });
    const right = txToPsbt({ tx: s.tx, proposalIdHex: '44'.repeat(16) });
    expect(() => combinePsbts(left, right)).toThrow(/conflicting global pair/);
  });

  it('rejects conflicting partial signatures for the same pubkey', () => {
    const s = singleSigFixture();
    const psbt = txToPsbt({ tx: s.tx });
    const sigs = signTxInputs(s.tx, s.creds.xPrivKey);
    const map = signaturesByPubkeyFromCopayer(s.tx, s.creds.xPubKey, sigs)[0]!;
    const [pubKeyHex, signatureHex] = Object.entries(map)[0]!;
    const left = addPartialSignature(psbt, 0, pubKeyHex, signatureHex);
    const right = addPartialSignature(psbt, 0, pubKeyHex, '30'.repeat(20));
    expect(() => combinePsbts(left, right)).toThrow(/conflicting partial signature/);
  });
});

describe('psbt wire format conformance', () => {
  it('parses a hand-built BIP174 v0 map layout', () => {
    const script = hexToBytes('76a914000000000000000000000000000000000000000088ac');
    const utxoValue = concatBytes(u64LE(5000), varSlice(script));
    const unsignedTx = concatBytes(
      Uint8Array.of(2, 0, 0, 0),
      compactSize(1),
      hexToBytes('11'.repeat(32)),
      Uint8Array.of(0, 0, 0, 0),
      compactSize(0),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff),
      compactSize(1),
      u64LE(4000),
      varSlice(script),
      Uint8Array.of(0, 0, 0, 0)
    );
    const raw = concatBytes(
      Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff),
      varSlice(Uint8Array.of(0x00)),
      varSlice(unsignedTx),
      compactSize(0),
      varSlice(Uint8Array.of(0x00)),
      varSlice(utxoValue),
      compactSize(0),
      compactSize(0)
    );
    const parsed = parsePsbt(raw, { coin: 'xec' });
    expect(parsed.unsignedTx.inputs).toHaveLength(1);
    expect(parsed.unsignedTx.inputs[0]!.satoshis).toBe(5000);
    expect(parsed.unsignedTx.inputs[0]!.txid).toBe('11'.repeat(32));
    expect(parsed.unsignedTx.outputs[0]!.satoshis).toBe(4000);
    expect(bytesToHex(serializePsbt(parsed))).toBe(bytesToHex(raw));
  });

  it('round-trips the full previous transaction in PSBT_IN_UTXO', () => {
    const s = singleSigFixture();
    const prevTx = concatBytes(
      Uint8Array.of(2, 0, 0, 0),
      compactSize(1),
      hexToBytes('22'.repeat(32)),
      Uint8Array.of(1, 0, 0, 0),
      compactSize(0),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff),
      compactSize(1),
      u64LE(10000),
      varSlice(hexToBytes(s.receive.scriptPubKey!)),
      Uint8Array.of(0, 0, 0, 0)
    );
    const prevTxHex = bytesToHex(prevTx);
    const prevTxid = txidFromRaw(prevTxHex);
    const tx = unsignedTxFromProposal({
      coin: 'xec',
      inputs: [
        {
          txid: prevTxid,
          vout: 0,
          satoshis: 10000,
          address: s.receive.address,
          path: 'm/0/0',
          publicKeys: s.receive.publicKeys,
          scriptPubKey: s.receive.scriptPubKey
        }
      ],
      outputs: [{ toAddress: s.toAddress, amount: 5000 }],
      amount: 5000,
      fee: 452,
      changeAddress: { address: s.change.address, path: 'm/1/0' }
    });
    const psbt = txToPsbt({ tx, prevTxsById: { [prevTxid]: prevTxHex } });
    const parsed = parsePsbt(serializePsbt(psbt), { coin: 'xec' });
    expect(parsed.unsignedTx.inputs[0]!.satoshis).toBe(10000);
    expect(parsed.unsignedTx.inputs[0]!.txid).toBe(prevTxid);
    expect(bytesToHex(serializePsbt(parsed))).toBe(bytesToHex(serializePsbt(psbt)));
  });
});
