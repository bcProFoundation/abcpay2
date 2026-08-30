# AbcPay v2

Modern rebuild of AbcPay wallet + BWS backend, supporting **eCash (XEC)** and **Dogecoin (DOGE)** only, powered by the **Chronik indexer**.

## Architecture

```
┌─────────────────────┐     BWS-compatible API     ┌─────────────────────┐
│   abcpay-web        │ ◄────────────────────────► │   abcpay-api        │
│   React + Vite      │                            │   Bun + Hono          │
│   (familiar UI)     │                            │   Drizzle + Postgres  │
└─────────────────────┘                            └──────────┬──────────┘
                                                              │
                                                   ┌──────────▼──────────┐
                                                   │   Chronik Indexer   │
                                                   │   XEC + DOGE        │
                                                   └─────────────────────┘
```

### What's included

| Component | Tech | Purpose |
|-----------|------|---------|
| `apps/abcpay-web` | React 19, Vite, Tailwind | Wallet UI (Home / Wallets / Scan tabs) |
| `apps/abcpay-api` | Bun, Hono, Drizzle | BWS-compatible wallet coordination API |
| `packages/abcpay-models` | Zod | Shared types and validation |
| `packages/abcpay-wallet-core` | chronik-client | Blockchain data via Chronik |

### Supported features

- XEC and DOGE wallets only
- m-of-n multisig shared wallets
- Transaction proposal coordination (create, sign, reject, broadcast)
- Chronik-backed UTXO lookup and tx broadcast
- Postgres instead of MongoDB

### Removed (vs legacy AbcPay/Copay)

- BTC, BCH, LTC, XPI, ETH, ERC-20 tokens
- Buy crypto, exchange, debit card, gift cards, WalletConnect
- SLP/eToken support (can be re-added via Chronik token index)
- Mobile native builds (web-first; Capacitor can be added later)

## Quick Start

### Prerequisites

- **Node.js 24+** (Active LTS — see `.nvmrc`)
- **pnpm 9+**
- **Bun 1.4.0** (pinned — API runtime)
- **PostgreSQL 18** (Docker image in `docker-compose.yml`, or PGDG packages for native/cloud install)
- Docker (optional — for Postgres via Compose)

### Setup

```bash
# Start Postgres
docker compose up -d

# Install dependencies
pnpm install

# Build shared packages
pnpm build

# Push database schema
pnpm db:push

# Start dev servers (API + Web)
pnpm dev
```

- **Web UI**: http://localhost:5173
- **BWS API**: http://localhost:3232/bws/api

### Environment

Copy `.env.example` to `.env` and adjust Chronik URLs if needed.

### Runtime versions (pinned / target)

| Component | Version | Notes |
|-----------|---------|--------|
| Node.js | **24.x** (Active LTS) | `.nvmrc`, `engines.node` |
| Bun | **1.4.0** | API runtime; `engines.bun` |
| PostgreSQL | **18** | `postgres:18-alpine` in Compose; PGDG 18 for cloud/native |
| React | **19.x** | Web UI |
| pnpm | **9.10.0** | `packageManager` field |

**PostgreSQL 18 vs 17:** We standardize on **18** for the longest support window (~2030) with minimal app changes — Drizzle migrations are unchanged across PG major versions. If you have an existing local cluster at `~/.abcpay-pgdata` from Postgres 16, remove that directory and re-run `bash scripts/setup-postgres.sh` (or `docker compose down -v` for Compose volumes).

## API Endpoints (BWS-compatible)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v2/wallets/` | Create wallet |
| POST | `/v1/wallets/:id/copayers/` | Join multisig wallet |
| GET | `/v3/wallets/` | Get wallet info |
| POST | `/v3/addresses/` | Register address |
| GET | `/v1/balance/` | Wallet balance |
| GET | `/v1/utxos/` | List UTXOs |
| POST | `/v3/txproposals/` | Create tx proposal |
| POST | `/v1/txproposals/:id/signatures/` | Sign proposal |
| POST | `/v1/txproposals/:id/broadcast/` | Broadcast signed tx |
| POST | `/v1/broadcast_raw/` | Raw tx broadcast |
| GET | `/v1/feelevels/` | Fee estimation |
| GET | `/v3/fiatrates/:code/` | Fiat rates |

## Multisig Flow

1. Creator makes a shared wallet (e.g. 2-of-3) on the Create Wallet page
2. Creator shares the Wallet ID with copayers
3. Copayers join via Join Wallet page
4. Any copayer creates a tx proposal → others sign → broadcast when m signatures reached

## Roadmap

- [x] Real HD key derivation via `@bcpros/crypto-wallet-core` + `@bcpros/bitcore-mnemonic`
- [x] Receive flow with QR code and address generation
- [x] BWS request signature auth (`x-identity` / `x-signature`)
- [x] CoinGecko fiat rates
- [x] BWC-compatible API responses (`/v2/wallets/`, `/v4/addresses/`, etc.)
- [ ] Full send flow with tx building and signing
- [ ] WebSocket notifications for tx proposals
- [ ] Capacitor mobile wrapper

## Related Repos

- [AbcPay (legacy)](https://github.com/bcProFoundation/AbcPay) — Angular/Ionic frontend
- [Bitcore (legacy BWS)](https://github.com/bcProFoundation/bitcore) — MongoDB-based BWS
