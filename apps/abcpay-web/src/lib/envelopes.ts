import {
  envelopeIdentityFromMnemonic,
  signIdentityRegistration,
  signRequestV5
} from '@bcpros/abcpay-wallet-core';
import { API_URL, type AuthContext } from './api';

export interface EnvelopeIdentityInfo {
  identityKey: string;
  requestPubKey: string;
  encryptionPubKey: string | null;
}

export async function v5Request<T>(
  auth: AuthContext,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const ts = Date.now();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-identity': auth.copayerId,
    'x-copayer-id': auth.copayerId,
    'x-wallet-id': auth.walletId,
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-signature': signRequestV5(auth.requestPrivKey, method, path, ts, nonce, bodyText)
  };
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyText
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T & { message?: string }) : ({} as T);
  if (!res.ok) {
    throw new Error((json as { message?: string }).message ?? `Request failed with status ${res.status}`);
  }
  return json;
}

export async function fetchEnvelopeIdentity(
  auth: AuthContext,
  identityKey: string
): Promise<EnvelopeIdentityInfo> {
  return v5Request<EnvelopeIdentityInfo>(auth, 'GET', `/v5/identities/${identityKey}`);
}

export async function announceEnvelopeIdentity(opts: {
  auth: AuthContext;
  mnemonic: string;
  requestPubKey: string;
  label?: string;
}): Promise<EnvelopeIdentityInfo> {
  const identity = envelopeIdentityFromMnemonic(opts.mnemonic);
  const encryptionPubKey = identity.pubKeyHex;
  return v5Request<EnvelopeIdentityInfo>(opts.auth, 'POST', '/v5/identities/', {
    identityKey: identity.pubKeyHex,
    requestPubKey: opts.requestPubKey,
    encryptionPubKey,
    proofSignature: signIdentityRegistration(
      identity.privKeyHex,
      identity.pubKeyHex,
      opts.requestPubKey,
      encryptionPubKey
    ),
    label: opts.label
  });
}

export interface PendingEnvelope {
  id: string;
  type: string;
  blob: string;
  createdAt: number;
  expiresAt: number;
}

export async function listPendingEnvelopes(
  auth: AuthContext,
  sinceMs?: number
): Promise<PendingEnvelope[]> {
  const path = sinceMs === undefined ? '/v5/envelopes/' : `/v5/envelopes/?since=${sinceMs}`;
  const response = await v5Request<{ envelopes: PendingEnvelope[] }>(auth, 'GET', path);
  return response.envelopes ?? [];
}

export async function ackEnvelope(auth: AuthContext, envelopeId: string): Promise<void> {
  await v5Request(auth, 'POST', `/v5/envelopes/${encodeURIComponent(envelopeId)}/ack`);
}
