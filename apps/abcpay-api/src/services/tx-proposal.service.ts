import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { CreateTxProposalRequest, ProposalInput, SupportedCoin } from '@bcpros/abcpay-models';
import {
  broadcastTx,
  bytesToHex,
  chainFromCoin,
  computeMaxSend,
  defaultFeePerKb,
  deriveWalletAddress,
  dustThreshold,
  estimateTxSize,
  getTokenMetadata,
  minRelayFeePerKb,
  planTokenSend,
  relativePath,
  selectUtxos,
  validateAddress
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { addresses, copayers, txProposals, wallets } from '../db/schema';
import { config } from '../config';
import { walletService } from './wallet.service';
import { notificationService } from './notification.service';

function generateId(): string {
  return randomBytes(16).toString('hex');
}

export const COPAYER_NOT_IN_WALLET = 'Copayer is not a member of this wallet';

export class TxProposalService {
  private async assertCopayerInWallet(copayerId: string, walletId: string) {
    const members = await db
      .select({ copayerId: copayers.copayerId })
      .from(copayers)
      .where(eq(copayers.walletId, walletId));
    if (!members.some(m => m.copayerId === copayerId)) {
      throw new Error(COPAYER_NOT_IN_WALLET);
    }
  }

  private async deriveProposalInputs(
    wallet: typeof wallets.$inferSelect,
    walletCopayers: (typeof copayers.$inferSelect)[],
    utxos: Array<{ txid: string; vout: number; satoshis: number; address: string; path?: string }>
  ): Promise<ProposalInput[]> {
    const addrRows = await db.select().from(addresses).where(eq(addresses.walletId, wallet.walletId));
    return utxos.map(utxo => {
      const row = addrRows.find(a => a.address === utxo.address);
      const derived = deriveWalletAddress({
        coin: wallet.coin as SupportedCoin,
        network: wallet.network as 'livenet' | 'testnet',
        xPubKeys: walletCopayers.map(c => c.xPubKey),
        m: wallet.m,
        n: wallet.n,
        path: row?.path ?? utxo.path ?? relativePath(false, 0)
      });
      return {
        txid: utxo.txid,
        vout: utxo.vout,
        satoshis: utxo.satoshis,
        address: derived.address,
        path: derived.path,
        publicKeys: derived.publicKeys,
        redeemScript: derived.redeemScript,
        scriptPubKey: derived.scriptPubKey
      };
    });
  }

  private async planTokenProposal(
    wallet: typeof wallets.$inferSelect,
    walletCopayers: (typeof copayers.$inferSelect)[],
    proposal: CreateTxProposalRequest['proposals'][number],
    feePerKb: number
  ) {
    if (proposal.sendMax) throw new Error('sendMax is not supported for token sends');
    if (proposal.outputs.length !== 1) throw new Error('Token sends support exactly one recipient');

    const coin = wallet.coin as SupportedCoin;
    const tokenId = proposal.tokenId!.toLowerCase();
    const recipient = proposal.outputs[0];
    const atoms = BigInt(recipient.atoms ?? '0');
    if (atoms <= 0n) throw new Error('Token amount must be greater than zero');
    if (!validateAddress(coin, recipient.toAddress)) {
      throw new Error(`Invalid output address: ${recipient.toAddress}`);
    }

    const metadata = await getTokenMetadata(chainFromCoin(coin), tokenId, config.chronik);
    if (!metadata.protocol) throw new Error(`Token ${tokenId} is not indexed by Chronik`);
    const tokenType = metadata.tokenType ?? (metadata.protocol === 'SLP' ? 1 : 0);

    const dust = dustThreshold(coin);
    const utxos = await walletService.getUtxos(wallet.walletId);
    const plan = planTokenSend({
      coin,
      protocol: metadata.protocol,
      tokenId,
      tokenType,
      utxos,
      atoms,
      feePerKb,
      m: wallet.m,
      n: wallet.n,
      dustSats: dust
    });

    const inputs = await this.deriveProposalInputs(wallet, walletCopayers, plan.inputs);
    const change = await walletService.createAddress(wallet.walletId, true);
    const changeAddress = { address: change.address, path: change.path };

    const outputs: Array<CreateTxProposalRequest['proposals'][number]['outputs'][number] & {
      scriptHex?: string;
      tokenId?: string;
    }> = [
      { toAddress: '', amount: 0, scriptHex: bytesToHex(plan.opReturnScript) },
      {
        toAddress: recipient.toAddress,
        amount: Math.max(recipient.amount ?? dust, dust),
        atoms: atoms.toString(),
        tokenId
      }
    ];
    if (plan.changeAtoms > 0n) {
      outputs.push({ toAddress: change.address, amount: dust, atoms: plan.changeAtoms.toString(), tokenId });
    }
    if (plan.xecChange > 0) {
      outputs.push({ toAddress: change.address, amount: plan.xecChange });
    }

    return {
      inputs,
      changeAddress,
      outputs,
      amount: outputs.reduce((sum, output) => sum + output.amount, 0),
      fee: plan.fee,
      tokenColumns: { tokenId, protocol: metadata.protocol as string, tokenType }
    };
  }

  async createProposal(walletId: string, copayerId: string, req: CreateTxProposalRequest) {
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.status !== 'complete') throw new Error('Wallet is not complete');
    await this.assertCopayerInWallet(copayerId, walletId);

    const proposal = req.proposals[0];
    if (!proposal) throw new Error('No proposal provided');

    for (const output of proposal.outputs) {
      if (!validateAddress(wallet.coin as SupportedCoin, output.toAddress)) {
        throw new Error(`Invalid output address: ${output.toAddress}`);
      }
    }

    let amount = proposal.outputs.reduce((sum, o) => sum + o.amount, 0);
    const feePerKb = Math.max(
      minRelayFeePerKb(wallet.coin as SupportedCoin),
      proposal.feePerKb ?? defaultFeePerKb(wallet.coin as SupportedCoin)
    );
    const walletCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));

    if (proposal.tokenId) {
      return this.createTokenProposal(wallet, walletCopayers, copayerId, proposal, feePerKb);
    }

    let inputs = proposal.inputs as ProposalInput[] | undefined;
    let changeAddress = proposal.changeAddress;
    let fee = 0;

    if (proposal.sendMax) {
      if (proposal.outputs.length !== 1) {
        throw new Error('sendMax requires exactly one output');
      }
      const utxos = await walletService.getUtxos(walletId);
      const max = computeMaxSend({
        coin: wallet.coin as SupportedCoin,
        utxos,
        feePerKb,
        m: wallet.m,
        n: wallet.n,
        outputCount: 1
      });
      fee = max.fee;
      amount = max.amount;
      proposal.outputs[0].amount = max.amount;
      inputs = await this.deriveProposalInputs(wallet, walletCopayers, max.inputs);
      changeAddress = undefined;
    } else if (!inputs || inputs.length === 0) {
      const utxos = await walletService.getUtxos(walletId);
      const selected = selectUtxos({
        coin: wallet.coin as SupportedCoin,
        utxos,
        amount,
        feePerKb,
        m: wallet.m,
        n: wallet.n,
        outputCount: proposal.outputs.length + 1
      });
      fee = selected.fee;
      inputs = await this.deriveProposalInputs(wallet, walletCopayers, selected.inputs);
      if (selected.change > 0) {
        const change = await walletService.createAddress(walletId, true);
        changeAddress = { address: change.address, path: change.path };
      }
    } else {
      const addrRows = await db.select().from(addresses).where(eq(addresses.walletId, walletId));
      inputs = inputs.map(input => {
        const row = addrRows.find(a => a.address === input.address);
        const derived = deriveWalletAddress({
          coin: wallet.coin as SupportedCoin,
          network: wallet.network as 'livenet' | 'testnet',
          xPubKeys: walletCopayers.map(c => c.xPubKey),
          m: wallet.m,
          n: wallet.n,
          path: row?.path ?? input.path
        });
        return {
          ...input,
          path: derived.path,
          publicKeys: derived.publicKeys,
          redeemScript: derived.redeemScript,
          scriptPubKey: derived.scriptPubKey
        };
      });
      const totalIn = inputs.reduce((sum, i) => sum + i.satoshis, 0);
      const size = estimateTxSize(inputs.length, proposal.outputs.length + 1, wallet.n, wallet.m);
      fee = Math.max(1, Math.ceil((size * feePerKb) / 1000));
      const dust = dustThreshold(wallet.coin as SupportedCoin);
      const change = totalIn - amount - fee;
      if (change < 0) throw new Error('Insufficient funds');
      if (change < dust) {
        // The omitted change becomes part of the fee, so report the actual fee.
        fee = totalIn - amount;
        changeAddress = undefined;
      } else if (!changeAddress) {
        const alternate = await walletService.createAddress(walletId, true);
        changeAddress = { address: alternate.address, path: alternate.path };
      }
    }

    const proposalId = generateId();
    const [created] = await db
      .insert(txProposals)
      .values({
        proposalId,
        walletId,
        creatorId: copayerId,
        coin: wallet.coin,
        chain: wallet.chain,
        network: wallet.network,
        outputs: proposal.outputs,
        amount,
        fee,
        feePerKb,
        message: proposal.message,
        changeAddress,
        inputs,
        status: 'pending',
        signatures: {},
        actions: []
      })
      .returning();

    notificationService.publish({
      type: 'proposal.created',
      walletId,
      proposalId,
      status: 'pending',
      copayerId
    });

    return this.toResponse(created, wallet.m);
  }

  private async createTokenProposal(
    wallet: typeof wallets.$inferSelect,
    walletCopayers: (typeof copayers.$inferSelect)[],
    copayerId: string,
    proposal: CreateTxProposalRequest['proposals'][number],
    feePerKb: number
  ) {
    const planned = await this.planTokenProposal(wallet, walletCopayers, proposal, feePerKb);
    const proposalId = generateId();

    const [created] = await db
      .insert(txProposals)
      .values({
        proposalId,
        walletId: wallet.walletId,
        creatorId: copayerId,
        coin: wallet.coin,
        chain: wallet.chain,
        network: wallet.network,
        outputs: planned.outputs,
        amount: planned.amount,
        fee: planned.fee,
        feePerKb,
        message: proposal.message,
        changeAddress: planned.changeAddress,
        inputs: planned.inputs,
        status: 'pending',
        signatures: {},
        actions: [],
        tokenId: planned.tokenColumns.tokenId,
        protocol: planned.tokenColumns.protocol,
        tokenType: planned.tokenColumns.tokenType
      })
      .returning();

    notificationService.publish({
      type: 'proposal.created',
      walletId: wallet.walletId,
      proposalId,
      status: 'pending',
      copayerId
    });

    return this.toResponse(created, wallet.m);
  }

  async getProposals(walletId: string) {
    const rows = await db.select().from(txProposals).where(eq(txProposals.walletId, walletId));
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, walletId)).limit(1);
    return rows.map(r => this.toResponse(r, wallet?.m ?? 1));
  }

  async getProposal(proposalId: string) {
    const [proposal] = await db.select().from(txProposals).where(eq(txProposals.proposalId, proposalId)).limit(1);
    if (!proposal) return null;
    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, proposal.walletId)).limit(1);
    return this.toResponse(proposal, wallet?.m ?? 1);
  }

  async signProposal(proposalId: string, copayerId: string, signatures: string[]) {
    const [proposal] = await db.select().from(txProposals).where(eq(txProposals.proposalId, proposalId)).limit(1);
    if (!proposal) throw new Error('Proposal not found');
    await this.assertCopayerInWallet(copayerId, proposal.walletId);
    if (proposal.status === 'rejected' || proposal.status === 'broadcasted') {
      throw new Error('Proposal can no longer be signed');
    }

    const [copayer] = await db.select().from(copayers).where(eq(copayers.copayerId, copayerId)).limit(1);
    const sigs = { ...((proposal.signatures as Record<string, string[]>) ?? {}) };
    sigs[copayerId] = signatures;

    const actions = [
      ...((proposal.actions as Array<Record<string, unknown>>) ?? []).filter(a => a.copayerId !== copayerId),
      {
        type: 'accept',
        copayerId,
        copayerName: copayer?.name ?? copayerId,
        createdOn: Date.now()
      }
    ];

    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, proposal.walletId)).limit(1);
    const sigCount = Object.keys(sigs).length;
    const status = sigCount >= (wallet?.m ?? 1) ? 'accepted' : 'pending';

    const [updated] = await db
      .update(txProposals)
      .set({ signatures: sigs, actions, status, updatedAt: new Date() })
      .where(eq(txProposals.proposalId, proposalId))
      .returning();

    notificationService.publish({
      type: 'proposal.signed',
      walletId: proposal.walletId,
      proposalId,
      status,
      copayerId,
      copayerName: copayer?.name ?? copayerId
    });

    return this.toResponse(updated, wallet?.m ?? 1);
  }

  async rejectProposal(proposalId: string, copayerId: string, comment?: string) {
    const [proposal] = await db.select().from(txProposals).where(eq(txProposals.proposalId, proposalId)).limit(1);
    if (!proposal) throw new Error('Proposal not found');
    await this.assertCopayerInWallet(copayerId, proposal.walletId);

    const [copayer] = await db.select().from(copayers).where(eq(copayers.copayerId, copayerId)).limit(1);
    const actions = [
      ...((proposal.actions as Array<Record<string, unknown>>) ?? []),
      {
        type: 'reject',
        copayerId,
        copayerName: copayer?.name ?? copayerId,
        comment,
        createdOn: Date.now()
      }
    ];

    const [updated] = await db
      .update(txProposals)
      .set({ actions, status: 'rejected', updatedAt: new Date() })
      .where(eq(txProposals.proposalId, proposalId))
      .returning();

    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, proposal.walletId)).limit(1);

    notificationService.publish({
      type: 'proposal.rejected',
      walletId: proposal.walletId,
      proposalId,
      status: 'rejected',
      copayerId,
      copayerName: copayer?.name ?? copayerId,
      message: comment
    });

    return this.toResponse(updated, wallet?.m ?? 1);
  }

  async broadcastProposal(proposalId: string, copayerId: string, raw: string) {
    const [proposal] = await db.select().from(txProposals).where(eq(txProposals.proposalId, proposalId)).limit(1);
    if (!proposal) throw new Error('Proposal not found');
    await this.assertCopayerInWallet(copayerId, proposal.walletId);
    if (proposal.status !== 'accepted' && proposal.status !== 'pending') {
      throw new Error('Proposal is not ready to broadcast');
    }

    const chain = chainFromCoin(proposal.coin as SupportedCoin);
    let txid: string;
    try {
      txid = await broadcastTx(chain, raw, {
        xecUrls: config.chronik.xecUrls,
        dogeUrls: config.chronik.dogeUrls
      });
    } catch (err) {
      const [copayer] = await db.select().from(copayers).where(eq(copayers.copayerId, copayerId)).limit(1);
      const actions = [
        ...((proposal.actions as Array<Record<string, unknown>>) ?? []),
        {
          type: 'broadcast_error',
          copayerId,
          copayerName: copayer?.name ?? copayerId,
          comment: `Broadcast failed: ${(err as Error).message}`,
          createdOn: Date.now()
        }
      ];
      await db
        .update(txProposals)
        .set({ actions, status: 'rejected', updatedAt: new Date() })
        .where(eq(txProposals.proposalId, proposalId));

      notificationService.publish({
        type: 'proposal.rejected',
        walletId: proposal.walletId,
        proposalId,
        status: 'rejected',
        copayerId,
        copayerName: copayer?.name ?? copayerId,
        message: `Broadcast failed: ${(err as Error).message}`
      });
      throw err;
    }

    const [updated] = await db
      .update(txProposals)
      .set({ raw, txid, status: 'broadcasted', updatedAt: new Date() })
      .where(eq(txProposals.proposalId, proposalId))
      .returning();

    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, proposal.walletId)).limit(1);

    notificationService.publish({
      type: 'proposal.broadcast',
      walletId: proposal.walletId,
      proposalId,
      status: 'broadcasted',
      txid,
      copayerId
    });

    return this.toResponse(updated, wallet?.m ?? 1);
  }

  async broadcastRaw(coin: SupportedCoin, raw: string) {
    const chain = chainFromCoin(coin);
    const txid = await broadcastTx(chain, raw, {
      xecUrls: config.chronik.xecUrls,
      dogeUrls: config.chronik.dogeUrls
    });
    return { txid };
  }

  private toResponse(proposal: typeof txProposals.$inferSelect, requiredM: number) {
    const sigs = (proposal.signatures as Record<string, string[]>) ?? {};
    return {
      id: proposal.proposalId,
      walletId: proposal.walletId,
      creatorId: proposal.creatorId,
      coin: proposal.coin,
      chain: proposal.chain,
      network: proposal.network,
      outputs: proposal.outputs,
      amount: proposal.amount,
      fee: proposal.fee,
      feePerKb: proposal.feePerKb,
      tokenId: proposal.tokenId ?? undefined,
      protocol: proposal.protocol ?? undefined,
      tokenType: proposal.tokenType ?? undefined,
      message: proposal.message ?? undefined,
      changeAddress: proposal.changeAddress ?? undefined,
      inputs: proposal.inputs ?? [],
      requiredSignatures: requiredM,
      requiredRejections: 1,
      status: proposal.status,
      createdOn: proposal.createdAt.getTime(),
      updatedOn: proposal.updatedAt.getTime(),
      txid: proposal.txid ?? undefined,
      raw: proposal.raw ?? undefined,
      actions: (proposal.actions as Array<Record<string, unknown>>) ?? [],
      signatures: sigs
    };
  }
}

export const txProposalService = new TxProposalService();
