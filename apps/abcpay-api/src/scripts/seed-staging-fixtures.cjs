#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const postgres = require('postgres');

const fixturePath =
  process.env.FIXTURE ||
  path.join(__dirname, '../../../../packages/abcpay-wallet-core/src/__tests__/fixtures/legacy-parity.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const seeds = [
  { id: 'f0000001-0000-4000-8000-000000000001', fixtureId: 'xec-899-1of1', coinType: 899, receiveIndex: 2, changeIndex: 1 },
  { id: 'f0000002-0000-4000-8000-000000000002', fixtureId: 'xec-1899-1of1', coinType: 1899, receiveIndex: 0, changeIndex: 0 },
  { id: 'f0000003-0000-4000-8000-000000000003', fixtureId: 'doge-3-1of1', coinType: 3, receiveIndex: 0, changeIndex: 0 },
  { id: 'f0000004-0000-4000-8000-000000000004', fixtureId: 'xec-899-2of2', coinType: 899, receiveIndex: 0, changeIndex: 0 }
];

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const sql = postgres(url, { max: 2 });

  for (const seed of seeds) {
    const wallet = fixture.wallets.find(w => w.id === seed.fixtureId);
    if (!wallet) throw new Error(`fixture wallet ${seed.fixtureId} not found`);
    const ring = wallet.copayers.map(c => ({ xPubKey: c.xPubKey, requestPubKey: c.requestPubKey }));

    await sql`delete from addresses where wallet_id = ${seed.id}`;
    await sql`delete from tx_proposals where wallet_id = ${seed.id}`;
    await sql`delete from copayer_lookup where wallet_id = ${seed.id}`;
    await sql`delete from copayers where wallet_id = ${seed.id}`;
    await sql`delete from wallets where wallet_id = ${seed.id}`;

    await sql`
      insert into wallets (
        wallet_id, name, m, n, coin, chain, network, address_type, coin_type, status,
        pub_key, public_key_ring, single_address, native_cash_addr, use_purpose48,
        address_index, change_address_index
      ) values (
        ${seed.id}, ${`Staging ${seed.fixtureId}`}, ${wallet.m}, ${wallet.n}, ${wallet.coin},
        ${wallet.coin}, 'livenet', ${wallet.addressType}, ${seed.coinType}, 'complete',
        '', ${sql.json(ring)}, false, true, ${wallet.n > 1}, ${seed.receiveIndex}, ${seed.changeIndex}
      )
    `;

    for (const copayer of wallet.copayers) {
      await sql`
        insert into copayers (copayer_id, wallet_id, name, x_pub_key, request_pub_key)
        values (${copayer.copayerId}, ${seed.id}, ${`Copayer ${copayer.label}`}, ${copayer.xPubKey}, ${copayer.requestPubKey})
      `;
      await sql`
        insert into copayer_lookup (copayer_id, wallet_id) values (${copayer.copayerId}, ${seed.id})
      `;
    }
    console.log(
      `seeded ${seed.fixtureId} -> ${seed.id} (coinType=${seed.coinType}, copayers=${wallet.copayers.length}, receiveIndex=${seed.receiveIndex})`
    );
  }
  await sql.end();
  console.log('staging fixtures ready');
})().catch(err => {
  console.error('seed failed:', err.message);
  process.exitCode = 1;
});
