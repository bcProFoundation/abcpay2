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

export interface ScriptToken {
  tokenId: string;
  tokenType?: number;
  atoms: string;
  isMintBaton: boolean;
}

export interface ScriptUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  address: string;
  confirmations: number;
  scriptPubKey?: string;
  token?: ScriptToken;
}

export interface TokenBalance {
  tokenId: string;
  tokenType?: number;
  atoms: string;
  isMintBaton: boolean;
}

export interface AddressBalances {
  spendableSatoshis: number;
  tokenSatoshis: number;
  tokens: TokenBalance[];
}

function tokenTypeNumber(tokenType: { number?: number } | number | null | undefined): number | undefined {
  if (typeof tokenType === 'number') return tokenType;
  return tokenType?.number;
}

function mapToken(token:
  | { tokenId: string; tokenType?: { number?: number } | number | null; atoms: bigint; isMintBaton: boolean }
  | undefined): ScriptToken | undefined {
  if (!token) return undefined;
  return {
    tokenId: token.tokenId,
    tokenType: tokenTypeNumber(token.tokenType),
    atoms: token.atoms.toString(),
    isMintBaton: Boolean(token.isMintBaton)
  };
}

export function summarizeUtxos(utxos: ScriptUtxo[]): AddressBalances {
  let spendableSatoshis = 0;
  let tokenSatoshis = 0;
  const tokens = new Map<string, TokenBalance>();
  for (const utxo of utxos) {
    if (utxo.token) {
      tokenSatoshis += utxo.satoshis;
      const existing = tokens.get(utxo.token.tokenId);
      if (existing) {
        existing.atoms = (BigInt(existing.atoms) + BigInt(utxo.token.atoms)).toString();
        existing.isMintBaton = existing.isMintBaton || utxo.token.isMintBaton;
      } else {
        tokens.set(utxo.token.tokenId, {
          tokenId: utxo.token.tokenId,
          tokenType: utxo.token.tokenType,
          atoms: utxo.token.atoms,
          isMintBaton: utxo.token.isMintBaton
        });
      }
    } else {
      spendableSatoshis += utxo.satoshis;
    }
  }
  return { spendableSatoshis, tokenSatoshis, tokens: [...tokens.values()] };
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
    scriptPubKey,
    token: mapToken(utxo.token)
  }));
}

export async function getBalancesForAddress(
  chain: SupportedChain,
  address: string,
  config?: ChronikConfig
): Promise<AddressBalances> {
  const utxos = await getUtxosForAddress(chain, address, config);
  return summarizeUtxos(utxos);
}

export async function getBalanceForAddress(
  chain: SupportedChain,
  address: string,
  config?: ChronikConfig
): Promise<number> {
  const balances = await getBalancesForAddress(chain, address, config);
  return balances.spendableSatoshis;
}

export interface TokenMetadata {
  tokenId: string;
  tokenType?: number;
  ticker?: string;
  name?: string;
  decimals?: number;
}

const TOKEN_CACHE_TTL_MS = 10 * 60 * 1000;
const tokenCache = new Map<string, { value: TokenMetadata; expires: number }>();

export async function getTokenMetadata(
  chain: SupportedChain,
  tokenId: string,
  config?: ChronikConfig
): Promise<TokenMetadata> {
  const cacheKey = `${chain}:${tokenId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const fallback: TokenMetadata = { tokenId };
  try {
    const info = await getChronikClient(chain, config).token(tokenId);
    const value: TokenMetadata = {
      tokenId: info.tokenId,
      tokenType: tokenTypeNumber(info.tokenType),
      ticker: info.genesisInfo?.tokenTicker || undefined,
      name: info.genesisInfo?.tokenName || undefined,
      decimals: Number.isFinite(info.genesisInfo?.decimals) ? info.genesisInfo.decimals : undefined
    };
    tokenCache.set(cacheKey, { value, expires: Date.now() + TOKEN_CACHE_TTL_MS });
    return value;
  } catch {
    tokenCache.set(cacheKey, { value: fallback, expires: Date.now() + TOKEN_CACHE_TTL_MS });
    return fallback;
  }
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
