import type { SupportedCoin } from '@bcpros/abcpay-models';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';

export interface DerivationPathOptions {
  coin: SupportedCoin;
  account: number;
  isChange: boolean;
  addressIndex: number;
  usePurpose48?: boolean;
  isMultisig?: boolean;
}

export function getDerivationPath(opts: DerivationPathOptions): string {
  const coinType = COIN_CONFIGS[opts.coin].bip44CoinType;
  const purpose = opts.usePurpose48 || opts.isMultisig ? 48 : 44;
  const change = opts.isChange ? 1 : 0;
  return `m/${purpose}'/${coinType}'/${opts.account}'/${change}/${opts.addressIndex}`;
}

export function getRootPath(opts: {
  coin: SupportedCoin;
  account?: number;
  usePurpose48?: boolean;
  isMultisig?: boolean;
}): string {
  const coinType = COIN_CONFIGS[opts.coin].bip44CoinType;
  const purpose = opts.usePurpose48 || opts.isMultisig ? 48 : 44;
  const account = opts.account ?? 0;
  return `m/${purpose}'/${coinType}'/${account}'`;
}

export function formatAmount(coin: SupportedCoin, satoshis: number): string {
  const config = COIN_CONFIGS[coin];
  const amount = satoshis / config.unitToSatoshi;
  return `${amount.toFixed(config.unitDecimals)} ${config.unitName}`;
}

export function toSatoshis(coin: SupportedCoin, amount: number): number {
  return Math.round(amount * COIN_CONFIGS[coin].unitToSatoshi);
}

export function fromSatoshis(coin: SupportedCoin, satoshis: number): number {
  return satoshis / COIN_CONFIGS[coin].unitToSatoshi;
}
