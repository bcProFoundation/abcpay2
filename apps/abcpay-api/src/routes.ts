import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createWalletRequestSchema, joinWalletRequestSchema, createTxProposalRequestSchema } from '@bcpros/abcpay-models';
import { getFeeEstimate, chainFromCoin } from '@bcpros/abcpay-wallet-core';
import { walletService } from './services/wallet.service';
import { txProposalService } from './services/tx-proposal.service';
import { addressService } from './services/address.service';
import { fiatService } from './services/fiat.service';
import { authMiddleware } from './middleware/auth';
import { config } from './config';

export function createApp() {
  const app = new Hono().basePath(config.basePath);

  app.use('*', cors());
  app.use('*', authMiddleware);

  app.get('/health', c => c.json({ status: 'ok', version: '0.2.0' }));

  // Wallet creation (BWS-compatible)
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

  // Join wallet (BWC uses /v2/wallets/:id/copayers)
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

  // Get wallet status (BWC expects { wallet, pendingTxps, ... })
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

  // Create address (BWC uses /v4/addresses/)
  app.post('/v3/addresses/', async c => {
    try {
      const walletId = c.req.header('x-wallet-id');
      if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

      const body = await c.req.json().catch(() => ({}));
      const addr = await addressService.createAddress(walletId, body.isChange ?? false);
      return c.json(addr, 201);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.post('/v4/addresses/', async c => {
    try {
      const walletId = c.req.header('x-wallet-id');
      if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

      const body = await c.req.json().catch(() => ({}));
      const addr = await addressService.createAddress(walletId, body.isChange ?? false);
      return c.json(addr, 201);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  // List addresses
  app.get('/v1/addresses/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

    const url = new URL(c.req.url);
    const limit = url.searchParams.get('limit');
    const addrs = await addressService.getMainAddresses(walletId, limit ? parseInt(limit) : undefined);
    return c.json(addrs);
  });

  app.get('/v4/addresses/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);

    const url = new URL(c.req.url);
    const limit = url.searchParams.get('limit');
    const addrs = await addressService.getMainAddresses(walletId, limit ? parseInt(limit) : undefined);
    return c.json(addrs);
  });

  // Balance
  app.get('/v1/balance/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    const balance = await walletService.getBalance(walletId);
    return c.json(balance);
  });

  // UTXOs
  app.get('/v1/utxos/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    const utxos = await walletService.getUtxos(walletId);
    return c.json(utxos);
  });

  // Tx history
  app.get('/v1/txhistory/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    const history = await walletService.getTxHistory(walletId);
    return c.json(history);
  });

  // Tx proposals
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
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.get('/v1/txproposals/', async c => {
    const walletId = c.req.header('x-wallet-id');
    if (!walletId) return c.json({ code: 'NOT_FOUND', message: 'Wallet not found' }, 404);
    const proposals = await txProposalService.getProposals(walletId);
    return c.json(proposals);
  });

  app.get('/v1/txproposals/:id/', async c => {
    const proposal = await txProposalService.getProposal(c.req.param('id'));
    if (!proposal) return c.json({ code: 'NOT_FOUND', message: 'Proposal not found' }, 404);
    return c.json(proposal);
  });

  app.post('/v1/txproposals/:id/signatures/', async c => {
    try {
      const copayerId = c.req.header('x-copayer-id') ?? c.req.header('x-identity');
      if (!copayerId) return c.json({ code: 'BAD_REQUEST', message: 'Missing copayer id' }, 400);

      const body = await c.req.json();
      const proposal = await txProposalService.signProposal(c.req.param('id'), copayerId, body.signatures);
      return c.json(proposal);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.post('/v1/txproposals/:id/rejections/', async c => {
    try {
      const copayerId = c.req.header('x-copayer-id') ?? c.req.header('x-identity');
      if (!copayerId) return c.json({ code: 'BAD_REQUEST', message: 'Missing copayer id' }, 400);

      const body = await c.req.json();
      const proposal = await txProposalService.rejectProposal(c.req.param('id'), copayerId, body.reason);
      return c.json(proposal);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  app.post('/v1/txproposals/:id/broadcast/', async c => {
    try {
      const body = await c.req.json();
      const proposal = await txProposalService.broadcastProposal(c.req.param('id'), body.raw);
      return c.json(proposal);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  // Raw broadcast
  app.post('/v1/broadcast_raw/', async c => {
    try {
      const body = await c.req.json();
      const result = await txProposalService.broadcastRaw(body.coin ?? 'xec', body.raw);
      return c.json(result);
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: (err as Error).message }, 400);
    }
  });

  // Fee levels
  const handleFeeLevels = async (c: { req: { query: (k: string) => string | undefined }; json: (body: unknown) => Response }) => {
    const coin = (c.req.query('coin') ?? 'xec') as 'xec' | 'doge';
    const chain = chainFromCoin(coin);
    const feePerKb = await getFeeEstimate(chain);

    return c.json([
      { level: 'urgent', feePerKb: feePerKb * 2, nbBlocks: 1 },
      { level: 'priority', feePerKb: feePerKb * 1.5, nbBlocks: 2 },
      { level: 'normal', feePerKb, nbBlocks: 3 },
      { level: 'economy', feePerKb: feePerKb * 0.75, nbBlocks: 6 },
      { level: 'superEconomy', feePerKb: feePerKb * 0.5, nbBlocks: 12 }
    ]);
  };

  app.get('/v1/feelevels/', handleFeeLevels);
  app.get('/v2/feelevels/', handleFeeLevels);

  // Fiat rates via CoinGecko
  app.get('/v3/fiatrates/:code/', async c => {
    const code = c.req.param('code');
    const coin = (c.req.query('coin') ?? code) as 'xec' | 'doge';
    const rate = await fiatService.getRate(coin, 'usd');
    return c.json(rate);
  });

  return app;
}
