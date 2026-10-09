import type { TxProposal } from '@bcpros/abcpay-models';
import {
  assembleTxHex,
  mergeCopayerSignatures,
  signTxInputs,
  unsignedTxFromProposal,
  type UnsignedInput,
  type UnsignedTx
} from '@bcpros/abcpay-wallet-core';
import type { StoredCredentials } from '../context/WalletContext';
import { api, type AuthContext } from './api';
import {
  verifyProposalBeforeSign,
  type SendIntent
} from './proposal-verify';

export function proposalToUnsignedTx(proposal: TxProposal) {
  return unsignedTxFromProposal({
    coin: proposal.coin,
    inputs: (proposal.inputs ?? []) as UnsignedInput[],
    outputs: proposal.outputs,
    amount: proposal.amount,
    fee: proposal.fee,
    changeAddress: proposal.changeAddress
  });
}

export async function broadcastProposal(
  proposal: TxProposal,
  auth: AuthContext,
  copayers: Array<{ copayerId?: string; id?: string; xPubKey: string }>,
  unsignedOverride?: UnsignedTx
): Promise<TxProposal> {
  const unsigned = unsignedOverride ?? proposalToUnsignedTx(proposal);
  const merged = mergeCopayerSignatures({
    tx: unsigned,
    copayers: copayers.map(c => ({ copayerId: c.copayerId ?? c.id ?? '', xPubKey: c.xPubKey })),
    signatures: proposal.signatures ?? {}
  });
  const raw = assembleTxHex(unsigned, merged);
  return api.broadcastTxProposal(auth, proposal.id, raw);
}

export async function signAndMaybeBroadcast(
  proposal: TxProposal,
  creds: StoredCredentials,
  auth: AuthContext,
  copayers: Array<{ copayerId?: string; id?: string; xPubKey: string }>,
  intent?: SendIntent
): Promise<TxProposal> {
  const wallet = await api.getWallet(auth);
  const verified = await verifyProposalBeforeSign({ proposal, intent, auth, wallet });
  const signatures = signTxInputs(verified.verifiedTx, creds.xPrivKey);
  const signed = await api.signTxProposal(auth, proposal.id, signatures);

  if (signed.status !== 'accepted') return signed;
  return broadcastProposal(signed, auth, copayers, verified.verifiedTx);
}

export async function createAndSendPayment(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  toAddress: string;
  satoshis: number;
  message?: string;
  sendMax?: boolean;
  feePerKb?: number;
}): Promise<{ proposal: TxProposal; txid?: string }> {
  const wallet = await api.getWallet(opts.auth);
  const created = await api.createTxProposal(opts.auth, {
    proposals: [
      {
        outputs: [
          {
            toAddress: opts.toAddress,
            amount: opts.sendMax ? 0 : opts.satoshis,
            message: opts.message
          }
        ],
        sendMax: opts.sendMax,
        feePerKb: opts.feePerKb
      }
    ]
  });
  const intent: SendIntent = {
    toAddress: opts.toAddress,
    amountSat: opts.sendMax ? undefined : opts.satoshis,
    sendMax: opts.sendMax,
    feePerKb: opts.feePerKb
  };
  const proposal = await signAndMaybeBroadcast(
    created,
    opts.creds,
    opts.auth,
    wallet.copayers,
    intent
  );
  return { proposal, txid: proposal.txid };
}

/** Sends `atoms` of a token to a single recipient. XEC dust and fees come from the wallet. */
export async function createAndSendToken(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  tokenId: string;
  toAddress: string;
  atoms: string;
  message?: string;
  protocol?: 'SLP' | 'ALP';
  tokenType?: number;
}): Promise<{ proposal: TxProposal; txid?: string }> {
  const wallet = await api.getWallet(opts.auth);
  const created = await api.createTxProposal(opts.auth, {
    proposals: [
      {
        tokenId: opts.tokenId,
        outputs: [
          {
            toAddress: opts.toAddress,
            amount: 546,
            atoms: opts.atoms,
            message: opts.message
          }
        ]
      }
    ]
  });
  const intent: SendIntent = {
    toAddress: opts.toAddress,
    tokenId: opts.tokenId.toLowerCase(),
    protocol: opts.protocol ?? created.protocol ?? 'SLP',
    tokenType: opts.tokenType ?? created.tokenType,
    atoms: opts.atoms
  };
  const proposal = await signAndMaybeBroadcast(
    created,
    opts.creds,
    opts.auth,
    wallet.copayers,
    intent
  );
  return { proposal, txid: proposal.txid };
}
