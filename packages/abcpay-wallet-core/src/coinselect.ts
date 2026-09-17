import type { SupportedCoin } from '@bcpros/abcpay-models';
import { estimateTxSize } from './tx';

export interface SelectableUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  path?: string;
  confirmations?: number;
  token?: { tokenId: string; atoms: string; isMintBaton: boolean } | null;
}

export interface CoinSelectResult {
  inputs: SelectableUtxo[];
  fee: number;
  change: number;
  totalInput: number;
}

export function dustThreshold(coin: SupportedCoin): number {
  return coin === 'xec' ? 546 : 1_000_000;
}

export function defaultFeePerKb(coin: SupportedCoin): number {
  return coin === 'xec' ? 2000 : 100_000_000;
}

export function minRelayFeePerKb(coin: SupportedCoin): number {
  return coin === 'xec' ? 1000 : 100_000_000;
}

export function isSpendableUtxo(utxo: SelectableUtxo): boolean {
  return !utxo.token;
}

export function selectUtxos(opts: {
  coin: SupportedCoin;
  utxos: SelectableUtxo[];
  amount: number;
  feePerKb?: number;
  m?: number;
  n?: number;
  outputCount?: number;
}): CoinSelectResult {
  const feePerKb = opts.feePerKb ?? defaultFeePerKb(opts.coin);
  const minFeePerKb = Math.min(minRelayFeePerKb(opts.coin), feePerKb);
  const dust = dustThreshold(opts.coin);
  const sorted = opts.utxos.filter(isSpendableUtxo).sort((a, b) => b.satoshis - a.satoshis);
  const selected: SelectableUtxo[] = [];
  let totalInput = 0;
  let minFee = 0;
  const m = opts.m ?? 1;
  const n = opts.n ?? 1;

  for (const utxo of sorted) {
    selected.push(utxo);
    totalInput += utxo.satoshis;
    const size = estimateTxSize(selected.length, opts.outputCount ?? 2, n, m);
    const targetFee = Math.max(1, Math.ceil((size * feePerKb) / 1000));
    minFee = Math.max(1, Math.ceil((size * minFeePerKb) / 1000));

    const change = totalInput - opts.amount - targetFee;
    if (change >= dust) {
      return { inputs: selected, fee: targetFee, change, totalInput };
    }
    if (change >= 0) {
      // The leftover would be an unspendable dust output: donate it to the fee.
      return { inputs: selected, fee: totalInput - opts.amount, change: 0, totalInput };
    }

    // Short of the target fee, but the whole remainder can go to the fee if the
    // effective rate still meets the minimum relay fee (small balances).
    const effectiveFee = totalInput - opts.amount;
    if (effectiveFee >= minFee) {
      return { inputs: selected, fee: effectiveFee, change: 0, totalInput };
    }
  }

  throw new Error(
    `Insufficient funds: available ${totalInput} sats, need ${opts.amount} sats plus at least ${minFee} sats of fee`
  );
}
