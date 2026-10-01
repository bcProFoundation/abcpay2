import { describe, expect, it } from 'vitest';
import {
  canonicalEnvelopeHeader,
  createCredentials,
  envelopeBytes,
  envelopeIdentityFromMnemonic,
  envelopeSizeLimit,
  ENVELOPE_ALG_AES,
  ENVELOPE_IDENTITY_PATH,
  generateWalletMnemonic,
  openEnvelope,
  sealEnvelope,
  signEnvelopeHeader,
  uuidv7,
  verifyEnvelopeSignature,
  type EnvelopeHeader,
  type SignedEnvelope
} from '../index';

function identities() {
  const senderMnemonic = generateWalletMnemonic();
  const recipientMnemonic = generateWalletMnemonic();
  const senderCreds = createCredentials({ coin: 'xec', mnemonic: senderMnemonic });
  const recipientCreds = createCredentials({ coin: 'xec', mnemonic: recipientMnemonic });
  const senderIdentity = envelopeIdentityFromMnemonic(senderMnemonic);
  const recipientIdentity = envelopeIdentityFromMnemonic(recipientMnemonic);
  return { senderMnemonic, recipientMnemonic, senderCreds, recipientCreds, senderIdentity, recipientIdentity };
}

async function sealedFixture(overrides: Partial<Parameters<typeof sealEnvelope>[0]> = {}) {
  const s = identities();
  const envelope = await sealEnvelope({
    type: 'payment_request',
    from: s.senderIdentity.pubKeyHex,
    to: s.recipientIdentity.pubKeyHex,
    plaintext: '{"amount":1250,"memo":"Lunch"}',
    requestPrivKeyHex: s.senderCreds.requestPrivKey,
    createdAt: 1758100000,
    expiresAt: 1758704800,
    ...overrides
  });
  return { s, envelope };
}

describe('envelope identity derivation', () => {
  it('is deterministic per mnemonic and distinct per copayer', () => {
    const a = identities();
    expect(envelopeIdentityFromMnemonic(a.senderMnemonic).privKeyHex).toBe(a.senderIdentity.privKeyHex);
    expect(a.senderIdentity.privKeyHex).not.toBe(a.recipientIdentity.privKeyHex);
    expect(a.senderIdentity.pubKeyHex).toHaveLength(66);
  });

  it('uses a branch that does not collide with the wallet key', () => {
    const s = identities();
    expect(ENVELOPE_IDENTITY_PATH).toBe("m/2'/1");
    expect(s.senderIdentity.privKeyHex).not.toBe(s.senderCreds.walletPrivKey);
    expect(s.senderIdentity.privKeyHex).not.toBe(s.senderCreds.requestPrivKey);
  });

  it('rejects invalid mnemonics', () => {
    expect(() => envelopeIdentityFromMnemonic('not a mnemonic')).toThrow(/Invalid mnemonic/);
  });
});

describe('envelope seal/open', () => {
  it('round-trips plaintext to the recipient', async () => {
    const { s, envelope } = await sealedFixture();
    const plain = await openEnvelope(envelope, s.recipientIdentity.privKeyHex);
    expect(new TextDecoder().decode(plain)).toBe('{"amount":1250,"memo":"Lunch"}');
  });

  it('round-trips binary payloads', async () => {
    const s = identities();
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    const envelope = await sealEnvelope({
      type: 'psbt',
      from: s.senderIdentity.pubKeyHex,
      to: s.recipientIdentity.pubKeyHex,
      plaintext: payload,
      requestPrivKeyHex: s.senderCreds.requestPrivKey,
      expiresAt: 1758704800
    });
    const plain = await openEnvelope(envelope, s.recipientIdentity.privKeyHex);
    expect(Array.from(plain)).toEqual(Array.from(payload));
  });

  it('never leaks to the wrong recipient', async () => {
    const { envelope } = await sealedFixture();
    const stranger = envelopeIdentityFromMnemonic(generateWalletMnemonic());
    await expect(openEnvelope(envelope, stranger.privKeyHex)).rejects.toThrow();
  });

  it('never reuses the ephemeral key or salt', async () => {
    const s = identities();
    const first = await sealedFixture();
    const second = await sealedFixture();
    expect(first.envelope.enc.epk).not.toBe(second.envelope.enc.epk);
    expect(first.envelope.enc.salt).not.toBe(second.envelope.enc.salt);
    const third = await sealEnvelope({
      type: 'payment_request',
      from: s.senderIdentity.pubKeyHex,
      to: s.recipientIdentity.pubKeyHex,
      plaintext: 'x',
      requestPrivKeyHex: s.senderCreds.requestPrivKey,
      expiresAt: 1758704800
    });
    expect(third.enc.epk).not.toBe(first.envelope.enc.epk);
    expect(third.enc.salt).not.toBe(first.envelope.enc.salt);
    expect(third.enc.iv).not.toBe(first.envelope.enc.iv);
  });
});

describe('envelope signature and AAD binding', () => {
  it('verifies against the sender request key', async () => {
    const { s, envelope } = await sealedFixture();
    expect(verifyEnvelopeSignature(envelope, s.senderCreds.requestPubKey)).toBe(true);
    expect(verifyEnvelopeSignature(envelope, s.recipientCreds.requestPubKey)).toBe(false);
  });

  it('rejects tampered header fields at the signature layer', async () => {
    const { s, envelope } = await sealedFixture();
    const tampered: Record<string, SignedEnvelope> = {
      to: { ...envelope, to: s.senderIdentity.pubKeyHex },
      id: { ...envelope, id: uuidv7() },
      type: { ...envelope, type: 'payment_receipt' },
      expiresAt: { ...envelope, expiresAt: 1758999999 },
      createdAt: { ...envelope, createdAt: 1758000000 },
      epk: { ...envelope, enc: { ...envelope.enc, epk: s.senderIdentity.pubKeyHex } },
      salt: { ...envelope, enc: { ...envelope.enc, salt: 'ab'.repeat(32) } },
      iv: { ...envelope, enc: { ...envelope.enc, iv: 'cd'.repeat(12) } },
      ct: { ...envelope, enc: { ...envelope.enc, ct: envelope.enc.ct.replace(/^../, 'ff') } }
    };
    for (const [field, candidate] of Object.entries(tampered)) {
      expect(verifyEnvelopeSignature(candidate, s.senderCreds.requestPubKey), field).toBe(false);
    }
  });

  it('fails decryption when routing fields are swapped after sealing (AAD)', async () => {
    const { s, envelope } = await sealedFixture();
    const otherRecipient = envelopeIdentityFromMnemonic(generateWalletMnemonic());
    const swapped: SignedEnvelope = { ...envelope, to: otherRecipient.pubKeyHex };
    await expect(openEnvelope(swapped, s.recipientIdentity.privKeyHex)).rejects.toThrow();
    const expired: SignedEnvelope = { ...envelope, expiresAt: envelope.expiresAt + 1 };
    await expect(openEnvelope(expired, s.recipientIdentity.privKeyHex)).rejects.toThrow();
    const rehashed: SignedEnvelope = {
      ...envelope,
      enc: { ...envelope.enc, epk: s.senderIdentity.pubKeyHex }
    };
    await expect(openEnvelope(rehashed, s.recipientIdentity.privKeyHex)).rejects.toThrow();
  });

  it('serializes the canonical header byte-exactly', () => {
    const header: EnvelopeHeader = {
      v: 1,
      id: '01890a5d-ac96-7000-8000-000000000000',
      type: 'payment_request',
      from: '02aa',
      to: '03bb',
      createdAt: 1758100000,
      expiresAt: 1758704800,
      enc: {
        alg: ENVELOPE_ALG_AES,
        epk: '02cc',
        salt: 'aabb',
        iv: '00112233445566778899aabb',
        ct: 'deadbeef'
      }
    };
    expect(canonicalEnvelopeHeader(header)).toBe(
      '{"v":1,"id":"01890a5d-ac96-7000-8000-000000000000","type":"payment_request","from":"02aa","to":"03bb","createdAt":1758100000,"expiresAt":1758704800,"enc":{"alg":"secp256k1-ecdh-hkdf-aes256gcm","epk":"02cc","salt":"aabb","iv":"00112233445566778899aabb","ct":"deadbeef"}}'
    );
    expect(canonicalEnvelopeHeader(header, true)).toBe(
      '{"v":1,"id":"01890a5d-ac96-7000-8000-000000000000","type":"payment_request","from":"02aa","to":"03bb","createdAt":1758100000,"expiresAt":1758704800,"enc":{"alg":"secp256k1-ecdh-hkdf-aes256gcm","epk":"02cc","salt":"aabb","iv":"00112233445566778899aabb","ct":""}}'
    );
    const s = identities();
    const sig = signEnvelopeHeader(header, s.senderCreds.requestPrivKey);
    expect(sig).toMatch(/^[0-9a-f]+$/);
    expect(verifyEnvelopeSignature({ ...header, sig }, s.senderCreds.requestPubKey)).toBe(true);
  });
});

describe('envelope wire helpers', () => {
  it('generates time-ordered uuidv7 ids', () => {
    const early = uuidv7(1758100000123);
    const late = uuidv7(1758100001123);
    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(early < late).toBe(true);
    expect(uuidv7(1758100000123).slice(0, 8)).toBe(uuidv7(1758100000123).slice(0, 8));
  });

  it('applies the documented size classes', () => {
    expect(envelopeSizeLimit('payment_request')).toBe(16384);
    expect(envelopeSizeLimit('payment_receipt')).toBe(16384);
    expect(envelopeSizeLimit('wallet_invite')).toBe(16384);
    expect(envelopeSizeLimit('memo')).toBe(16384);
    expect(envelopeSizeLimit('psbt')).toBe(65536);
    expect(envelopeSizeLimit('psbt_bundle')).toBe(65536);
  });

  it('counts serialized envelope bytes for quota enforcement', async () => {
    const { envelope } = await sealedFixture();
    expect(envelopeBytes(envelope).length).toBeGreaterThan(200);
  });
});
