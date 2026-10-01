import type { WalletResponse } from '@bcpros/abcpay-models';
import {
  chainFromCoin,
  envelopeIdentityFromMnemonic,
  getUtxosForAddress,
  openEnvelope,
  parsePsbt,
  scriptPubKeyHexFromAddress,
  sealEnvelope,
  verifyEnvelopeSignature,
  type SignedEnvelope
} from '@bcpros/abcpay-wallet-core';
import type { StoredCredentials } from '../context/WalletContext';
import { api, type AuthContext } from './api';
import {
  ackEnvelope,
  announceEnvelopeIdentity,
  fetchEnvelopeIdentity,
  listPendingEnvelopes,
  v5Request
} from './envelopes';
import { respondToPayjoinRequest, startPayjoinSend } from './payjoin';
import { signAndMaybeBroadcast } from './tx';

export type PaymentRequestStatus = 'pending' | 'claimed' | 'paid' | 'rejected';

export interface PaymentRequestRecord {
  requestId: string;
  walletId: string;
  direction: 'outgoing' | 'incoming';
  counterpartyIdentity: string;
  coin: 'xec' | 'doge';
  network: 'livenet' | 'testnet';
  address: string;
  amountSat?: number;
  tokenId?: string;
  atoms?: string;
  memo?: string;
  createdAt: number;
  expiresAt: number;
  status: PaymentRequestStatus;
  txid?: string;
  envelopeId?: string;
}

const STORAGE_KEY = 'abcpay_v2_payment_requests';

function loadAll(): Record<string, PaymentRequestRecord[]> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      PaymentRequestRecord[]
    >;
  } catch {
    return {};
  }
}

function saveAll(all: Record<string, PaymentRequestRecord[]>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function listPaymentRequests(walletId: string): PaymentRequestRecord[] {
  return (loadAll()[walletId] ?? []).sort((a, b) => b.createdAt - a.createdAt);
}

export function upsertPaymentRequest(record: PaymentRequestRecord): void {
  const all = loadAll();
  const list = all[record.walletId] ?? [];
  const index = list.findIndex(
    entry => entry.requestId === record.requestId && entry.direction === record.direction
  );
  if (index >= 0) list[index] = record;
  else list.push(record);
  all[record.walletId] = list;
  saveAll(all);
}

export function removePaymentRequest(walletId: string, requestId: string, direction: 'outgoing' | 'incoming'): void {
  const all = loadAll();
  all[walletId] = (all[walletId] ?? []).filter(
    entry => !(entry.requestId === requestId && entry.direction === direction)
  );
  saveAll(all);
}

export interface PaymentRequestPayload {
  coin: 'xec' | 'doge';
  network: 'livenet' | 'testnet';
  address: string;
  amount: number | null;
  tokenId: string | null;
  atoms: string | null;
  memo: string | null;
  expiresAt: number;
  requestId: string;
}

export async function createPaymentRequest(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  wallet: WalletResponse;
  payerIdentityKey: string;
  address: string;
  amountSat?: number;
  tokenId?: string;
  atoms?: string;
  memo?: string;
  expiresInSeconds?: number;
}): Promise<PaymentRequestRecord> {
  const identity = envelopeIdentityFromMnemonic(opts.creds.mnemonic);
  await announceEnvelopeIdentity({
    auth: opts.auth,
    mnemonic: opts.creds.mnemonic,
    requestPubKey: opts.creds.requestPubKey
  });
  const payer = await fetchEnvelopeIdentity(opts.auth, opts.payerIdentityKey);
  if (!payer.encryptionPubKey) {
    throw new Error('Payer has no registered envelope encryption key');
  }
  const requestId = crypto.randomUUID();
  const expiresAt =
    Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 24 * 60 * 60);
  const payload: PaymentRequestPayload = {
    coin: opts.wallet.coin,
    network: opts.wallet.network as 'livenet' | 'testnet',
    address: opts.address,
    amount: opts.tokenId ? null : (opts.amountSat ?? null),
    tokenId: opts.tokenId ?? null,
    atoms: opts.atoms ?? null,
    memo: opts.memo ?? null,
    expiresAt,
    requestId
  };
  const envelope = await sealEnvelope({
    type: 'payment_request',
    from: identity.pubKeyHex,
    to: opts.payerIdentityKey,
    plaintext: JSON.stringify(payload),
    requestPrivKeyHex: opts.creds.requestPrivKey,
    expiresAt
  });
  await v5Request(opts.auth, 'POST', '/v5/envelopes/', envelope);
  const record: PaymentRequestRecord = {
    requestId,
    walletId: opts.auth.walletId,
    direction: 'outgoing',
    counterpartyIdentity: opts.payerIdentityKey,
    coin: opts.wallet.coin,
    network: opts.wallet.network as 'livenet' | 'testnet',
    address: opts.address,
    amountSat: opts.amountSat,
    tokenId: opts.tokenId,
    atoms: opts.atoms,
    memo: opts.memo,
    createdAt: Date.now(),
    expiresAt,
    status: 'pending',
    envelopeId: envelope.id
  };
  upsertPaymentRequest(record);
  return record;
}

export async function sendPaymentReceipt(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  record: PaymentRequestRecord;
  txid: string;
  proposalId?: string;
}): Promise<void> {
  const identity = envelopeIdentityFromMnemonic(opts.creds.mnemonic);
  const recipient = await fetchEnvelopeIdentity(opts.auth, opts.record.counterpartyIdentity);
  if (!recipient.encryptionPubKey) return;
  const envelope = await sealEnvelope({
    type: 'payment_receipt',
    from: identity.pubKeyHex,
    to: opts.record.counterpartyIdentity,
    plaintext: JSON.stringify({
      requestId: opts.record.requestId,
      txid: opts.txid,
      proposalId: opts.proposalId ?? null,
      paidAt: Math.floor(Date.now() / 1000),
      coin: opts.record.coin
    }),
    requestPrivKeyHex: opts.creds.requestPrivKey,
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });
  await v5Request(opts.auth, 'POST', '/v5/envelopes/', envelope);
}

export async function verifyPaymentOnChain(
  coin: 'xec' | 'doge',
  record: PaymentRequestRecord,
  txid: string
): Promise<boolean> {
  try {
    const chain = chainFromCoin(coin);
    const utxos = await getUtxosForAddress(chain, record.address);
    const match = utxos.find(utxo => utxo.txid === txid);
    if (!match) return false;
    if (record.tokenId) {
      if ((match.token?.tokenId ?? '').toLowerCase() !== record.tokenId.toLowerCase()) return false;
      if (record.atoms && match.token && BigInt(match.token.atoms) < BigInt(record.atoms)) {
        return false;
      }
      return true;
    }
    return match.satoshis >= (record.amountSat ?? 0);
  } catch {
    return false;
  }
}

export interface PayRequestOutcome {
  mode: 'payjoin' | 'normal';
  txid?: string;
  pendingSignatures?: number;
  error?: string;
}

export async function payPaymentRequest(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  wallet: WalletResponse;
  record: PaymentRequestRecord;
  payjoin?: boolean;
}): Promise<PayRequestOutcome> {
  const { auth, creds, wallet, record } = opts;
  if (record.direction !== 'incoming') throw new Error('Only incoming requests can be paid');
  const created = await api.createTxProposal(auth, {
    proposals: [
      {
        tokenId: record.tokenId,
        outputs: [
          {
            toAddress: record.address,
            amount: record.tokenId ? 546 : (record.amountSat ?? 0),
            atoms: record.atoms,
            message: record.memo
          }
        ]
      }
    ]
  });

  let mode: 'payjoin' | 'normal' = 'normal';
  if (opts.payjoin && !record.tokenId) {
    const outcome = await startPayjoinSend({
      auth,
      creds,
      wallet,
      proposal: created,
      recipientIdentityKey: record.counterpartyIdentity,
      mnemonic: creds.mnemonic
    });
    if (outcome.mode === 'payjoin') {
      mode = 'payjoin';
      const txid = outcome.txid;
      if (txid) {
        await sendPaymentReceipt({ auth, creds, record, txid, proposalId: outcome.proposal.id });
        upsertPaymentRequest({
          ...record,
          status: (await verifyPaymentOnChain(record.coin, record, txid)) ? 'paid' : 'claimed',
          txid
        });
      }
      return { mode, txid };
    }
  }

  const signed = await signAndMaybeBroadcast(created, creds, auth, wallet.copayers);
  if (signed.txid) {
    await sendPaymentReceipt({ auth, creds, record, txid: signed.txid, proposalId: signed.id });
    upsertPaymentRequest({
      ...record,
      status: (await verifyPaymentOnChain(record.coin, record, signed.txid)) ? 'paid' : 'claimed',
      txid: signed.txid
    });
    return { mode, txid: signed.txid };
  }
  upsertPaymentRequest({ ...record, status: 'claimed' });
  return {
    mode,
    pendingSignatures: Object.keys(signed.signatures ?? {}).length
  };
}

export interface SyncResult {
  incoming: number;
  receipts: number;
  reconciled: number;
  payjoinResponded: number;
}

export async function syncPaymentRequests(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  wallet: WalletResponse;
  payjoinResponder?: boolean;
}): Promise<SyncResult> {
  const { auth, creds, wallet } = opts;
  const result: SyncResult = { incoming: 0, receipts: 0, reconciled: 0, payjoinResponded: 0 };
  const identity = envelopeIdentityFromMnemonic(creds.mnemonic);
  const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
  const envelopes = await listPendingEnvelopes(auth);

  for (const item of envelopes) {
    try {
      const envelope = JSON.parse(item.blob) as SignedEnvelope;
      if (envelope.type === 'payment_request') {
        const sender = await fetchEnvelopeIdentity(auth, envelope.from);
        if (!verifyEnvelopeSignature(envelope, sender.requestPubKey)) continue;
        const payload = decode(await openEnvelope(envelope, identity.privKeyHex)) as PaymentRequestPayload;
        const known = listPaymentRequests(auth.walletId).some(
          entry => entry.requestId === payload.requestId && entry.direction === 'incoming'
        );
        if (!known) {
          upsertPaymentRequest({
            requestId: payload.requestId,
            walletId: auth.walletId,
            direction: 'incoming',
            counterpartyIdentity: envelope.from,
            coin: payload.coin,
            network: payload.network,
            address: payload.address,
            amountSat: payload.amount ?? undefined,
            tokenId: payload.tokenId ?? undefined,
            atoms: payload.atoms ?? undefined,
            memo: payload.memo ?? undefined,
            createdAt: Date.now(),
            expiresAt: payload.expiresAt,
            status: 'pending'
          });
          result.incoming += 1;
        }
        await ackEnvelope(auth, item.id);
      } else if (envelope.type === 'payment_receipt') {
        const sender = await fetchEnvelopeIdentity(auth, envelope.from);
        if (!verifyEnvelopeSignature(envelope, sender.requestPubKey)) continue;
        const payload = decode(await openEnvelope(envelope, identity.privKeyHex)) as {
          requestId: string;
          txid: string;
          proposalId?: string | null;
        };
        const record = listPaymentRequests(auth.walletId).find(
          entry => entry.requestId === payload.requestId && entry.direction === 'outgoing'
        );
        await ackEnvelope(auth, item.id);
        if (!record) continue;
        const paid = await verifyPaymentOnChain(record.coin, record, payload.txid);
        upsertPaymentRequest({ ...record, txid: payload.txid, status: paid ? 'paid' : 'claimed' });
        result.receipts += 1;
      } else if (envelope.type === 'psbt' && opts.payjoinResponder) {
        const sender = await fetchEnvelopeIdentity(auth, envelope.from);
        if (!verifyEnvelopeSignature(envelope, sender.requestPubKey)) continue;
        let payload: { proposalId?: string; expect?: string; psbt?: string };
        try {
          payload = decode(await openEnvelope(envelope, identity.privKeyHex));
        } catch {
          continue;
        }
        if (payload.expect !== 'contribute' || !payload.psbt) continue;
        const original = parsePsbt(payload.psbt, { coin: wallet.coin });
        const outgoing = listPaymentRequests(auth.walletId).filter(
          entry => entry.direction === 'outgoing' && entry.status === 'pending' && !entry.tokenId
        );
        const match = outgoing.find(entry => {
          const wantedScript = scriptPubKeyHexFromAddress(wallet.coin, entry.address).toLowerCase();
          return original.unsignedTx.outputs.some(output => {
            try {
              const script = output.scriptHex
                ? output.scriptHex.toLowerCase()
                : scriptPubKeyHexFromAddress(wallet.coin, output.address).toLowerCase();
              return script === wantedScript && output.satoshis === entry.amountSat;
            } catch {
              return false;
            }
          });
        });
        if (!match) continue;
        const change = await api.createAddress(auth, true);
        const responder = await respondToPayjoinRequest({
          auth,
          creds,
          wallet,
          mnemonic: creds.mnemonic,
          envelope,
          senderRequestPubKey: sender.requestPubKey,
          paymentScriptPubKeyHex: scriptPubKeyHexFromAddress(wallet.coin, match.address),
          changeAddress: { address: change.address, path: change.path }
        });
        if (responder.replied) result.payjoinResponded += 1;
      }
    } catch {
      // leave the envelope for the next sync attempt
    }
  }

  for (const record of listPaymentRequests(auth.walletId)) {
    if (record.direction === 'outgoing' && record.status === 'claimed' && record.txid) {
      if (await verifyPaymentOnChain(record.coin, record, record.txid)) {
        upsertPaymentRequest({ ...record, status: 'paid' });
        result.reconciled += 1;
      }
    }
  }
  return result;
}
