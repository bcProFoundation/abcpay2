import { and, eq, inArray } from 'drizzle-orm';
import type { TxProposal } from '@bcpros/abcpay-models';
import {
  addPartialSignature,
  derivePublicKey,
  finalizePsbt,
  isFullySigned,
  parsePsbt,
  psbtToBase64,
  serializePsbt,
  sha256Hex,
  sighashForInput,
  txToPsbt,
  unsignedTxFromProposal,
  verifyInputSignature,
  type Psbt,
  type UnsignedInput
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { copayers, txProposals } from '../db/schema';
import { txProposalService } from './tx-proposal.service';

export interface CopayerSignatureInput {
  inputIndex: number;
  pubKeyHex: string;
  signatureHex: string;
}

export class PsbtService {
  psbtHash(psbt: Psbt): string {
    return sha256Hex(serializePsbt(psbt));
  }

  buildPsbt(proposal: TxProposal): Psbt {
    const tx = unsignedTxFromProposal({
      coin: proposal.coin,
      inputs: (proposal.inputs ?? []) as UnsignedInput[],
      outputs: proposal.outputs,
      amount: proposal.amount,
      fee: proposal.fee,
      changeAddress: proposal.changeAddress
    });
    const outputMeta = proposal.outputs.map(output =>
      output.atoms !== undefined
        ? { tokenId: output.tokenId, protocol: proposal.protocol, atoms: output.atoms }
        : undefined
    );
    return txToPsbt({ tx, proposalIdHex: proposal.id, outputMeta });
  }

  async storeForProposal(proposal: TxProposal): Promise<{ psbt: string; psbtSha256: string }> {
    const psbt = this.buildPsbt(proposal);
    const base64 = psbtToBase64(psbt);
    const psbtSha256 = this.psbtHash(psbt);
    await db
      .update(txProposals)
      .set({ psbt: base64, psbtSha256, format: 'psbt' })
      .where(eq(txProposals.proposalId, proposal.id));
    return { psbt: base64, psbtSha256 };
  }

  async loadStored(proposalId: string): Promise<{ psbt: string; psbtSha256: string } | undefined> {
    const [row] = await db
      .select({ psbt: txProposals.psbt, psbtSha256: txProposals.psbtSha256 })
      .from(txProposals)
      .where(eq(txProposals.proposalId, proposalId))
      .limit(1);
    if (!row?.psbt) return undefined;
    const psbt = parsePsbt(row.psbt, { coin: 'xec' });
    return { psbt: row.psbt, psbtSha256: row.psbtSha256 ?? this.psbtHash(psbt) };
  }

  parseStored(base64: string, coin: 'xec' | 'doge' = 'xec'): Psbt {
    return parsePsbt(base64, { coin });
  }

  async attachCopayerSignatures(
    proposalId: string,
    copayerId: string,
    signatures: CopayerSignatureInput[]
  ): Promise<{ psbt: string; psbtSha256: string; proposal: Awaited<ReturnType<typeof txProposalService.getProposal>> }> {
    const proposal = (await txProposalService.getProposal(proposalId)) as TxProposal & {
      status?: string;
    };
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status === 'rejected' || proposal.status === 'broadcasted') {
      throw new Error('Proposal can no longer be signed');
    }
    const stored = await this.loadStored(proposalId);
    if (!stored) throw new Error('Proposal has no PSBT');
    const psbt = this.parseStored(stored.psbt, proposal.coin);

    const [copayer] = await db
      .select({ xPubKey: copayers.xPubKey })
      .from(copayers)
      .where(eq(copayers.copayerId, copayerId))
      .limit(1);
    if (!copayer) throw new Error('Copayer is not a member of this wallet');
    const inputs = (proposal.inputs ?? []) as Array<{ path: string }>;

    let next = psbt;
    for (const signature of signatures) {
      const path = inputs[signature.inputIndex]?.path;
      if (!path) throw new Error('PSBT: input index out of range');
      const ownKey = derivePublicKey(copayer.xPubKey, path).toLowerCase();
      if (signature.pubKeyHex.toLowerCase() !== ownKey) {
        throw new Error('Signatures may only be attached for your own keys');
      }
      const sighash = sighashForInput(next.unsignedTx, signature.inputIndex);
      if (!verifyInputSignature(signature.signatureHex, sighash, ownKey, proposal.coin)) {
        throw new Error('Signature does not verify');
      }
      next = addPartialSignature(next, signature.inputIndex, ownKey, signature.signatureHex);
    }

    const mirror = next.inputs.map((input, index) => {
      const pubKeyHex = derivePublicKey(copayer.xPubKey, inputs[index]!.path).toLowerCase();
      const found = input.partialSigs.find(sig => sig.pubKeyHex.toLowerCase() === pubKeyHex);
      return found?.signatureHex ?? '';
    });
    if (mirror.some(entry => entry === '')) {
      throw new Error('Attach one signature per input for your own keys');
    }
    const base64 = psbtToBase64(next);
    const psbtSha256 = this.psbtHash(next);
    const updatedRows = await db
      .update(txProposals)
      .set({ psbt: base64, psbtSha256, format: 'psbt' })
      .where(
        and(
          eq(txProposals.proposalId, proposalId),
          eq(txProposals.psbtSha256, stored.psbtSha256),
          inArray(txProposals.status, ['pending', 'accepted'])
        )
      )
      .returning({ id: txProposals.id });
    if (updatedRows.length === 0) {
      throw new Error('PSBT changed concurrently or proposal is no longer signable; retry');
    }
    const updated = await txProposalService.signProposal(proposalId, copayerId, mirror);
    return { psbt: base64, psbtSha256, proposal: updated };
  }

  async finalize(proposalId: string, coin: 'xec' | 'doge' = 'xec'): Promise<{ raw: string; txid: string }> {
    const stored = await this.loadStored(proposalId);
    if (!stored) throw new Error('Proposal has no PSBT');
    const psbt = this.parseStored(stored.psbt, coin);
    if (!isFullySigned(psbt)) throw new Error('PSBT is not fully signed');
    return finalizePsbt(psbt);
  }
}

export const psbtService = new PsbtService();
