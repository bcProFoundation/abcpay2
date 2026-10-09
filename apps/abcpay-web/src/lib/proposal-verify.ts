import type { TxProposal, WalletResponse } from '@bcpros/abcpay-models';
import {
  parsePath,
  verifyProposal,
  type VerifyChainData,
  type VerifyProposalIntent,
  type VerifyProposalResult,
  type VerifyWalletFacts
} from '@bcpros/abcpay-wallet-core';
import { api, type AuthContext } from './api';

export interface SendIntent {
  toAddress: string;
  amountSat?: number;
  sendMax?: boolean;
  tokenId?: string;
  protocol?: 'SLP' | 'ALP';
  tokenType?: number;
  atoms?: string;
  feePerKb?: number;
}

export class ProposalVerificationError extends Error {
  constructor(
    public readonly rule: string,
    detail: string
  ) {
    super(`Proposal rejected by client verification (${rule}): ${detail}`);
    this.name = 'ProposalVerificationError';
  }
}

interface UsedAddress {
  address: string;
  path: string;
  isChange: boolean;
}

interface WalletRecord {
  xPubKeys: string[];
  used: UsedAddress[];
}

const RECORDS_KEY = 'abcpay_v2_wallet_records';

function loadRecords(): Record<string, WalletRecord> {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '{}') as Record<string, WalletRecord>;
  } catch {
    return {};
  }
}

function saveRecords(records: Record<string, WalletRecord>): void {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
}

export function joinRecordFor(wallet: WalletResponse, walletId: string): WalletRecord {
  const records = loadRecords();
  const existing = records[walletId];
  const remoteKeys = wallet.copayers.map(copayer => copayer.xPubKey).sort();
  if (existing) return existing;
  const record: WalletRecord = { xPubKeys: remoteKeys, used: [] };
  records[walletId] = record;
  saveRecords(records);
  return record;
}

export function rememberUsedAddresses(walletId: string, entries: UsedAddress[]): void {
  if (entries.length === 0) return;
  const records = loadRecords();
  const record = records[walletId] ?? { xPubKeys: [], used: [] };
  for (const entry of entries) {
    if (!record.used.some(used => used.address === entry.address)) {
      record.used.push(entry);
    }
  }
  records[walletId] = record;
  saveRecords(records);
}

function changePointerFor(used: UsedAddress[]): number {
  return used
    .filter(entry => entry.isChange)
    .reduce((max, entry) => {
      try {
        return Math.max(max, parsePath(entry.path).index + 1);
      } catch {
        return max;
      }
    }, 0);
}

function utxoKey(utxo: { txid: string; vout: number }): string {
  return `${utxo.txid}:${utxo.vout}`;
}

interface ChainUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  path?: string;
  token?: { tokenId: string; atoms: string; isMintBaton: boolean };
}

export function chainDataFromUtxos(utxos: ChainUtxo[]): VerifyChainData {
  const inputAmounts = new Map<string, number>();
  const inputTokens = new Map<
    string,
    { tokenId: string | null; atoms: string; isMintBaton?: boolean }
  >();
  for (const utxo of utxos) {
    inputAmounts.set(utxoKey(utxo), utxo.satoshis);
    inputTokens.set(
      utxoKey(utxo),
      utxo.token
        ? {
            tokenId: utxo.token.tokenId.toLowerCase(),
            atoms: utxo.token.atoms,
            isMintBaton: utxo.token.isMintBaton
          }
        : { tokenId: null, atoms: '0' }
    );
  }
  return { inputAmounts, inputTokens };
}

export function intentFromProposal(proposal: TxProposal): SendIntent {
  const tokenOutputs = proposal.outputs.filter(output => output.atoms !== undefined);
  if (tokenOutputs.length > 0) {
    const payment =
      tokenOutputs.find(
        output => !proposal.changeAddress || output.toAddress !== proposal.changeAddress.address
      ) ?? tokenOutputs[0]!;
    return {
      toAddress: payment.toAddress,
      tokenId: (payment.tokenId ?? proposal.tokenId ?? '').toLowerCase(),
      protocol: proposal.protocol ?? 'SLP',
      tokenType: proposal.tokenType ?? (proposal.protocol === 'ALP' ? 0 : 1),
      atoms: payment.atoms
    };
  }
  const payment = proposal.outputs[0];
  if (!payment) throw new ProposalVerificationError('R3', 'proposal has no outputs');
  return { toAddress: payment.toAddress, amountSat: payment.amount };
}

export async function verifyProposalBeforeSign(opts: {
  proposal: TxProposal;
  intent?: SendIntent;
  auth: AuthContext;
  wallet: WalletResponse;
}): Promise<Extract<VerifyProposalResult, { ok: true }>> {
  const { proposal, auth, wallet } = opts;
  const intent = opts.intent ?? intentFromProposal(proposal);
  const record = joinRecordFor(wallet, auth.walletId);
  const utxos = await api.getUtxos(auth);
  const chain = chainDataFromUtxos(utxos);
  const used: UsedAddress[] = utxos.map(utxo => ({
    address: utxo.address,
    path: utxo.path ?? 'm/0/0',
    isChange: safeIsChange(utxo.path)
  }));
  const facts: VerifyWalletFacts = {
    walletId: auth.walletId,
    coin: proposal.coin,
    network: proposal.network as 'livenet' | 'testnet',
    m: wallet.m,
    n: wallet.n,
    memberXpubKeys: record.xPubKeys,
    changeAddressIndex: changePointerFor(record.used),
    usedAddresses: [...record.used, ...used].map(entry => entry.address)
  };
  const verifyIntent: VerifyProposalIntent = {
    toAddress: intent.toAddress,
    amountSat: intent.amountSat,
    sendMax: intent.sendMax,
    tokenId: intent.tokenId,
    protocol: intent.protocol,
    tokenType: intent.tokenType,
    atoms: intent.atoms,
    feePerKb: intent.feePerKb
  };
  const result = verifyProposal({ intent: verifyIntent, proposal, wallet: facts, chain });
  if (!result.ok) {
    throw new ProposalVerificationError(result.rule, result.detail);
  }
  const changeEntries: UsedAddress[] = proposal.changeAddress
    ? [
        {
          address: proposal.changeAddress.address,
          path: proposal.changeAddress.path,
          isChange: true
        }
      ]
    : [];
  rememberUsedAddresses(auth.walletId, changeEntries);
  return result;
}

function safeIsChange(path: string | undefined): boolean {
  if (!path) return false;
  try {
    return parsePath(path).isChange;
  } catch {
    return false;
  }
}
