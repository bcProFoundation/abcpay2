import type { TxProposal } from '@bcpros/abcpay-models';
import {
  assembleTxHex,
  mergeCopayerSignatures,
  signTxInputs,
  unsignedTxFromProposal,
  type UnsignedInput
} from '@bcpros/abcpay-wallet-core';
import type { StoredCredentials } from '../context/WalletContext';
import { api, type AuthContext } from './api';

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

export async function signAndMaybeBroadcast(
  proposal: TxProposal,
  creds: StoredCredentials,
  auth: AuthContext,
  copayers: Array<{ copayerId?: string; id?: string; xPubKey: string }>
): Promise<TxProposal> {
  const unsigned = proposalToUnsignedTx(proposal);
  const signatures = signTxInputs(unsigned, creds.xPrivKey);
  const signed = await api.signTxProposal(auth, proposal.id, signatures);

  if (signed.status !== 'accepted') return signed;

  const allSigs = signed.signatures ?? {};
  const merged = mergeCopayerSignatures({
    tx: unsigned,
    copayers: copayers.map(c => ({ copayerId: c.copayerId ?? c.id ?? '', xPubKey: c.xPubKey })),
    signatures: allSigs
  });
  const raw = assembleTxHex(unsigned, merged);
  return api.broadcastTxProposal(auth, proposal.id, raw);
}

export async function createAndSendPayment(opts: {
  auth: AuthContext;
  creds: StoredCredentials;
  toAddress: string;
  satoshis: number;
  message?: string;
  sendMax?: boolean;
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
        sendMax: opts.sendMax
      }
    ]
  });
  const proposal = await signAndMaybeBroadcast(created, opts.creds, opts.auth, wallet.copayers);
  return { proposal, txid: proposal.txid };
}
