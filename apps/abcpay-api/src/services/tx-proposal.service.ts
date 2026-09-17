import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { CreateTxProposalRequest, ProposalInput, SupportedCoin } from '@bcpros/abcpay-models';
import {
  broadcastTx,
  chainFromCoin,
  defaultFeePerKb,
  deriveWalletAddress,
  dustThreshold,
  estimateTxSize,
  relativePath,
  selectUtxos,
  validateAddress
} from '@bcpros/abcpay-wallet-core';
import { db } from '../db';
import { addresses, copayers, txProposals, wallets } from '../db/schema';
import { config } from '../config';
import { walletService } from './wallet.service';

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

    const amount = proposal.outputs.reduce((sum, o) => sum + o.amount, 0);
    const feePerKb = proposal.feePerKb ?? defaultFeePerKb(wallet.coin as SupportedCoin);
    const walletCopayers = await db.select().from(copayers).where(eq(copayers.walletId, walletId));
    let inputs = proposal.inputs as ProposalInput[] | undefined;
    let changeAddress = proposal.changeAddress;
    let fee = 0;

    if (!inputs || inputs.length === 0) {
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
      const addrRows = await db.select().from(addresses).where(eq(addresses.walletId, walletId));
      inputs = selected.inputs.map(utxo => {
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
    const txid = await broadcastTx(chain, raw, {
      xecUrls: config.chronik.xecUrls,
      dogeUrls: config.chronik.dogeUrls
    });

    const [updated] = await db
      .update(txProposals)
      .set({ raw, txid, status: 'broadcasted', updatedAt: new Date() })
      .where(eq(txProposals.proposalId, proposalId))
      .returning();

    const [wallet] = await db.select().from(wallets).where(eq(wallets.walletId, proposal.walletId)).limit(1);
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
