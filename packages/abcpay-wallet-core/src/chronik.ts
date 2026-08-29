import { ChronikClient } from 'chronik-client';
import type { SupportedChain, SupportedCoin, TxHistoryItem } from '@bcpros/abcpay-models';
import { decodeAddress, scriptPubKeyHexFromAddress } from './address';

export interface ChronikConfig {
  xecUrls: string[];
  dogeUrls: string[];
}

export const DEFAULT_CHRONIK: ChronikConfig = {
  xecUrls: [
    'https://chronik.e.cash',
    'https://xec.paybutton.org',
    'https://chronik.pay2stay.com/xec'
  ],
  dogeUrls: ['https://chronik.pay2stay.com/doge', 'https://chronik.everdoge.me/doge']
};

const clients = new Map<SupportedChain, ChronikClient>();

export function getChronikClient(chain: SupportedChain, config: ChronikConfig = DEFAULT_CHRONIK): ChronikClient {
  const existing = clients.get(chain);
  if (existing) return existing;

  const urls = chain === 'XEC' ? config.xecUrls : config.dogeUrls;
  const client = new ChronikClient(urls);
  clients.set(chain, client);
  return client;
}

export function chainFromCoin(coin: SupportedCoin): SupportedChain {
  return coin === 'xec' ? 'XEC' : 'DOGE';
}

export interface ScriptUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  confirmations: number;
  scriptPubKey?: string;
}

function scriptEndpoint(chain: SupportedChain, address: string, config?: ChronikConfig) {
  const coin: SupportedCoin = chain === 'XEC' ? 'xec' : 'doge';
  const decoded = decodeAddress(coin, address);
  return getChronikClient(chain, config).script(decoded.type, decoded.hashHex);
}

export async function getUtxosForAddress(
  chain: SupportedChain,
  address: string,
  config?: ChronikConfig
): Promise<ScriptUtxo[]> {
  const utxos = await scriptEndpoint(chain, address, config).utxos();
  const coin: SupportedCoin = chain === 'XEC' ? 'xec' : 'doge';
  const scriptPubKey = scriptPubKeyHexFromAddress(coin, address);

  return utxos.utxos.map(utxo => ({
    txid: utxo.outpoint.txid,
    vout: utxo.outpoint.outIdx,
    satoshis: Number(utxo.sats),
    address,
    confirmations: utxo.blockHeight > 0 ? 1 : 0,
    scriptPubKey
  }));
}

export async function getBalanceForAddress(
  chain: SupportedChain,
  address: string,
  config?: ChronikConfig
): Promise<number> {
  const utxos = await getUtxosForAddress(chain, address, config);
  return utxos.reduce((sum, u) => sum + u.satoshis, 0);
}

export async function broadcastTx(
  chain: SupportedChain,
  rawTxHex: string,
  config?: ChronikConfig
): Promise<string> {
  const chronik = getChronikClient(chain, config);
  const result = await chronik.broadcastTx(rawTxHex);
  return result.txid;
}

export async function getTxHistoryForAddress(
  chain: SupportedChain,
  address: string,
  config?: ChronikConfig
): Promise<TxHistoryItem[]> {
  const history = await scriptEndpoint(chain, address, config).history(0, 50);
  const coin: SupportedCoin = chain === 'XEC' ? 'xec' : 'doge';
  const scriptHex = scriptPubKeyHexFromAddress(coin, address).toLowerCase();

  return history.txs.map(tx => {
    const received = tx.outputs.reduce(
      (sum, out) => sum + (out.outputScript.toLowerCase() === scriptHex ? Number(out.sats) : 0),
      0
    );
    const spent = tx.inputs.reduce(
      (sum, input) => sum + ((input.outputScript ?? '').toLowerCase() === scriptHex ? Number(input.sats) : 0),
      0
    );
    const inputSum = tx.inputs.reduce((sum, input) => sum + Number(input.sats), 0);
    const outputSum = tx.outputs.reduce((sum, out) => sum + Number(out.sats), 0);
    const net = received - spent;
    return {
      txid: tx.txid,
      action: net >= 0 ? 'received' : 'sent',
      amount: Math.abs(net),
      fees: Math.max(0, inputSum - outputSum),
      time: tx.block?.timestamp ? Number(tx.block.timestamp) : Number(tx.timeFirstSeen || Date.now()),
      confirmations: tx.block ? 1 : 0,
      blockheight: tx.block?.height,
      address
    } satisfies TxHistoryItem;
  });
}

export async function getFeeEstimate(chain: SupportedChain): Promise<number> {
  if (chain === 'XEC') return 2000;
  return 100_000_000;
}
