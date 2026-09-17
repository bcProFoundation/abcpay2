export type NotificationEventType =
  | 'proposal.created'
  | 'proposal.signed'
  | 'proposal.rejected'
  | 'proposal.broadcast'
  | 'wallet.joined'
  | 'wallet.complete';

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
}

export const NOTIFICATION_PATH = '/v1/notifications/';
