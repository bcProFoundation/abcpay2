import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  envelopeBytes,
  envelopeSizeLimit,
  verifyEnvelopeSignature,
  type SignedEnvelope
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { copayers, envelopes, identities } from '../db/schema';
import { notificationService } from './notification.service';

export const ENVELOPE_TTL_SECONDS = 604800;
export const ENVELOPES_PER_HOUR = 60;
export const MAX_PENDING_PER_IDENTITY = 200;
export const MAX_PENDING_TOTAL = 10000;

export class EnvelopeError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export interface ResolvedIdentity {
  identityKey: string;
  requestPubKey: string;
  encryptionPubKey?: string;
  walletId?: string;
  kind: string;
}

export class EnvelopeService {
  async resolveIdentityKey(xIdentity: string): Promise<ResolvedIdentity | undefined> {
    const [row] = await db
      .select()
      .from(identities)
      .where(eq(identities.identityKey, xIdentity))
      .limit(1);
    if (row) {
      return {
        identityKey: row.identityKey,
        requestPubKey: row.requestPubKey,
        encryptionPubKey: row.encryptionPubKey,
        kind: row.kind
      };
    }
    const [copayer] = await db
      .select()
      .from(copayers)
      .where(eq(copayers.copayerId, xIdentity))
      .limit(1);
    if (!copayer?.envelopeIdentity) return undefined;
    return {
      identityKey: copayer.envelopeIdentity,
      requestPubKey: copayer.requestPubKey,
      encryptionPubKey: copayer.encryptionPubKey ?? undefined,
      walletId: copayer.walletId,
      kind: 'copayer'
    };
  }

  async registerIdentity(opts: {
    callerIdentity: string;
    identityKey: string;
    requestPubKey: string;
    encryptionPubKey: string;
    label?: string;
  }): Promise<ResolvedIdentity> {
    const caller = await this.resolveIdentityKey(opts.callerIdentity);
    const [copayer] = await db
      .select()
      .from(copayers)
      .where(eq(copayers.copayerId, opts.callerIdentity))
      .limit(1);
    if (copayer && opts.requestPubKey !== copayer.requestPubKey) {
      throw new EnvelopeError(400, 'requestPubKey must match the caller identity');
    }
    if (!copayer && caller && opts.identityKey !== caller.identityKey) {
      throw new EnvelopeError(403, 'An identity may only update its own registration');
    }
    if (!copayer && !caller) {
      throw new EnvelopeError(401, 'Unknown caller identity');
    }
    await db
      .insert(identities)
      .values({
        identityKey: opts.identityKey,
        requestPubKey: opts.requestPubKey,
        encryptionPubKey: opts.encryptionPubKey,
        kind: 'copayer',
        label: opts.label
      })
      .onConflictDoUpdate({
        target: identities.identityKey,
        set: {
          requestPubKey: opts.requestPubKey,
          encryptionPubKey: opts.encryptionPubKey,
          label: opts.label,
          lastSeenAt: new Date()
        }
      });
    if (copayer) {
      await db
        .update(copayers)
        .set({
          envelopeIdentity: opts.identityKey,
          encryptionPubKey: opts.encryptionPubKey
        })
        .where(eq(copayers.copayerId, opts.callerIdentity));
    }
    return {
      identityKey: opts.identityKey,
      requestPubKey: opts.requestPubKey,
      encryptionPubKey: opts.encryptionPubKey,
      walletId: copayer?.walletId,
      kind: 'copayer'
    };
  }

  async getIdentity(identityKey: string): Promise<ResolvedIdentity | undefined> {
    return this.resolveIdentityKey(identityKey);
  }

  async storeEnvelope(envelope: SignedEnvelope, callerIdentityKey: string): Promise<string> {
    const bytes = envelopeBytes(envelope);
    const limit = envelopeSizeLimit(envelope.type);
    if (bytes.length > limit) {
      throw new EnvelopeError(413, `Envelope exceeds the ${limit}-byte limit for type ${envelope.type}`);
    }
    const from = await this.getIdentity(envelope.from);
    if (!from) {
      throw new EnvelopeError(401, 'Sender identity is not registered');
    }
    if (!verifyEnvelopeSignature(envelope, from.requestPubKey)) {
      throw new EnvelopeError(401, 'Invalid envelope signature');
    }
    if (envelope.from !== callerIdentityKey) {
      throw new EnvelopeError(403, 'Envelope sender does not match the authenticated caller');
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (envelope.expiresAt <= nowSeconds) {
      throw new EnvelopeError(400, 'Envelope is already expired');
    }
    if (envelope.expiresAt > nowSeconds + ENVELOPE_TTL_SECONDS) {
      throw new EnvelopeError(400, `Envelope TTL exceeds ${ENVELOPE_TTL_SECONDS} seconds`);
    }

    const [{ pending }] = await db
      .select({
        pending: sql<number>`count(*)`
      })
      .from(envelopes)
      .where(
        and(
          eq(envelopes.recipientIdentity, envelope.to),
          isNull(envelopes.ackedAt),
          gt(envelopes.expiresAt, new Date())
        )
      );
    if (Number(pending) >= MAX_PENDING_PER_IDENTITY) {
      throw new EnvelopeError(429, 'Recipient pending-envelope quota exceeded');
    }
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(envelopes)
      .where(and(isNull(envelopes.ackedAt), gt(envelopes.expiresAt, new Date())));
    if (Number(total) >= MAX_PENDING_TOTAL) {
      throw new EnvelopeError(503, 'Node pending-envelope quota exceeded');
    }
    const hourAgo = new Date(Date.now() - 3_600_000);
    const [{ recent }] = await db
      .select({ recent: sql<number>`count(*)` })
      .from(envelopes)
      .where(and(eq(envelopes.senderIdentity, envelope.from), gt(envelopes.createdAt, hourAgo)));
    if (Number(recent) >= ENVELOPES_PER_HOUR) {
      throw new EnvelopeError(429, 'Per-sender envelope rate limit exceeded');
    }

    try {
      await db.insert(envelopes).values({
        envelopeId: envelope.id,
        recipientIdentity: envelope.to,
        senderIdentity: envelope.from,
        typeTag: envelope.type,
        blob: new TextDecoder().decode(bytes),
        size: bytes.length,
        expiresAt: new Date(envelope.expiresAt * 1000)
      });
    } catch {
      throw new EnvelopeError(409, 'Duplicate envelope id');
    }
    notificationService.publishEnvelope({
      type: 'envelope.received',
      identity: envelope.to,
      envelopeId: envelope.id,
      envelopeType: envelope.type
    });
    return envelope.id;
  }

  async listPending(
    recipientIdentityKey: string,
    sinceMs?: number
  ): Promise<Array<{ id: string; type: string; blob: string; createdAt: number; expiresAt: number }>> {
    const conditions = [
      eq(envelopes.recipientIdentity, recipientIdentityKey),
      isNull(envelopes.ackedAt),
      gt(envelopes.expiresAt, new Date())
    ];
    if (sinceMs !== undefined) {
      conditions.push(gt(envelopes.createdAt, new Date(sinceMs)));
    }
    const rows = await db
      .select()
      .from(envelopes)
      .where(and(...conditions))
      .orderBy(envelopes.createdAt);
    return rows.map(row => ({
      id: row.envelopeId,
      type: row.typeTag,
      blob: row.blob,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime()
    }));
  }

  async ack(recipientIdentityKey: string, envelopeId: string): Promise<boolean> {
    const rows = await db
      .update(envelopes)
      .set({ ackedAt: new Date() })
      .where(
        and(
          eq(envelopes.envelopeId, envelopeId),
          eq(envelopes.recipientIdentity, recipientIdentityKey),
          isNull(envelopes.ackedAt)
        )
      )
      .returning({ id: envelopes.id });
    return rows.length > 0;
  }

  async sweepExpired(): Promise<number> {
    const rows = await db
      .delete(envelopes)
      .where(lt(envelopes.expiresAt, new Date()))
      .returning({ id: envelopes.id });
    return rows.length;
  }
}

export const envelopeService = new EnvelopeService();
