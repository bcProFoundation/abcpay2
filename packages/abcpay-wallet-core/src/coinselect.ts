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

export interface MaxSendResult {
  inputs: SelectableUtxo[];
  amount: number;
  fee: number;
  totalInput: number;
}

export function computeMaxSend(opts: {
  coin: SupportedCoin;
  utxos: SelectableUtxo[];
  feePerKb?: number;
  m?: number;
  n?: number;
  outputCount?: number;
}): MaxSendResult {
  const feePerKb = Math.max(minRelayFeePerKb(opts.coin), opts.feePerKb ?? defaultFeePerKb(opts.coin));
  const dust = dustThreshold(opts.coin);
  const outputCount = opts.outputCount ?? 1;
  const candidates = opts.utxos.filter(isSpendableUtxo).sort((a, b) => b.satoshis - a.satoshis);
  if (candidates.length === 0) {
    throw new Error('No spendable balance: all funds are locked or token-bearing');
  }

  // Fee grows with the input count, so including a small input can reduce the
  // amount actually sent. The optimum is a prefix of the descending list.
  let best: MaxSendResult | undefined;
  let totalInput = 0;
  for (let count = 1; count <= candidates.length; count++) {
    totalInput += candidates[count - 1].satoshis;
    const size = estimateTxSize(count, outputCount, opts.n ?? 1, opts.m ?? 1);
    const fee = Math.max(1, Math.ceil((size * feePerKb) / 1000));
    const amount = totalInput - fee;
    if (!best || amount > best.amount) {
      best = { inputs: candidates.slice(0, count), amount, fee, totalInput };
    }
  }

  if (!best || best.amount < dust) {
    throw new Error(
      `Cannot send max: best amount ${best?.amount ?? 0} sats is below the dust limit after fees`
    );
  }

  return best;
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
  const feePerKb = Math.max(minRelayFeePerKb(opts.coin), opts.feePerKb ?? defaultFeePerKb(opts.coin));
  const minFeePerKb = minRelayFeePerKb(opts.coin);
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
