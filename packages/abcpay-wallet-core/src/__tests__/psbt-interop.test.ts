import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  parsePsbt,
  psbtToBase64,
  serializePsbt
} from '../index';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ecash-lib-psbt.json', import.meta.url), 'utf8')
) as { hex: string; note: string };

describe('ecash-lib interop (fixture generated with ecash-lib@4.14.1)', () => {
  it('parses an ecash-lib-produced PSBT', () => {
    const psbt = parsePsbt(hexToBytes(fixture.hex), { coin: 'xec' });
    expect(psbt.unsignedTx.inputs).toHaveLength(1);
    expect(psbt.unsignedTx.outputs).toHaveLength(2);
    expect(psbt.unsignedTx.inputs[0]!.txid).toBe('aa'.repeat(32));
    expect(psbt.unsignedTx.inputs[0]!.satoshis).toBe(10000);
    expect(psbt.unsignedTx.outputs[0]!.satoshis).toBe(5000);
    expect(psbt.unsignedTx.outputs[1]!.satoshis).toBe(4548);
    const input = psbt.inputs[0]!;
    expect(input.partialSigs).toHaveLength(1);
    expect(input.partialSigs[0]!.pubKeyHex).toBe('02' + '11'.repeat(32));
    expect(input.partialSigs[0]!.signatureHex.endsWith('41')).toBe(true);
    expect(psbt.unsignedTx.inputs[0]!.publicKeys).toContain('02' + '11'.repeat(32));
  });

  it('preserves unknown pairs on round-trip, byte-identically', () => {
    const psbt = parsePsbt(hexToBytes(fixture.hex), { coin: 'xec' });
    expect(bytesToHex(serializePsbt(psbt))).toBe(fixture.hex);
  });

  it('keeps proprietary values readable', () => {
    const psbt = parsePsbt(hexToBytes(fixture.hex), { coin: 'xec' });
    const global = psbt.globalUnknownPairs[0]!;
    expect(new TextDecoder().decode(global.key)).toContain('cws.test');
    expect(new TextDecoder().decode(global.value)).toBe('global-value');
    const outPair = psbt.outputs[0]!.unknownPairs[0]!;
    expect(new TextDecoder().decode(outPair.key)).toContain('cws.output.atoms');
    expect(new TextDecoder().decode(outPair.value)).toBe('100000000');
  });

  it('re-encodes to base64 that parses back to the same bytes', () => {
    const psbt = parsePsbt(hexToBytes(fixture.hex), { coin: 'xec' });
    const base64 = psbtToBase64(psbt);
    const parsed = parsePsbt(base64, { coin: 'xec' });
    expect(bytesToHex(serializePsbt(parsed))).toBe(fixture.hex);
  });
});
