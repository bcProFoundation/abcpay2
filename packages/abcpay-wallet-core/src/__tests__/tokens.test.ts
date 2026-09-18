import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../bytes';
import { createCredentials } from '../keys';
import { planTokenSend, slpSendScript, alpSendScript, encodeAlpAtoms, encodeSlpAtoms } from '../tokens';
import { signAndAssemble, unsignedTxFromProposal, type UnsignedInput, type UnsignedTx } from '../tx';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, 'fixtures/token-encoders.json'), 'utf8'));
const parity = JSON.parse(readFileSync(join(here, 'fixtures/legacy-parity.json'), 'utf8'));

describe('token send scripts (ecash-lib vectors)', () => {
  for (const vector of vectors.slpSend) {
    it(`SLP send matches ecash-lib: ${vector.atoms.join(',')}`, () => {
      const script = slpSendScript(vector.tokenId, vector.tokenType, vector.atoms.map((a: string) => BigInt(a)));
      expect(bytesToHex(script)).toBe(vector.scriptHex);
    });
  }

  for (const vector of vectors.alpSend) {
    it(`ALP send matches ecash-lib: ${vector.atoms.join(',')}`, () => {
      const script = alpSendScript(vector.tokenId, vector.tokenType, vector.atoms.map((a: string) => BigInt(a)));
      expect(bytesToHex(script)).toBe(vector.scriptHex);
    });
  }

  it('encodes atoms in the protocol byte order', () => {
    expect(bytesToHex(encodeSlpAtoms(1n))).toBe('0000000000000001');
    expect(bytesToHex(encodeAlpAtoms(1n))).toBe('010000000000');
    expect(() => encodeAlpAtoms(1n << 48n)).toThrow(/out of range/);
  });

  it('marks ALP OP_RETURNs as eMPP with OP_RESERVED', () => {
    const alp = bytesToHex(alpSendScript('aa'.repeat(32), 0, [1n]));
    const slp = bytesToHex(slpSendScript('aa'.repeat(32), 1, [1n]));
    expect(alp.startsWith('6a50')).toBe(true);
    expect(slp.startsWith('6a04')).toBe(true);
  });

  it('rejects malformed token ids', () => {
    expect(() => slpSendScript('abc', 1, [1n])).toThrow(/64 hex/);
  });
});

describe('planTokenSend', () => {
  const tokenId = 'ab'.repeat(32);
  const address = 'ecash:qpluxjhhlxfjwsymf9nmctvsdrwzwygadsh2pq0ang';
  const tokenUtxo = (atoms: string, satoshis = 546, vout = 0) => ({
    txid: '11'.repeat(32),
    vout,
    satoshis,
    address,
    path: `m/0/${vout}`,
    token: { tokenId, atoms, isMintBaton: false }
  });

  it('spends token UTXOs and returns change without extra XEC inputs', () => {
    const plan = planTokenSend({
      coin: 'xec',
      protocol: 'SLP',
      tokenId,
      tokenType: 1,
      utxos: [tokenUtxo('1000', 3000)],
      atoms: 400n
    });

    expect(plan.tokenInputs).toHaveLength(1);
    expect(plan.xecInputs).toHaveLength(0);
    expect(plan.changeAtoms).toBe(600n);
    expect(plan.tokenOutputCount).toBe(2);
    expect(plan.fee + plan.dustSats * 2 + plan.xecChange).toBe(3000);
  });

  it('uses only the token UTXOs needed to cover the amount', () => {
    const plan = planTokenSend({
      coin: 'xec',
      protocol: 'ALP',
      tokenId,
      tokenType: 0,
      utxos: [
        tokenUtxo('100', 546, 0),
        tokenUtxo('200', 546, 1),
        tokenUtxo('900', 546, 2),
        { txid: '22'.repeat(32), vout: 0, satoshis: 10_000, address, path: 'm/0/9' }
      ],
      atoms: 250n
    });

    expect(plan.tokenInputs.map(u => u.vout)).toEqual([0, 1]);
    expect(plan.changeAtoms).toBe(50n);
    expect(plan.tokenOutputCount).toBe(2);
    expect(plan.fee + 546 * 2 + plan.xecChange).toBe(546 + 546 + 10_000);
  });

  it('adds XEC inputs when token dust cannot cover outputs and fees', () => {
    const plan = planTokenSend({
      coin: 'xec',
      protocol: 'SLP',
      tokenId,
      tokenType: 1,
      utxos: [tokenUtxo('1000', 546), { txid: '22'.repeat(32), vout: 0, satoshis: 10_000, address, path: 'm/0/9' }],
      atoms: 1000n
    });

    expect(plan.tokenInputs).toHaveLength(1);
    expect(plan.xecInputs).toHaveLength(1);
    expect(plan.tokenOutputCount).toBe(1);
    expect(plan.xecChange).toBeGreaterThan(0);
    expect(plan.xecChange + 546 + plan.fee).toBe(546 + 10_000);
  });

  it('rejects sends above the token balance', () => {
    expect(() =>
      planTokenSend({
        coin: 'xec',
        protocol: 'SLP',
        tokenId,
        tokenType: 1,
        utxos: [tokenUtxo('10')],
        atoms: 11n
      })
    ).toThrow(/Insufficient token balance/);
  });

  it('rejects sends when there is no way to pay dust and fees', () => {
    expect(() =>
      planTokenSend({
        coin: 'xec',
        protocol: 'ALP',
        tokenId,
        tokenType: 0,
        utxos: [tokenUtxo('1000', 1)],
        atoms: 1000n
      })
    ).toThrow(/Insufficient funds/);
  });
});

describe('token outputs in the tx builder', () => {
  it('serializes token OP_RETURN outputs and preserves atoms metadata', () => {
    const wallet = parity.wallets.find((w: { id: string }) => w.id === 'xec-899-1of1');
    const creds = createCredentials({ coin: 'xec', mnemonic: wallet.copayers[0].mnemonic, coinType: 899 });
    const addr = wallet.addresses.find((a: { path: string }) => a.path === 'm/0/0');

    const opReturn = alpSendScript('cd'.repeat(32), 0, [1000n, 500n]);
    const inputs: UnsignedInput[] = [
      {
        txid: '33'.repeat(32),
        vout: 0,
        satoshis: 10_000,
        address: addr.address,
        path: addr.path,
        publicKeys: addr.publicKeys
      }
    ];

    const unsigned = unsignedTxFromProposal({
      coin: 'xec',
      inputs,
      outputs: [
        { toAddress: '', amount: 0, scriptHex: bytesToHex(opReturn) },
        { toAddress: addr.address, amount: 546, atoms: '1000', tokenId: 'cd'.repeat(32) },
        { toAddress: addr.address, amount: 546, atoms: '500', tokenId: 'cd'.repeat(32) }
      ],
      amount: 1092,
      fee: 500
    });

    expect(unsigned.outputs[0].scriptHex).toBe(bytesToHex(opReturn));
    expect(unsigned.outputs[1].atoms).toBe('1000');

    const { raw, txid } = signAndAssemble(unsigned, creds.xPrivKey);
    expect(raw).toContain(bytesToHex(opReturn));
    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });
});
