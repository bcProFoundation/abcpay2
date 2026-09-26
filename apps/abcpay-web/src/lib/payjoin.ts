import type { TxProposal, WalletResponse } from '@bcpros/abcpay-models';
import {
  addPartialSignature,
  applyPayjoinContribution,
  buildPayjoinContribution,
  chainFromCoin,
  derivePrivateKey,
  envelopeIdentityFromMnemonic,
  finalizePsbt,
  getUtxosForAddress,
  hexToBytes,
  openEnvelope,
  parsePsbt,
  psbtToBase64,
  scriptPubKeyHexFromAddress,
  scriptPubKeyToAddress,
  sealEnvelope,
  signHash,
  signPayjoinContribution,
  signRequestV5,
  sighashForInput,
  txToPsbt,
  verifyEnvelopeSignature,
  verifyPayjoinContribution,
  type PayjoinInputToken,
  type PayjoinReceiverUtxo,
  type SignedEnvelope
} from '@bcpros/abcpay-wallet-core';
import type { StoredCredentials } from '../context/WalletContext';
import { API_URL, api, type AuthContext } from './api';
import { verifyProposalBeforeSign } from './proposal-verify';

const POLL_INTERVAL_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
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
  const json = text ? (JSON.parse(text) as T & { message?: string; code?: string }) : ({} as T);
  if (!res.ok) {
    throw new Error(
      (json as { message?: string }).message ?? `Request failed with status ${res.status}`
    );
  }
  return json;
}

export interface EnvelopeIdentityInfo {
  identityKey: string;
  requestPubKey: string;
  encryptionPubKey: string | null;
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
  return v5Request<EnvelopeIdentityInfo>(opts.auth, 'POST', '/v5/identities/', {
    identityKey: identity.pubKeyHex,
    requestPubKey: opts.requestPubKey,
    encryptionPubKey: identity.pubKeyHex,
    label: opts.label
  });
}

async function senderTokenStatus(
  coin: 'xec' | 'doge',
  txid: string,
  vout: number,
  scriptPubKeyHex: string,
  network: 'livenet' | 'testnet'
): Promise<PayjoinInputToken> {
  const chain = chainFromCoin(coin);
  const address = scriptPubKeyToAddress(coin, hexToBytes(scriptPubKeyHex), network);
  const utxos = await getUtxosForAddress(chain, address);
  const found = utxos.find(utxo => utxo.txid === txid && utxo.vout === vout);
  if (!found) {
    throw new Error('Contribution input is not a chain-verified UTXO at its script');
  }
  return found.token
    ? {
        tokenId: found.token.tokenId,
        atoms: found.token.atoms,
        isMintBaton: found.token.isMintBaton
      }
    : { tokenId: null, atoms: '0' };
}

function outpointKey(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

export interface PayjoinSendOutcome {
  mode: 'payjoin' | 'fallback';
  proposal: TxProposal;
  txid?: string;
  reason?: string;
}

export async function startPayjoinSend(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  wallet: WalletResponse;
  proposal: TxProposal;
  base64Psbt?: string;
  recipientIdentityKey: string;
  mnemonic: string;
  timeoutMs?: number;
  feePerKb?: number;
}): Promise<PayjoinSendOutcome> {
  const { auth, creds, wallet, proposal } = opts;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  try {
    const verified = await verifyProposalBeforeSign({ proposal, auth, wallet });
    await announceEnvelopeIdentity({
      auth,
      mnemonic: opts.mnemonic,
      requestPubKey: creds.requestPubKey
    });
    const senderIdentity = envelopeIdentityFromMnemonic(opts.mnemonic);
    const recipient = await fetchEnvelopeIdentity(auth, opts.recipientIdentityKey);
    if (!recipient.encryptionPubKey) {
      throw new Error('Recipient has no registered envelope encryption key');
    }
    const original =
      opts.base64Psbt !== undefined
        ? parsePsbt(opts.base64Psbt, { coin: proposal.coin })
        : txToPsbt({
            tx: verified.verifiedTx,
            proposalIdHex: proposal.id,
            outputMeta: proposal.outputs.map(output =>
              output.atoms !== undefined
                ? { tokenId: output.tokenId, protocol: proposal.protocol, atoms: output.atoms }
                : undefined
            )
          });
    const paymentOutput = verified.verifiedTx.outputs[0];
    if (!paymentOutput) throw new Error('Proposal has no payment output');

    const request = await sealEnvelope({
      type: 'psbt',
      from: senderIdentity.pubKeyHex,
      to: opts.recipientIdentityKey,
      plaintext: JSON.stringify({
        proposalId: proposal.id,
        psbt: psbtToBase64(original),
        round: 1,
        expect: 'contribute'
      }),
      requestPrivKeyHex: creds.requestPrivKey,
      expiresAt: Math.floor(Date.now() / 1000) + 3600
    });
    await v5Request(auth, 'POST', '/v5/envelopes/', request);

    while (Date.now() - startedAt < timeoutMs) {
      const { envelopes } = await v5Request<{
        envelopes: Array<{ id: string; type: string; blob: string }>;
      }>(auth, 'GET', `/v5/envelopes/?since=${startedAt}`);
      for (const item of envelopes) {
        if (item.type !== 'psbt') continue;
        const reply = JSON.parse(item.blob) as SignedEnvelope;
        if (reply.from !== opts.recipientIdentityKey) continue;
        if (!verifyEnvelopeSignature(reply, recipient.requestPubKey)) continue;
        const plaintext = JSON.parse(
          new TextDecoder().decode(await openEnvelope(reply, senderIdentity.privKeyHex))
        ) as { proposalId?: string; expect?: string; psbt?: string };
        if (plaintext.proposalId !== proposal.id || plaintext.expect !== 'finalize' || !plaintext.psbt) {
          continue;
        }
        await v5Request(auth, 'POST', `/v5/envelopes/${item.id}/ack`);

        const contribution = parsePsbt(plaintext.psbt, { coin: proposal.coin });
        const inputTokens = new Map<string, PayjoinInputToken>();
        const originalOutpoints = new Set(
          verified.verifiedTx.inputs.map(input => outpointKey(input.txid, input.vout))
        );
        for (const [index, input] of contribution.unsignedTx.inputs.entries()) {
          if (originalOutpoints.has(outpointKey(input.txid, input.vout))) continue;
          const utxo = contribution.inputs[index]?.utxo;
          const scriptHex =
            utxo && 'scriptPubKeyHex' in utxo ? utxo.scriptPubKeyHex : input.scriptPubKey;
          if (!scriptHex) throw new Error('Contribution input has no script to verify');
          inputTokens.set(
            outpointKey(input.txid, input.vout),
            await senderTokenStatus(
              proposal.coin,
              input.txid,
              input.vout,
              scriptHex,
              proposal.network as 'livenet' | 'testnet'
            )
          );
        }
        const verifiedContribution = verifyPayjoinContribution({
          coin: proposal.coin,
          network: proposal.network as 'livenet' | 'testnet',
          original,
          contribution,
          intent: {
            toAddress: paymentOutput.address,
            amountSat: paymentOutput.satoshis,
            feePerKb: opts.feePerKb
          },
          senderPubKeyHexes: verified.verifiedTx.inputs.flatMap(input => input.publicKeys),
          chain: { inputTokens }
        });
        if (!verifiedContribution.ok) {
          throw new Error(`PayJoin rejected (${verifiedContribution.rule}): ${verifiedContribution.detail}`);
        }

        const contributionTx = contribution.unsignedTx;
        const restoredInputs = contributionTx.inputs.map(input => {
          const originalInput = verified.verifiedTx.inputs.find(
            candidate => outpointKey(candidate.txid, candidate.vout) === outpointKey(input.txid, input.vout)
          );
          return originalInput
            ? {
                ...input,
                address: originalInput.address,
                path: originalInput.path,
                publicKeys: originalInput.publicKeys,
                redeemScript: originalInput.redeemScript
              }
            : input;
        });
        let signed = { ...contribution, unsignedTx: { ...contributionTx, inputs: restoredInputs } };
        restoredInputs.forEach((input, index) => {
          const originalInput = verified.verifiedTx.inputs.find(
            candidate => outpointKey(candidate.txid, candidate.vout) === outpointKey(input.txid, input.vout)
          );
          if (!originalInput) return;
          const signature = signHash(
            derivePrivateKey(creds.xPrivKey, originalInput.path),
            sighashForInput(signed.unsignedTx, index),
            proposal.coin
          );
          signed = addPartialSignature(signed, index, originalInput.publicKeys[0]!, signature);
        });
        const finalized = finalizePsbt(signed);
        const relayed = await v5Request<TxProposal>(auth, 'POST', `/v5/psbt/${proposal.id}/relay`, {
          raw: finalized.raw
        });
        return { mode: 'payjoin', proposal: relayed, txid: relayed.txid ?? finalized.txid };
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return { mode: 'fallback', proposal, reason: 'PayJoin timeout' };
  } catch (err) {
    return { mode: 'fallback', proposal, reason: (err as Error).message };
  }
}

export interface PayjoinRespondOutcome {
  replied: boolean;
  reason?: string;
}

export async function respondToPayjoinRequest(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  wallet: WalletResponse;
  mnemonic: string;
  envelope: SignedEnvelope;
  senderRequestPubKey: string;
  paymentScriptPubKeyHex: string;
  changeAddress: { address: string; path: string };
  feePerKb?: number;
  maxContributionSats?: number;
}): Promise<PayjoinRespondOutcome> {
  const { auth, creds, envelope } = opts;
  if (!verifyEnvelopeSignature(envelope, opts.senderRequestPubKey)) {
    return { replied: false, reason: 'Envelope signature does not verify' };
  }
  await announceEnvelopeIdentity({
    auth,
    mnemonic: opts.mnemonic,
    requestPubKey: creds.requestPubKey
  });
  const identity = envelopeIdentityFromMnemonic(opts.mnemonic);
  let plaintext: { proposalId?: string; expect?: string; psbt?: string };
  try {
    plaintext = JSON.parse(new TextDecoder().decode(await openEnvelope(envelope, identity.privKeyHex)));
  } catch {
    return { replied: false, reason: 'Envelope cannot be decrypted' };
  }
  if (plaintext.expect !== 'contribute' || !plaintext.psbt) {
    return { replied: false, reason: 'Not a PayJoin contribution request' };
  }
  const original = parsePsbt(plaintext.psbt, { coin: opts.wallet.coin });
  const paymentScript = opts.paymentScriptPubKeyHex.toLowerCase();
  const paymentOutputs = original.unsignedTx.outputs.filter(output => {
    try {
      const script = output.scriptHex
        ? output.scriptHex.toLowerCase()
        : scriptPubKeyHexFromAddress(opts.wallet.coin, output.address).toLowerCase();
      return script === paymentScript;
    } catch {
      return false;
    }
  });
  if (paymentOutputs.length !== 1) {
    return { replied: false, reason: 'Request does not pay the expected script exactly once' };
  }

  const utxos = await api.getUtxos(auth);
  const receiverUtxos: PayjoinReceiverUtxo[] = [];
  for (const utxo of utxos) {
    if (!utxo.path || !utxo.publicKeys || utxo.token) continue;
    try {
      receiverUtxos.push({
        txid: utxo.txid,
        vout: utxo.vout,
        satoshis: utxo.satoshis,
        address: utxo.address,
        path: utxo.path,
        publicKeys: utxo.publicKeys,
        scriptPubKeyHex:
          utxo.scriptPubKey ?? scriptPubKeyHexFromAddress(opts.wallet.coin, utxo.address)
      });
    } catch {
      // skip UTXOs whose script cannot be derived
    }
  }

  let plan;
  try {
    plan = buildPayjoinContribution({
      coin: opts.wallet.coin,
      original,
      paymentScriptPubKeyHex: paymentScript,
      receiverUtxos,
      changeAddress: opts.changeAddress,
      feePerKb: opts.feePerKb,
      maxContributionSats: opts.maxContributionSats
    });
  } catch (err) {
    return { replied: false, reason: (err as Error).message };
  }

  let contribution = applyPayjoinContribution(original, plan);
  contribution = addPartialSignature(
    contribution,
    plan.inputIndex,
    plan.input.publicKeys[0]!,
    signPayjoinContribution(plan, creds.xPrivKey)
  );

  const reply = await sealEnvelope({
    type: 'psbt',
    from: identity.pubKeyHex,
    to: envelope.from,
    plaintext: JSON.stringify({
      proposalId: plaintext.proposalId,
      psbt: psbtToBase64(contribution),
      round: 2,
      expect: 'finalize'
    }),
    requestPrivKeyHex: creds.requestPrivKey,
    expiresAt: Math.min(envelope.expiresAt, Math.floor(Date.now() / 1000) + 3600)
  });
  await v5Request(auth, 'POST', '/v5/envelopes/', reply);
  await v5Request(auth, 'POST', `/v5/envelopes/${envelope.id}/ack`);
  return { replied: true };
}
