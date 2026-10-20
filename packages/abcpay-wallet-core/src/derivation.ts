import type { SupportedCoin } from '@bcpros/abcpay-models';
import { COIN_CONFIGS } from '@bcpros/abcpay-models';

export interface DerivationPathOptions {
  coin: SupportedCoin;
  account: number;
  isChange: boolean;
  addressIndex: number;
  usePurpose48?: boolean;
  isMultisig?: boolean;
  coinType?: number;
}

export function getDerivationPath(opts: DerivationPathOptions): string {
  const coinType = opts.coinType ?? COIN_CONFIGS[opts.coin].bip44CoinType;
  const purpose = opts.usePurpose48 || opts.isMultisig ? 48 : 44;
  const change = opts.isChange ? 1 : 0;
  return `m/${purpose}'/${coinType}'/${opts.account}'/${change}/${opts.addressIndex}`;
}

export function getRootPath(opts: {
  coin: SupportedCoin;
  account?: number;
  usePurpose48?: boolean;
  isMultisig?: boolean;
  coinType?: number;
}): string {
  const coinType = opts.coinType ?? COIN_CONFIGS[opts.coin].bip44CoinType;
  const purpose = opts.usePurpose48 || opts.isMultisig ? 48 : 44;
  const account = opts.account ?? 0;
  return `m/${purpose}'/${coinType}'/${account}'`;
}

/** Grouped decimal string, e.g. 689169783.73 → "689,169,783.73". */
export function formatFixed(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return (0).toFixed(Math.max(0, decimals));
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: true
  }).format(value);
}

/** USD display with grouping, e.g. 1234.5 → "$1,234.50". */
export function formatFiatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatAmount(coin: SupportedCoin, satoshis: number): string {
  const config = COIN_CONFIGS[coin];
  const amount = satoshis / config.unitToSatoshi;
  return `${formatFixed(amount, config.unitDecimals)} ${config.unitName}`;
}

export function toSatoshis(coin: SupportedCoin, amount: number): number {
  return Math.round(amount * COIN_CONFIGS[coin].unitToSatoshi);
}

export function fromSatoshis(coin: SupportedCoin, satoshis: number): number {
  return satoshis / COIN_CONFIGS[coin].unitToSatoshi;
}
