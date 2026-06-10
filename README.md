# ReelGrab — Live crypto calculators

A real-time crypto calculator + market dashboard at [reelgrab.xyz](https://reelgrab.xyz):

- **Converter** — crypto ↔ fiat and crypto ↔ crypto, live, with swap (default `1 BTC → USD`)
- **Profit / loss** — buy/sell price, quantity or invested-amount mode, optional per-side fee %
- **What if I'd invested** — historical price on a past date vs. value today
- **Market table** — top 50 coins with price, 24h %, 7d sparkline, cap, volume
- **Detail chart** — embedded TradingView Advanced Chart (own data feed, symbol search, custom date ranges)

All market data comes client-side from the free [CoinGecko API](https://www.coingecko.com/en/api).
The backend is a tiny Express static server (kept for the existing Render Docker deploy).

## Stack

Vanilla ES modules — no build step. `public/` is served as-is by `server.js`.

```
public/
├─ index.html
├─ main.js                    # orchestration + 60s poll
├─ styles/tokens.css          # palette, type, spacing vars
├─ styles/app.css
├─ lib/api.js                 # CoinGecko fetch + localStorage cache + backoff
├─ lib/format.js              # currency / % / compact formatting, tween, debounce
└─ components/                # coinSelect, converter, pnl, whatIf, marketTable, tvChart
```

## Run locally

```sh
npm install
npm start          # http://localhost:3000
npm run dev        # auto-restarts on server changes
```

## Rate limits & caching

CoinGecko's keyless tier rate-limits per IP, so browsers never call it
directly: the client hits the server's `/api/cg/*` proxy, which holds one
shared in-memory cache for all visitors (prices/markets 60s, chart data 5min,
historical snapshots 24h) and serves stale data when upstream fails. The
client adds its own localStorage cache + exponential backoff on top, and the
UI boots from a built-in coin list — a dead market feed never blanks the page,
it just shows a "rates delayed" badge and retries.

### Optional API key

Set `COINGECKO_KEY` (a free CoinGecko **Demo** key) in the server environment
and the proxy sends it as the `x-cg-demo-api-key` header to raise upstream
limits. The app works fine without it.

## Deploy

Render free plan via Docker (`render.yaml` blueprint), auto-deploys from `main`.
Health check: `GET /api/health`. The pre-rebuild YouTube-converter site is
preserved on the `pre-crypto-backup` branch.
