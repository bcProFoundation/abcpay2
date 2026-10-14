import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { signMessage, verifyMessage } from './auth';

export const ENVELOPE_ALG_AES = 'secp256k1-ecdh-hkdf-aes256gcm';
export const ENVELOPE_INFO_PREFIX = 'abcpay-envelope-v1';

export interface EnvelopeEnc {
  alg: string;
  epk: string;
  salt: string;
  iv: string;
  ct: string;
}

export interface EnvelopeHeader {
  v: 1;
  id: string;
  type: string;
  from: string;
  to: string;
  createdAt: number;
  expiresAt: number;
  enc: EnvelopeEnc;
}

export interface SignedEnvelope extends EnvelopeHeader {
  sig: string;
}

export function uuidv7(nowMs = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const ts = BigInt(nowMs);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalHeaderObject(header: EnvelopeHeader, forAad: boolean) {
  return {
    v: 1,
    id: header.id,
    type: header.type,
    from: header.from,
    to: header.to,
    createdAt: header.createdAt,
    expiresAt: header.expiresAt,
    enc: {
      alg: header.enc.alg,
      epk: header.enc.epk,
      salt: header.enc.salt,
      iv: header.enc.iv,
      ct: forAad ? '' : header.enc.ct
    }
  };
}

export function canonicalEnvelopeHeader(header: EnvelopeHeader, forAad = false): string {
  return JSON.stringify(canonicalHeaderObject(header, forAad));
}

export function canonicalEnvelopeHeaderBytes(header: EnvelopeHeader, forAad = false): Uint8Array {
  return utf8ToBytes(canonicalEnvelopeHeader(header, forAad));
}

export function envelopeInfo(header: EnvelopeHeader): Uint8Array {
  return utf8ToBytes(
    [ENVELOPE_INFO_PREFIX, header.enc.alg, header.from, header.to, header.id, header.type].join('|')
  );
}

export function signEnvelopeHeader(header: EnvelopeHeader, requestPrivKeyHex: string): string {
  return signMessage(canonicalEnvelopeHeader(header), requestPrivKeyHex);
}

export function verifyEnvelopeSignature(
  envelope: SignedEnvelope,
  requestPubKeyHex: string
): boolean {
  const { sig, ...header } = envelope;
  return verifyMessage(canonicalEnvelopeHeader(header as EnvelopeHeader), sig, requestPubKeyHex);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

function randomScalar(): Uint8Array {
  for (;;) {
    const bytes = randomBytes(32);
    if (secp256k1.utils.isValidPrivateKey(bytes)) return bytes;
  }
}

async function deriveAeadKey(sharedSecret: Uint8Array, salt: Uint8Array, info: Uint8Array) {
  const raw = hkdf(sha256, sharedSecret, salt, info, 32);
  return globalThis.crypto.subtle.importKey(
    'raw',
    asBufferSource(raw),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealEnvelope(opts: {
  type: string;
  from: string;
  to: string;
  plaintext: Uint8Array | string;
  requestPrivKeyHex: string;
  createdAt?: number;
  expiresAt: number;
  id?: string;
  ephemeralPrivHex?: string;
  saltHex?: string;
  ivHex?: string;
}): Promise<SignedEnvelope> {
  const alg = ENVELOPE_ALG_AES;
  const ephemeralPriv = opts.ephemeralPrivHex
    ? hexToBytes(opts.ephemeralPrivHex)
    : randomScalar();
  const epk = bytesToHex(secp256k1.getPublicKey(ephemeralPriv, true));
  const shared = secp256k1.getSharedSecret(ephemeralPriv, hexToBytes(opts.to));
  const salt = opts.saltHex ? hexToBytes(opts.saltHex) : randomBytes(32);
  const iv = opts.ivHex ? hexToBytes(opts.ivHex) : randomBytes(12);
  const id = opts.id ?? uuidv7();
  const createdAt = opts.createdAt ?? Math.floor(Date.now() / 1000);

  const draft: EnvelopeHeader = {
    v: 1,
    id,
    type: opts.type,
    from: opts.from,
    to: opts.to,
    createdAt,
    expiresAt: opts.expiresAt,
    enc: {
      alg,
      epk,
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      ct: ''
    }
  };
  const key = await deriveAeadKey(shared, salt, envelopeInfo(draft));
  const plaintext = typeof opts.plaintext === 'string' ? utf8ToBytes(opts.plaintext) : opts.plaintext;
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: asBufferSource(iv),
        additionalData: asBufferSource(canonicalEnvelopeHeaderBytes(draft, true))
      },
      key,
      asBufferSource(plaintext)
    )
  );
  const header: EnvelopeHeader = { ...draft, enc: { ...draft.enc, ct: bytesToHex(ct) } };
  return { ...header, sig: signEnvelopeHeader(header, opts.requestPrivKeyHex) };
}

export async function openEnvelope(
  envelope: SignedEnvelope,
  recipientEnvelopePrivHex: string
): Promise<Uint8Array> {
  const { sig: _sig, ...rest } = envelope;
  const header = rest as EnvelopeHeader;
  const ephemeralPub = hexToBytes(header.enc.epk);
  const shared = secp256k1.getSharedSecret(hexToBytes(recipientEnvelopePrivHex), ephemeralPub);
  const salt = hexToBytes(header.enc.salt);
  const iv = hexToBytes(header.enc.iv);
  const key = await deriveAeadKey(shared, salt, envelopeInfo(header));
  const ct = hexToBytes(header.enc.ct);
  const plain = await globalThis.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asBufferSource(iv),
      additionalData: asBufferSource(canonicalEnvelopeHeaderBytes(header, true))
    },
    key,
    asBufferSource(ct)
  );
  return new Uint8Array(plain);
}

export function envelopeSizeClass(type: string): 'message' | 'psbt' {
  return type === 'psbt' || type === 'psbt_bundle' ? 'psbt' : 'message';
}

export const ENVELOPE_MAX_MESSAGE_BYTES = 16384;
export const ENVELOPE_MAX_PSBT_BYTES = 65536;

export function envelopeSizeLimit(type: string): number {
  return envelopeSizeClass(type) === 'psbt'
    ? ENVELOPE_MAX_PSBT_BYTES
    : ENVELOPE_MAX_MESSAGE_BYTES;
}

export function envelopeBytes(envelope: SignedEnvelope): Uint8Array {
  return utf8ToBytes(JSON.stringify(envelope));
}
