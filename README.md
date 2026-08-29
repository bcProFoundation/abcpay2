# AbcPay v2

Modern rebuild of AbcPay + Bitcore Wallet Service for **eCash (XEC)** and **Dogecoin (DOGE)** only, using **Chronik**.

Private keys never leave the browser. The API stores xpubs and coordinates m-of-n proposals.

```
React (AbcPay UI)  →  Hono BWS API  →  PostgreSQL
                           └── Chronik (XEC + DOGE)
```

## Stack

| Layer | Tech |
|-------|------|
| Web | React 19, Vite, Tailwind — Home / Scan / Wallets tabs |
| API | TypeScript, Hono, Node (tsx) or Bun |
| DB | PostgreSQL (Drizzle) |
| Indexer | Chronik (`chronik.e.cash`, `chronik.pay2stay.com/doge`, …) |
| Crypto | BIP39/BIP32 (`@scure/*`), XEC CashAddr, DOGE Base58, P2PKH + P2SH multisig |

## Features

- HD wallets from a 12-word phrase
- XEC and DOGE only
- 1-of-1 and m-of-n shared wallets
- Receive address + QR, send, history
- Tx proposal sign/reject/broadcast for multisig
- Request signatures (`x-identity` / `x-signature`)
- CoinGecko USD rates
- No BTC/BCH/LTC/ETH, no BitPay buy/exchange/card extras

## Quick start

```bash
# Postgres
docker compose up -d

cp .env.example .env
pnpm install
pnpm build
pnpm db:push
pnpm dev
```

- Web: http://localhost:5173
- API: http://localhost:3232/bws/api/health

## Multisig

1. Create a shared wallet and back up the phrase
2. Share the Wallet ID
3. Copayers join (each device keeps its own phrase)
4. Any copayer sends a proposal → others Sign on the wallet screen → broadcast at `m` signatures

## Environment

See `.env.example`. Set `REQUIRE_AUTH=0` only for local debugging.
