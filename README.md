# ReelGrab — Live crypto calculators

A real-time crypto calculator + market dashboard at [reelgrab.xyz](https://reelgrab.xyz):

- **Converter** — crypto ↔ fiat and crypto ↔ crypto, live, with swap (default `1 BTC → USD`)
- **Profit / loss** — buy/sell price, quantity or invested-amount mode, optional per-side fee %
- **What if I'd invested** — historical price on a past date vs. value today
- **Market table** — top 50 coins with price, 24h %, 7d sparkline, cap, volume
- **Detail chart** — Lightweight Charts area chart with 24h / 7d / 30d / 1y timeframes

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
└─ components/                # coinSelect, converter, pnl, whatIf, marketTable, chart
```

## Run locally

```sh
npm install
npm start          # http://localhost:3000
npm run dev        # auto-restarts on server changes
```

## Rate limits & caching

CoinGecko's keyless tier is tight (~5–15 calls/min), so every request goes
through a localStorage cache: prices/markets 60s, chart data 5min, historical
snapshots 24h. Steady state is ~2 calls/min. On a `429` or network failure the
app serves the last cached values, shows a "rates delayed" badge, and backs off
exponentially (30s → 5min) — a failed poll never blanks the UI.

### Optional API key

Set `COINGECKO_KEY` (a free CoinGecko **Demo** key) in the server environment to
raise the limits. The client fetches it from `/api/config` and sends it as the
`x-cg-demo-api-key` header. The app works fine without it.

## Deploy

Render free plan via Docker (`render.yaml` blueprint), auto-deploys from `main`.
Health check: `GET /api/health`. The pre-rebuild YouTube-converter site is
preserved on the `pre-crypto-backup` branch.
