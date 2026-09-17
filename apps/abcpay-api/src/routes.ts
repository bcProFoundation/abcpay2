import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createWalletRequestSchema, joinWalletRequestSchema, createTxProposalRequestSchema } from '@bcpros/abcpay-models';
import { getFeeEstimate, chainFromCoin } from '@bcpros/abcpay-wallet-core';
import { walletService } from './services/wallet.service';
import { COPAYER_NOT_IN_WALLET, txProposalService } from './services/tx-proposal.service';
import { addressService } from './services/address.service';
import { fiatService } from './services/fiat.service';
import { authMiddleware } from './middleware/auth';
import { config } from './config';

export function createApp() {
  const app = new Hono<{ Variables: { copayerId: string; walletId: string } }>();

  app.use('*', cors());
  app.use('*', authMiddleware);

  const proposalError = (c: Context, err: unknown) => {
    if ((err as Error).message === COPAYER_NOT_IN_WALLET) {
      return c.json({ code: 'FORBIDDEN', message: (err as Error).message }, 403);
    }
    return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
  };

  app.get('/health', c => c.json({ status: 'ok', version: '0.2.0', coins: ['xec', 'doge'] }));

  const handleCreateWallet = async (c: { req: { json: () => Promise<unknown> }; json: (body: unknown, status?: number) => Response }) => {
    try {
      const body = createWalletRequestSchema.parse(await c.req.json());
      const result = await walletService.createWallet(body);
      return c.json({ walletId: result.walletId }, 201);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  };

  app.post('/v1/wallets/', handleCreateWallet);
  app.post('/v2/wallets/', handleCreateWallet);

  const handleJoinWallet = async (c: { req: { param: (k: string) => string; json: () => Promise<unknown> }; json: (body: unknown, status?: number) => Response }) => {
    try {
      const walletId = c.req.param('id');
      const raw = await c.req.json();
      const body = joinWalletRequestSchema.parse({ ...(raw as object), walletId });
      const result = await walletService.joinWallet(walletId, body);
      return c.json(result);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  };

  app.post('/v1/wallets/:id/copayers/', handleJoinWallet);
  app.post('/v2/wallets/:id/copayers', handleJoinWallet);
  app.post('/v2/wallets/:id/copayers/', handleJoinWallet);

  app.get('/v1/wallets/:id/info', async c => {
    const wallet = await walletService.getWallet(c.req.param('id'));
    if (!wallet) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json({ id: wallet.id, m: wallet.m, n: wallet.n, coin: wallet.coin, status: wallet.status });
  });

  app.get('/v1/wallets/:id/join-info/', async c => {
    const info = await walletService.getJoinInfo(c.req.param('id'));
    if (!info) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json(info);
  });

  const handleGetWallet = async (c: { req: { header: (k: string) => string | undefined }; json: (body: unknown, status?: number) => Response }) => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    const status = await walletService.getWalletStatus(walletId);
    if (!status) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json(status);
  };

  app.get('/v1/wallets/', handleGetWallet);
  app.get('/v2/wallets/', handleGetWallet);
  app.get('/v3/wallets/', handleGetWallet);

  app.post('/v3/addresses/', async c => {
    try {
      const walletId = c.req.header('x-wallet-id');
      if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

      const body = await c.req.json().catch(() => ({}));
      const isChange = Boolean(body.isChange);
      const addr =
        body.address != null
          ? await walletService.registerAddress(
              walletId,
              body.address,
              body.path,
              body.publicKeys ?? [],
              isChange
            )
          : await walletService.createAddress(walletId, isChange);
      return c.json(walletService.toAddressResponse(addr), 201);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.post('/v4/addresses/', async c => {
    try {
      const walletId = c.req.header('x-wallet-id');
      if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

      const body = await c.req.json().catch(() => ({}));
      const addr = await walletService.createAddress(walletId, Boolean(body.isChange));
      return c.json(
        walletService.toAddressResponse(
          addr,
          addr as { redeemScript?: string; scriptPubKey?: string }
        ),
        201
      );
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.get('/v1/addresses/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

    const url = new URL(c.req.url);
    const limit = url.searchParams.get('limit');
    if (limit) {
      const addrs = await addressService.getMainAddresses(walletId, parseInt(limit));
      return c.json(addrs);
    }

    const list = await walletService.getWalletAddresses(walletId);
    return c.json(list.map(a => walletService.toAddressResponse(a)));
  });

  app.get('/v1/addresses/main/', async c => {
    try {
      const walletId = c.req.header('x-wallet-id');
      if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
      const addr = await walletService.getMainAddress(walletId);
      return c.json(walletService.toAddressResponse(addr));
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.get('/v4/addresses/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

    const url = new URL(c.req.url);
    const limit = url.searchParams.get('limit');
    const addrs = await addressService.getMainAddresses(walletId, limit ? parseInt(limit) : undefined);
    return c.json(addrs);
  });

  app.get('/v1/balance/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json(await walletService.getBalance(walletId));
  });

  app.get('/v1/utxos/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json(await walletService.getUtxos(walletId));
  });

  app.get('/v1/txhistory/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json(await walletService.getHistory(walletId));
  });

  app.post('/v3/txproposals/', async c => {
    try {
      const walletId = c.req.header('x-wallet-id');
      const copayerId = c.req.header('x-copayer-id') ?? c.req.header('x-identity');
      if (!walletId || !copayerId) {
        return c.json({ code: 'BAD_REQUEST', message: 'Missing wallet or copayer id' }, 400);
      }

      const body = createTxProposalRequestSchema.parse(await c.req.json());
      const proposal = await txProposalService.createProposal(walletId, copayerId, body);
      return c.json(proposal, 201);
    } catch (err) {
      return proposalError(c, err);
    }
  });

  app.get('/v1/txproposals/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    return c.json(await txProposalService.getProposals(walletId));
  });

  app.get('/v1/txproposals/:id/', async c => {
    const proposal = await txProposalService.getProposal(c.req.param('id'));
    if (!proposal) return c.json({ code: 'NOT_FOUND', message: 'Proposal not found' }, 404);
    const authWalletId = c.get('walletId') as string | undefined;
    if (authWalletId && proposal.walletId !== authWalletId) {
      return c.json({ code: 'FORBIDDEN', message: 'Proposal belongs to a different wallet' }, 403);
    }
    return c.json(proposal);
  });

  app.post('/v1/txproposals/:id/signatures/', async c => {
    try {
      const copayerId = c.req.header('x-copayer-id') ?? c.req.header('x-identity');
      if (!copayerId) return c.json({ code: 'BAD_REQUEST', message: 'Missing copayer id' }, 400);

      const body = await c.req.json();
      const signatures: string[] = Array.isArray(body.signatures)
        ? body.signatures
        : String(body.signatures ?? '')
            .split(',')
            .filter(Boolean);
      const proposal = await txProposalService.signProposal(c.req.param('id'), copayerId, signatures);
      return c.json(proposal);
    } catch (err) {
      return proposalError(c, err);
    }
  });

  app.post('/v1/txproposals/:id/rejections/', async c => {
    try {
      const copayerId = c.req.header('x-copayer-id') ?? c.req.header('x-identity');
      if (!copayerId) return c.json({ code: 'BAD_REQUEST', message: 'Missing copayer id' }, 400);

      const body = await c.req.json().catch(() => ({}));
      const proposal = await txProposalService.rejectProposal(c.req.param('id'), copayerId, body.reason);
      return c.json(proposal);
    } catch (err) {
      return proposalError(c, err);
    }
  });

  app.post('/v1/txproposals/:id/broadcast/', async c => {
    try {
      const copayerId = c.req.header('x-copayer-id') ?? c.req.header('x-identity');
      if (!copayerId) return c.json({ code: 'BAD_REQUEST', message: 'Missing copayer id' }, 400);

      const body = await c.req.json();
      const proposal = await txProposalService.broadcastProposal(c.req.param('id'), copayerId, body.raw);
      return c.json(proposal);
    } catch (err) {
      return proposalError(c, err);
    }
  });

  app.post('/v1/broadcast_raw/', async c => {
    try {
      const body = await c.req.json();
      return c.json(await txProposalService.broadcastRaw(body.coin ?? 'xec', body.raw));
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  const handleFeeLevels = async (c: { req: { query: (k: string) => string | undefined }; json: (body: unknown) => Response }) => {
    const coin = (c.req.query('coin') ?? 'xec') as 'xec' | 'doge';
    const feePerKb = await getFeeEstimate(chainFromCoin(coin));
    return c.json([
      { level: 'urgent', feePerKb: feePerKb * 2, nbBlocks: 1 },
      { level: 'priority', feePerKb: Math.round(feePerKb * 1.5), nbBlocks: 2 },
      { level: 'normal', feePerKb, nbBlocks: 3 },
      { level: 'economy', feePerKb: Math.round(feePerKb * 0.75), nbBlocks: 6 },
      { level: 'superEconomy', feePerKb: Math.round(feePerKb * 0.5), nbBlocks: 12 }
    ]);
  };

  app.get('/v1/feelevels/', handleFeeLevels);
  app.get('/v2/feelevels/', handleFeeLevels);

  app.get('/v3/fiatrates/:code/', async c => {
    const code = c.req.param('code');
    const coin = (c.req.query('coin') ?? code) as 'xec' | 'doge';
    const rate = await fiatService.getRate(coin, 'usd');
    return c.json(rate);
  });

  const root = new Hono();
  root.route(config.basePath, app);
  root.route(config.legacyBasePath, app);
  return root;
}
