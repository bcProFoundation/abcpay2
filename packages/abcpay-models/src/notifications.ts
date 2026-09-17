export type NotificationEventType =
  | 'proposal.created'
  | 'proposal.signed'
  | 'proposal.rejected'
  | 'proposal.broadcast'
  | 'wallet.joined'
  | 'wallet.complete'
  | 'wallet.activity';

export interface NotificationEvent {
  type: NotificationEventType;
  walletId: string;
  at: number;
  proposalId?: string;
  status?: string;
  txid?: string;
  copayerId?: string;
  copayerName?: string;
  message?: string;
  /** Chain watcher messages: TX_ADDED_TO_MEMPOOL, TX_CONFIRMED, TX_FINALIZED, ... */
  msgType?: string;
  direction?: 'sent' | 'received';
}

export const NOTIFICATION_PATH = '/v1/notifications/';
