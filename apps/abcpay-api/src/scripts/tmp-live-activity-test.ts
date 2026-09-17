import { appendFileSync, readFileSync } from 'node:fs';
import {
  assembleTxHex,
  mergeCopayerSignatures,
  signRequest,
  signTxInputs,
  unsignedTxFromProposal,
  type UnsignedTx
} from '@bcpros/abcpay-wallet-core';

const BASE = process.env.CWS_URL ?? 'http://192.168.31.149:3232/cws/api';
const LOG = 'C:/Users/ncao/AppData/Local/Temp/opencode/live-activity.log';
const walletFile = JSON.parse(
  readFileSync('C:/Users/ncao/AppData/Local/Temp/opencode/dryrun-wallets.json', 'utf8')
) as Record<string, any>;

function log(line: string) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG, stamped + '\n');
  } catch {
    // ignore
  }
}

interface Auth {
  walletId: string;
  copayerId: string;
  requestPrivKey: string;
}

function authOf(entry: any): Auth {
  return { walletId: entry.walletId, copayerId: entry.copayerId, requestPrivKey: entry.requestPrivKey };
}

async function call(
  method: string,
  path: string,
  auth?: Auth,
  body?: unknown,
  timeoutMs = 30000
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    headers['x-wallet-id'] = auth.walletId;
    headers['x-identity'] = auth.copayerId;
    headers['x-copayer-id'] = auth.copayerId;
    headers['x-signature'] = signRequest(auth.requestPrivKey, method, path, body === undefined ? '{}' : JSON.stringify(body));
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const openStreams: Array<() => void> = [];

function openSse(path: string, auth: Auth, label: string) {
  const controller = new AbortController();
  openStreams.push(() => controller.abort());
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'x-wallet-id': auth.walletId,
    'x-identity': auth.copayerId,
    'x-copayer-id': auth.copayerId,
    'x-signature': signRequest(auth.requestPrivKey, 'GET', path, '{}')
  };
  void (async () => {
    const res = await fetch(BASE + path, { headers, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`${label}: sse status ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length === 0) continue;
        const payload = JSON.parse(data.join('\n'));
        if (event === 'ready') {
          log(`[${label}] ready watching=${payload.watching} chain=${payload.chain}`);
        } else {
          log(`[${label}] EVENT ${event} direction=${payload.direction} msgType=${payload.msgType} txid=${payload.txid}`);
        }
      }
    }
  })().catch(err => {
    if (controller.signal.aborted) return;
    log(`[${label}] stream error: ${err.message}`);
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function broadcastProposal(source: Auth, sourceEntry: any, txp: any) {
  const unsigned: UnsignedTx = unsignedTxFromProposal({
    coin: 'xec',
    inputs: txp.inputs,
    outputs: txp.outputs,
    amount: txp.amount,
    fee: txp.fee,
    changeAddress: txp.changeAddress
  });
  const signatures = signTxInputs(unsigned, sourceEntry.xPrivKey);
  const signed = await call('POST', `/v1/txproposals/${txp.id}/signatures/`, source, { signatures });
  log(`sign status=${signed.status}`);
  const merged = mergeCopayerSignatures({
    tx: unsigned,
    copayers: [{ copayerId: source.copayerId, xPubKey: sourceEntry.xPubKey }],
    signatures: signed.json.signatures
  });
  const raw = assembleTxHex(unsigned, merged);
  log(`broadcasting ${txp.id} raw=${raw.length / 2} bytes...`);
  try {
    const broadcast = await call('POST', `/v1/txproposals/${txp.id}/broadcast/`, source, { raw }, 60000);
    log(`broadcast status=${broadcast.status} body=${JSON.stringify(broadcast.json).slice(0, 300)}`);
  } catch (err) {
    log(`broadcast call failed: ${(err as Error).message}`);
  }
}

async function main() {
  const sourceEntry = walletFile.source;
  const destEntry = walletFile.destination;
  const source = authOf(sourceEntry);
  const destination = authOf(destEntry);

  const balances = await call('GET', '/v1/balance/', source);
  const dst = await call('GET', '/v1/balance/', destination);
  log(`source balance=${balances.json.totalAmount} sats, destination balance=${dst.json.totalAmount} sats`);

  const proposals = await call('GET', '/v1/txproposals/', source);
  const reusable = (proposals.json as any[]).find(p => !p.txid && (p.status === 'accepted' || p.status === 'pending'));
  log(`open proposals: ${(proposals.json as any[]).map(p => `${p.id.slice(0, 8)}:${p.status}`).join(', ') || 'none'}`);

  openSse('/v1/notifications/', source, 'source');
  openSse('/v1/notifications/', destination, 'destination');
  await sleep(2500);

  if (reusable) {
    log(`reusing proposal ${reusable.id} (${reusable.status})`);
    await broadcastProposal(source, sourceEntry, reusable);
  } else {
    const created = await call('POST', '/v3/txproposals/', source, {
      proposals: [{ outputs: [{ toAddress: destEntry.address, amount: 1000 }], message: 'chain watcher live test' }]
    });
    if (created.status !== 201) {
      log(`proposal create failed: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
      return;
    }
    log(`created proposal ${created.json.id} amount=${created.json.amount} fee=${created.json.fee}`);
    await broadcastProposal(source, sourceEntry, created.json);
  }

  log('waiting up to 40s for pushed wallet.activity events...');
  await sleep(40000);
}

const watchdog = setTimeout(() => {
  log('watchdog: forcing exit');
  for (const close of openStreams) close();
  process.exit(2);
}, 120000);

main()
  .catch(err => log(`live activity test failed: ${err.message}`))
  .finally(() => {
    clearTimeout(watchdog);
    for (const close of openStreams) close();
    log('done');
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
