import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  accountPathFor,
  createCredentials,
  DEFAULT_TOKEN_VISIBILITY,
  deriveWalletAddress,
  groupAccountsByWallet,
  hiddenTokenCount,
  isTokenVisible,
  relativePath,
  restoreAccountDescriptors,
  restoreCandidatesForMnemonic,
  seedIdForCredentials,
  sortAccounts,
  visibleTokens,
  walletDisplayId,
  withTokenVisibility
} from '../index';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SECOND =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

interface LegacyWallet {
  id: string;
  coin: 'xec' | 'doge';
  coinType: number;
  m: number;
  n: number;
  copayers: Array<{ mnemonic: string; xPubKey: string; copayerId: string; rootPath: string }>;
  addresses: Array<{ path: string; address: string }>;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-parity.json', import.meta.url), 'utf8')
) as { wallets: LegacyWallet[] };

describe('one seed = one Wallet, derivations are Accounts', () => {
  it('scans every derivation variant: XEC 1899/899/145 + DOGE, single and multisig', () => {
    const descriptors = restoreAccountDescriptors();
    expect(descriptors.map(d => `${d.coin}:${d.accountPath}`)).toEqual([
      "xec:m/44'/1899'/0'",
      "xec:m/44'/899'/0'",
      "xec:m/44'/145'/0'",
      "xec:m/48'/1899'/0'",
      "xec:m/48'/899'/0'",
      "xec:m/48'/145'/0'",
      "doge:m/44'/3'/0'",
      "doge:m/48'/3'/0'"
    ]);
    expect(descriptors).toContainEqual(
      expect.objectContaining({ coin: 'xec', coinType: 145, isMultisig: true })
    );
  });

  it('derives 8 unique candidates from one seed, all sharing one Wallet (seed) id', () => {
    const candidates = restoreCandidatesForMnemonic(MNEMONIC);
    expect(candidates).toHaveLength(8);
    expect(new Set(candidates.map(c => c.copayerId)).size).toBe(8);
    expect(new Set(candidates.map(c => c.xPubKey)).size).toBe(8);
    // Wallet identity: request key at m/1'/0 is variant-independent.
    expect(new Set(candidates.map(c => seedIdForCredentials(c))).size).toBe(1);
    expect(walletDisplayId(seedIdForCredentials(candidates[0]))).toMatch(/^Wallet · [0-9a-f]{8}…$/);
  });

  it('finds every v1 wallet under the seed, single-sig and multisig', () => {
    const candidates = restoreCandidatesForMnemonic(MNEMONIC);
    const byCopayer = new Map(candidates.map(c => [c.copayerId, c]));
    // Fixture wallets copayer "a" all use MNEMONIC across 1899/899/DOGE,
    // single and multisig — a mnemonic-only lookup must hit every one.
    const aWallets = fixture.wallets.filter(w => w.copayers[0].mnemonic === MNEMONIC);
    expect(aWallets.length).toBeGreaterThanOrEqual(5);
    for (const wallet of aWallets) {
      const hit = byCopayer.get(wallet.copayers[0].copayerId);
      expect(hit, wallet.id).toBeTruthy();
      expect(hit?.xPubKey).toBe(wallet.copayers[0].xPubKey);
      expect(hit?.accountPath).toBe(wallet.copayers[0].rootPath);
    }
  });

  it('finds the second copayer seed wallets too (multisig peers restore independently)', () => {
    const candidates = restoreCandidatesForMnemonic(SECOND);
    const byCopayer = new Map(candidates.map(c => [c.copayerId, c]));
    const bWallets = fixture.wallets.filter(w => w.copayers.some(c => c.mnemonic === SECOND));
    expect(bWallets.length).toBeGreaterThanOrEqual(4);
    for (const wallet of bWallets) {
      const copayer = wallet.copayers.find(c => c.mnemonic === SECOND)!;
      expect(byCopayer.get(copayer.copayerId)?.xPubKey, wallet.id).toBe(copayer.xPubKey);
    }
  });

  it('includes RaiPay 145 multisig, which the old scan missed', () => {
    const raiMulti = createCredentials({
      coin: 'xec',
      mnemonic: MNEMONIC,
      isMultisig: true,
      usePurpose48: true,
      coinType: 145
    });
    const candidates = restoreCandidatesForMnemonic(MNEMONIC);
    expect(candidates.some(c => c.xPubKey === raiMulti.xPubKey)).toBe(true);
    expect(raiMulti.accountPath).toBe("m/48'/145'/0'");
  });

  it('re-derives the v1 P2SH address for multisig wallets from candidate xpubs', () => {
    for (const wallet of fixture.wallets.filter(w => w.n > 1)) {
      const xPubKeys = wallet.copayers.map(copayer => {
        const creds = restoreCandidatesForMnemonic(copayer.mnemonic).find(
          c => c.copayerId === copayer.copayerId
        );
        expect(creds, `${wallet.id} copayer`).toBeTruthy();
        return creds!.xPubKey;
      });
      const derived = deriveWalletAddress({
        coin: wallet.coin,
        xPubKeys,
        m: wallet.m,
        n: wallet.n,
        path: relativePath(false, 0)
      });
      const normalize = (a: string) => a.replace(/^ecash:/, '');
      expect(normalize(derived.address)).toBe(normalize(wallet.addresses[0].address));
      expect(derived.type).toBe('P2SH');
      expect(derived.redeemScript).toBeTruthy();
    }
  });

  it('groups many Accounts from one seed into a single Wallet, regardless of network', () => {
    const seedA = restoreCandidatesForMnemonic(MNEMONIC);
    const seedB = restoreCandidatesForMnemonic(SECOND);
    const accounts = [
      { id: 'a-1899', seedId: seedIdForCredentials(seedA[0]), coin: 'xec' as const, coinType: 1899, m: 1, n: 1, network: 'livenet' },
      { id: 'a-899', seedId: seedIdForCredentials(seedA[1]), coin: 'xec' as const, coinType: 899, m: 1, n: 1, network: 'testnet' },
      { id: 'a-145-multi', seedId: seedIdForCredentials(seedA[5]), coin: 'xec' as const, coinType: 145, m: 2, n: 3, network: 'livenet' },
      { id: 'a-doge-multi', seedId: seedIdForCredentials(seedA[7]), coin: 'doge' as const, coinType: 3, m: 2, n: 2, network: 'livenet' },
      { id: 'a-other-seed', seedId: seedIdForCredentials(seedB[0]), coin: 'xec' as const, coinType: 1899, m: 1, n: 1, network: 'livenet' }
    ];
    const groups = groupAccountsByWallet(accounts);
    expect(groups).toHaveLength(2);
    const main = groups.find(g => g.accounts.some(a => a.id === 'a-1899'))!;
    expect(main.accounts.map(a => a.id)).toEqual(['a-1899', 'a-899', 'a-145-multi', 'a-doge-multi']);
    expect(groups.find(g => g.id !== main.id)?.accounts.map(a => a.id)).toEqual(['a-other-seed']);
  });

  it('labels Accounts by path and coin, and sorts deterministically', () => {
    expect(accountPathFor({ coin: 'xec', coinType: 899, n: 3 })).toBe("m/48'/899'/0'");
    expect(accountPathFor({ coin: 'doge', coinType: 3, n: 1 })).toBe("m/44'/3'/0'");
    expect(accountLabel({ coin: 'xec', coinType: 1899, m: 1, n: 1 })).toBe("XEC · m/44'/1899'/0'");
    expect(accountLabel({ coin: 'xec', coinType: 899, m: 2, n: 3 })).toBe(
      "XEC · m/48'/899'/0' · 2-of-3"
    );
    expect(accountLabel({ coin: 'xec', coinType: 899, m: 1, n: 1, network: 'testnet' })).toBe(
      "XEC · m/44'/899'/0' · testnet"
    );
    const sorted = sortAccounts([
      { coin: 'doge' as const, coinType: 3, m: 1, n: 1 },
      { coin: 'xec' as const, coinType: 899, m: 2, n: 2 },
      { coin: 'xec' as const, coinType: 899, m: 1, n: 1 },
      { coin: 'xec' as const, coinType: 1899, m: 1, n: 1 },
      { coin: 'xec' as const, coinType: 145, m: 1, n: 1 }
    ]);
    expect(sorted.map(w => `${w.coin}:${w.coinType}:${w.n}`)).toEqual([
      'xec:1899:1',
      'xec:899:1',
      'xec:145:1',
      'xec:899:2',
      'doge:3:1'
    ]);
  });

  it('hides tokens by default; only Settings-opted-in tokens show', () => {
    const tokens = [{ tokenId: 'tok-a' }, { tokenId: 'tok-b' }];
    expect(isTokenVisible(DEFAULT_TOKEN_VISIBILITY, 'tok-a')).toBe(false);
    expect(visibleTokens(tokens, DEFAULT_TOKEN_VISIBILITY)).toEqual([]);
    expect(hiddenTokenCount(tokens, DEFAULT_TOKEN_VISIBILITY)).toBe(2);
    const settings = withTokenVisibility(DEFAULT_TOKEN_VISIBILITY, 'tok-b', true);
    expect(visibleTokens(tokens, settings).map(t => t.tokenId)).toEqual(['tok-b']);
    expect(withTokenVisibility(settings, 'tok-b', false)).toEqual(DEFAULT_TOKEN_VISIBILITY);
  });
});
