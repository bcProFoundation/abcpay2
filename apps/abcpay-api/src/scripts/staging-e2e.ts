import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleTxHex,
  createCredentials,
  deriveWalletAddress,
  mergeCopayerSignatures,
  signRequest,
  signTxInputs,
  unsignedTxFromProposal,
  type UnsignedTx,
  type WalletCredentials
} from '@bcpros/abcpay-wallet-core';

const BASE = process.env.CWS_URL ?? process.env.BWS_URL ?? 'http://127.0.0.1:3232/cws/api';
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    process.env.FIXTURE ??
      join(here, '../../../../packages/abcpay-wallet-core/src/__tests__/fixtures/legacy-parity.json'),
    'utf8'
  )
);

const seeds = [
  { id: 'f0000001-0000-4000-8000-000000000001', fixtureId: 'xec-899-1of1', coinType: 899, receiveIndex: 2 },
  { id: 'f0000002-0000-4000-8000-000000000002', fixtureId: 'xec-1899-1of1', coinType: 1899, receiveIndex: 0 },
  { id: 'f0000003-0000-4000-8000-000000000003', fixtureId: 'doge-3-1of1', coinType: 3, receiveIndex: 0 },
  { id: 'f0000004-0000-4000-8000-000000000004', fixtureId: 'xec-899-2of2', coinType: 899, receiveIndex: 0 }
];

function normalize(coin: string, address: string): string {
  return coin === 'xec'
    ? address.toLowerCase().replace(/^ecash:/, '').replace(/^bitcoincash:/, '')
    : address;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; creds?: WalletCredentials; walletId?: string; identity?: string } = {}
): Promise<{ status: number; json: any }> {
  const { body, creds, walletId, identity } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (walletId) headers['x-wallet-id'] = walletId;
  if (identity) {
    headers['x-identity'] = identity;
    headers['x-copayer-id'] = identity;
  }
  if (creds && identity) {
    headers['x-signature'] = signRequest(
      creds.requestPrivKey,
      method,
      path,
      body === undefined ? '{}' : JSON.stringify(body)
    );
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
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

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

interface SseEvent {
  type: string;
  [key: string]: unknown;
}

interface SseClient {
  events: SseEvent[];
  waitFor: (predicate: (event: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent | null>;
  close: () => void;
}

async function openSse(
  path: string,
  opts: { creds: WalletCredentials; walletId: string; identity: string }
): Promise<SseClient> {
  const controller = new AbortController();
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'x-wallet-id': opts.walletId,
    'x-identity': opts.identity,
    'x-copayer-id': opts.identity,
    'x-signature': signRequest(opts.creds.requestPrivKey, 'GET', path, '{}')
  };

  const res = await fetch(BASE + path, { headers, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`SSE handshake failed with status ${res.status}`);

  const events: SseEvent[] = [];
  const waiters: Array<{
    id: number;
    predicate: (event: SseEvent) => boolean;
    resolve: (event: SseEvent | null) => void;
  }> = [];
  let nextWaiterId = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);

          let eventName = 'message';
          const dataLines: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;

          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLines.join('\n'));
          } catch {
            continue;
          }
          const event: SseEvent = { ...payload, type: eventName };
          events.push(event);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(event)) {
              waiters[i].resolve(event);
              waiters.splice(i, 1);
            }
          }
        }
      }
    } catch {
      // aborted by close()
    }
  })();

  return {
    events,
    waitFor: (predicate, timeoutMs = 8000) =>
      new Promise<SseEvent | null>(resolve => {
        const existing = events.find(predicate);
        if (existing) return resolve(existing);

        const id = ++nextWaiterId;
        const timer = setTimeout(() => {
          const index = waiters.findIndex(waiter => waiter.id === id);
          if (index >= 0) waiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);

        waiters.push({
          id,
          predicate,
          resolve: event => {
            clearTimeout(timer);
            resolve(event);
          }
        });
      }),
    close: () => controller.abort()
  };
}

function fixtureWallet(id: string) {
  const wallet = fixture.wallets.find((w: any) => w.id === id);
  if (!wallet) throw new Error(`fixture wallet ${id} not found`);
  return wallet;
}

async function main() {
  for (const seed of seeds) {
    const wallet = fixtureWallet(seed.fixtureId);
    const isMultisig = wallet.n > 1;
    const credsA = createCredentials({
      coin: wallet.coin,
      mnemonic: wallet.copayers[0].mnemonic,
      isMultisig,
      usePurpose48: isMultisig,
      coinType: seed.coinType
    });
    check(
      `${seed.fixtureId}: credentials match legacy fixture`,
      credsA.xPubKey === wallet.copayers[0].xPubKey && credsA.copayerId === wallet.copayers[0].copayerId
    );

    const info = await call('GET', `/v1/wallets/${seed.id}/join-info/`);
    check(
      `${seed.fixtureId}: join-info carries coinType`,
      info.status === 200 && info.json.coinType === seed.coinType,
      `coinType=${info.json?.coinType}`
    );

    const probe = await call('POST', `/v2/wallets/${seed.id}/copayers`, {
      body: {
        walletId: seed.id,
        coin: wallet.coin,
        name: 'probe',
        xPubKey: credsA.xPubKey,
        requestPubKey: credsA.requestPubKey,
        dryRun: true
      }
    });
    check(
      `${seed.fixtureId}: dry-run probe finds the copayer`,
      probe.status === 200 && probe.json.copayerExists === true,
      JSON.stringify(probe.json)
    );

    const w = await call('GET', '/v3/wallets/?includeExtendedInfo=1&serverMessageArray=1', {
      creds: credsA,
      walletId: seed.id,
      identity: credsA.copayerId
    });
    check(
      `${seed.fixtureId}: authenticated getWallet (GET with query)`,
      w.status === 200 && w.json?.wallet?.id === seed.id,
      `status=${w.status}`
    );

    const expected = deriveWalletAddress({
      coin: wallet.coin,
      xPubKeys: wallet.copayers.map((c: any) => c.xPubKey),
      m: wallet.m,
      n: wallet.n,
      path: `m/0/${seed.receiveIndex}`
    });
    const addr1 = await call('POST', '/v4/addresses/', {
      body: { isChange: false },
      creds: credsA,
      walletId: seed.id,
      identity: credsA.copayerId
    });
    check(
      `${seed.fixtureId}: address continuity m/0/${seed.receiveIndex}`,
      addr1.status === 201 &&
        addr1.json.path === `m/0/${seed.receiveIndex}` &&
        normalize(wallet.coin, addr1.json.address) === normalize(wallet.coin, expected.address),
      `path=${addr1.json?.path}`
    );
    const addr2 = await call('POST', '/v4/addresses/', {
      body: { isChange: false },
      creds: credsA,
      walletId: seed.id,
      identity: credsA.copayerId
    });
    check(
      `${seed.fixtureId}: next address m/0/${seed.receiveIndex + 1}`,
      addr2.status === 201 && addr2.json.path === `m/0/${seed.receiveIndex + 1}`
    );

    const balance = await call('GET', '/v1/balance/', {
      creds: credsA,
      walletId: seed.id,
      identity: credsA.copayerId
    });
    check(
      `${seed.fixtureId}: balance via Chronik`,
      balance.status === 200 && typeof balance.json.totalAmount === 'number',
      `total=${balance.json?.totalAmount} tokens=${balance.json?.tokens?.length ?? 0}`
    );
    const utxos = await call('GET', '/v1/utxos/', {
      creds: credsA,
      walletId: seed.id,
      identity: credsA.copayerId
    });
    check(`${seed.fixtureId}: utxos via Chronik`, utxos.status === 200 && Array.isArray(utxos.json));
    const history = await call('GET', '/v1/txhistory/', {
      creds: credsA,
      walletId: seed.id,
      identity: credsA.copayerId
    });
    check(`${seed.fixtureId}: history via Chronik`, history.status === 200 && Array.isArray(history.json));
  }

  {
    const wallet = fixtureWallet('xec-899-1of1');
    const creds = createCredentials({ coin: 'xec', mnemonic: wallet.copayers[0].mnemonic, coinType: 899 });
    const res = await call('GET', '/v1/balance/', {
      creds,
      walletId: 'f0000002-0000-4000-8000-000000000002',
      identity: creds.copayerId
    });
    check('authz: mismatched x-wallet-id rejected', res.status === 403, `status=${res.status}`);
  }

  {
    const seed = seeds[3];
    const wallet = fixtureWallet(seed.fixtureId);
    const ca = createCredentials({
      coin: 'xec',
      mnemonic: wallet.copayers[0].mnemonic,
      isMultisig: true,
      usePurpose48: true,
      coinType: seed.coinType
    });
    const cb = createCredentials({
      coin: 'xec',
      mnemonic: wallet.copayers[1].mnemonic,
      isMultisig: true,
      usePurpose48: true,
      coinType: seed.coinType
    });
    const source = wallet.addresses.find((a: any) => a.path === 'm/0/0');
    const dest = fixtureWallet('xec-899-1of1').addresses.find((a: any) => a.path === 'm/0/1');

    const sse = await openSse('/v1/notifications/', { creds: cb, walletId: seed.id, identity: cb.copayerId });
    const ready = await sse.waitFor(event => event.type === 'ready');
    check('sse: stream ready for wallet', ready !== null, ready ? 'ready event received' : 'no ready event');

    const created = await call('POST', '/v3/txproposals/', {
      body: {
        proposals: [
          {
            outputs: [{ toAddress: dest.address, amount: 90000 }],
            message: 'staging e2e',
            inputs: [
              {
                txid: '11'.repeat(32),
                vout: 0,
                satoshis: 100000,
                address: source.address,
                path: source.path,
                publicKeys: source.publicKeys
              }
            ]
          }
        ]
      },
      creds: ca,
      walletId: seed.id,
      identity: ca.copayerId
    });
    check(
      'multisig: proposal created (client inputs)',
      created.status === 201 && created.json.status === 'pending',
      `status=${created.status} txp=${created.json?.id}`
    );
    const txp = created.json;
    const createdEvent = await sse.waitFor(event => event.type === 'proposal.created' && event.proposalId === txp.id);
    check(
      'sse: proposal.created delivered to the other copayer',
      createdEvent !== null,
      createdEvent ? `proposalId=${createdEvent.proposalId}` : 'event not delivered'
    );
    const unsigned: UnsignedTx = unsignedTxFromProposal({
      coin: 'xec',
      inputs: txp.inputs,
      outputs: txp.outputs,
      amount: txp.amount,
      fee: txp.fee,
      changeAddress: txp.changeAddress
    });

    const sigA = await call('POST', `/v1/txproposals/${txp.id}/signatures/`, {
      body: { signatures: signTxInputs(unsigned, ca.xPrivKey) },
      creds: ca,
      walletId: seed.id,
      identity: ca.copayerId
    });
    check('multisig: copayer A signature accepted', sigA.status === 200 && sigA.json.status === 'pending');
    const signedEvent = await sse.waitFor(
      event => event.type === 'proposal.signed' && event.copayerId === ca.copayerId
    );
    check(
      'sse: proposal.signed delivered when the other copayer signs',
      signedEvent !== null && signedEvent.status === 'pending',
      signedEvent ? `status=${signedEvent.status}` : 'event not delivered'
    );

    const sigB = await call('POST', `/v1/txproposals/${txp.id}/signatures/`, {
      body: { signatures: signTxInputs(unsigned, cb.xPrivKey) },
      creds: cb,
      walletId: seed.id,
      identity: cb.copayerId
    });
    check(
      'multisig: proposal accepted at m=2',
      sigB.status === 200 && sigB.json.status === 'accepted',
      `status=${sigB.json?.status} sigs=${Object.keys(sigB.json?.signatures ?? {}).length}`
    );

    const merged = mergeCopayerSignatures({
      tx: unsigned,
      copayers: wallet.copayers.map((c: any) => ({ copayerId: c.copayerId, xPubKey: c.xPubKey })),
      signatures: sigB.json.signatures
    });
    const raw = assembleTxHex(unsigned, merged);
    check('multisig: assembled transaction', raw.length > 200, `bytes=${raw.length / 2}`);

    const bcast = await call('POST', `/v1/txproposals/${txp.id}/broadcast/`, {
      body: { raw },
      creds: ca,
      walletId: seed.id,
      identity: ca.copayerId
    });
    check(
      'multisig: fabricated UTXO broadcast rejected by Chronik (expected)',
      bcast.status === 400,
      `status=${bcast.status} message=${String(bcast.json?.message).slice(0, 90)}`
    );

    const rejectedEvent = await sse.waitFor(event => event.type === 'proposal.rejected' && event.proposalId === txp.id);
    check(
      'sse: proposal.rejected delivered on broadcast failure',
      rejectedEvent !== null,
      rejectedEvent ? `message=${String(rejectedEvent.message).slice(0, 60)}` : 'event not delivered'
    );
    sse.close();
  }

  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
  console.error('e2e failed:', err);
  process.exitCode = 1;
});
