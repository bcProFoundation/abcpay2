import { writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import postgres from 'postgres';
import { deriveWalletAddress } from '@bcpros/abcpay-wallet-core';
import {
  addressScriptKey,
  mapLegacyCopayer,
  mapLegacyWallet,
  nextAddressIndex,
  publicKeyRingFromCopayers,
  type LegacyAddress,
  type LegacyWallet,
  type MappedCopayer
} from './legacy-map';

interface ImportOptions {
  apply: boolean;
  yes: boolean;
  reportPath: string;
  addressAuditCount: number;
  walletId?: string;
}

interface ImportReport {
  mode: 'dry-run' | 'apply';
  startedAt: string;
  finishedAt?: string;
  source: { mongo: string; postgres: string };
  totals: {
    walletsSeen: number;
    imported: number;
    alreadyImported: number;
    skipped: number;
    failed: number;
  };
  byCoinType: Record<string, number>;
  skipped: Array<{ walletId?: string; reason: string }>;
  copayerChecks: Array<{ walletId: string; copayerId: string; derivedCopayerId: string; matches: boolean }>;
  copayerSkips: Array<{ walletId: string; reason: string }>;
  addressAudit: {
    checked: number;
    mismatches: Array<{ walletId: string; path: string; derived: string; legacy: string }>;
  };
  errors: Array<{ walletId?: string; message: string }>;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: string[]): ImportOptions {
  const opts: ImportOptions = {
    apply: false,
    yes: false,
    reportPath: 'import-report.json',
    addressAuditCount: 5
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--report') opts.reportPath = takeValue(argv, ++i, '--report');
    else if (arg === '--address-audit') {
      const count = Number(takeValue(argv, ++i, '--address-audit'));
      if (!Number.isInteger(count) || count < 0) {
        throw new Error('--address-audit requires a non-negative integer');
      }
      opts.addressAuditCount = count;
    } else if (arg === '--wallet') opts.walletId = takeValue(argv, ++i, '--wallet');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.apply && !opts.yes) {
    throw new Error('Refusing to write without --yes. Re-run with --apply --yes against the intended database.');
  }
  return opts;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(invalid url)';
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mongoUrl = process.env.LEGACY_MONGO_URL;
  const pgUrl = process.env.DATABASE_URL;
  if (!mongoUrl) throw new Error('LEGACY_MONGO_URL is required');
  if (!pgUrl) throw new Error('DATABASE_URL is required');

  const report: ImportReport = {
    mode: opts.apply ? 'apply' : 'dry-run',
    startedAt: new Date().toISOString(),
    source: { mongo: redactUrl(mongoUrl), postgres: redactUrl(pgUrl) },
    totals: { walletsSeen: 0, imported: 0, alreadyImported: 0, skipped: 0, failed: 0 },
    byCoinType: {},
    skipped: [],
    copayerChecks: [],
    copayerSkips: [],
    addressAudit: { checked: 0, mismatches: [] },
    errors: []
  };

  const mongo = new MongoClient(mongoUrl);
  const sql = postgres(pgUrl, { max: 4 });
  console.log(`[${report.mode}] mongo ${report.source.mongo} -> postgres ${report.source.postgres}`);

  try {
    await mongo.connect();
    const db = mongo.db(process.env.LEGACY_MONGO_DB ?? 'bitcore-wallet-service');
    const filter: Record<string, unknown> = { coin: { $in: ['xec', 'doge'] } };
    if (opts.walletId) filter.id = opts.walletId;

    const wallets = await db.collection<LegacyWallet>('wallets').find(filter).sort({ createdOn: 1 }).toArray();
    report.totals.walletsSeen = wallets.length;

    for (const legacyWallet of wallets) {
      try {
        const mapped = mapLegacyWallet(legacyWallet);
        if ('skip' in mapped) {
          report.totals.skipped++;
          report.skipped.push({ walletId: legacyWallet.id, reason: mapped.reason });
          continue;
        }

        const copayers: MappedCopayer[] = [];
        for (const legacyCopayer of legacyWallet.copayers ?? []) {
          const copayer = mapLegacyCopayer(mapped.walletId, mapped.coin, legacyCopayer);
          if ('skip' in copayer) {
            report.copayerSkips.push({ walletId: mapped.walletId, reason: copayer.reason });
            continue;
          }
          copayers.push(copayer);
          report.copayerChecks.push({
            walletId: mapped.walletId,
            copayerId: copayer.copayerId,
            derivedCopayerId: copayer.derivedCopayerId,
            matches: copayer.copayerId === copayer.derivedCopayerId
          });
        }

        const key = `${mapped.coin}:${mapped.coinType}`;
        report.byCoinType[key] = (report.byCoinType[key] ?? 0) + 1;

        const [existing] = await sql`SELECT wallet_id FROM wallets WHERE wallet_id = ${mapped.walletId}`;
        if (existing) {
          report.totals.alreadyImported++;
          continue;
        }

        const legacyAddresses = await db
          .collection<LegacyAddress>('addresses')
          .find({ walletId: mapped.walletId })
          .sort({ createdOn: 1 })
          .toArray();

        const receiveIndex = nextAddressIndex(legacyAddresses, false);
        const changeIndex = nextAddressIndex(legacyAddresses, true);
        const publicKeyRing = publicKeyRingFromCopayers(copayers);

        if (opts.apply) {
          await sql`
            INSERT INTO wallets (
              wallet_id, name, m, n, coin, chain, network, address_type, coin_type, status,
              pub_key, public_key_ring, single_address, native_cash_addr, use_purpose48,
              address_index, change_address_index
            ) VALUES (
              ${mapped.walletId}, ${mapped.name}, ${mapped.m}, ${mapped.n}, ${mapped.coin}, ${mapped.chain},
              ${mapped.network}, ${mapped.addressType}, ${mapped.coinType}, ${mapped.status}, ${mapped.pubKey},
              ${sql.json(publicKeyRing)}, ${mapped.singleAddress}, ${mapped.nativeCashAddr},
              ${mapped.usePurpose48}, ${receiveIndex}, ${changeIndex}
            )
            ON CONFLICT (wallet_id) DO NOTHING
          `;

          for (const copayer of copayers) {
            await sql`
              INSERT INTO copayers (
                copayer_id, wallet_id, name, x_pub_key, request_pub_key, signature, custom_data
              ) VALUES (
                ${copayer.copayerId}, ${copayer.walletId}, ${copayer.name}, ${copayer.xPubKey},
                ${copayer.requestPubKey}, ${copayer.signature ?? null}, ${copayer.customData ?? null}
              )
              ON CONFLICT (copayer_id) DO NOTHING
            `;
            await sql`
              INSERT INTO copayer_lookup (copayer_id, wallet_id)
              VALUES (${copayer.copayerId}, ${copayer.walletId})
              ON CONFLICT (copayer_id) DO NOTHING
            `;
          }
          report.totals.imported++;
        }

        if (publicKeyRing.length > 0) {
          const audited: LegacyAddress[] = [];
          for (const change of [false, true]) {
            audited.push(
              ...legacyAddresses
                .filter(a => Boolean(a.isChange) === change)
                .slice(0, opts.addressAuditCount)
            );
          }
          for (const legacyAddress of audited) {
            if (!legacyAddress.path || !legacyAddress.address) continue;
            const derived = deriveWalletAddress({
              coin: mapped.coin,
              network: mapped.network as 'livenet' | 'testnet',
              xPubKeys: publicKeyRing.map(k => k.xPubKey),
              m: mapped.m,
              n: mapped.n,
              path: legacyAddress.path
            });
            report.addressAudit.checked++;
            if (
              addressScriptKey(mapped.coin, derived.address) !==
              addressScriptKey(mapped.coin, legacyAddress.address)
            ) {
              report.addressAudit.mismatches.push({
                walletId: mapped.walletId,
                path: legacyAddress.path,
                derived: derived.address,
                legacy: legacyAddress.address
              });
            }
          }
        }
      } catch (err) {
        report.totals.failed++;
        report.errors.push({ walletId: legacyWallet.id, message: (err as Error).message });
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
    await mongo.close();
  }

  report.finishedAt = new Date().toISOString();
  writeFileSync(opts.reportPath, JSON.stringify(report, null, 2) + '\n');

  const { totals, addressAudit } = report;
  console.log(
    `[${report.mode}] seen=${totals.walletsSeen} imported=${totals.imported} ` +
      `already=${totals.alreadyImported} skipped=${totals.skipped} failed=${totals.failed} ` +
      `addressAudit=${addressAudit.checked} mismatches=${addressAudit.mismatches.length}`
  );
  console.log(`report: ${opts.reportPath}`);
  if (report.errors.length > 0 || addressAudit.mismatches.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
