import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const indexPath = path.join(publicDir, 'index.html');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(compression());

// Render's health check (render.yaml → healthCheckPath) hits this. A GitHub
// Actions cron also pings it every 10 min so the free instance never sleeps.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── CoinGecko proxy + cache ──────────────────────────────────────────────────
// All market data flows through here so every visitor shares one server-side
// cache (CoinGecko's keyless tier rate-limits per IP — browsers hitting it
// directly kept getting blocked). Stale data is served whenever upstream
// fails; the optional COINGECKO_KEY env raises upstream limits.
const CG_BASE = 'https://api.coingecko.com/api/v3';
const CG_TTLS = [
  [/^\/coins\/markets\?/, 60_000],
  [/^\/simple\/price\?/, 60_000],
  [/^\/coins\/[\w-]+\/market_chart\?/, 5 * 60_000],
  [/^\/coins\/[\w-]+\/history\?/, 24 * 60 * 60_000],
];
const cgCache = new Map(); // path -> { t, data }
const cgInflight = new Map();

async function cgGet(cgPath, ttl) {
  const hit = cgCache.get(cgPath);
  if (hit && Date.now() - hit.t < ttl) return hit.data;

  if (!cgInflight.has(cgPath)) {
    cgInflight.set(
      cgPath,
      (async () => {
        const key = process.env.COINGECKO_KEY;
        const upstream = await fetch(CG_BASE + cgPath, {
          headers: key ? { 'x-cg-demo-api-key': key } : {},
          signal: AbortSignal.timeout(15_000),
        });
        if (!upstream.ok) throw Object.assign(new Error('upstream'), { status: upstream.status });
        const data = await upstream.json();
        if (cgCache.size > 300) cgCache.delete(cgCache.keys().next().value);
        cgCache.set(cgPath, { t: Date.now(), data });
        return data;
      })().finally(() => cgInflight.delete(cgPath)),
    );
  }

  try {
    return await cgInflight.get(cgPath);
  } catch (err) {
    if (hit) return hit.data; // stale beats nothing
    throw err;
  }
}

app.get('/api/cg/*', async (req, res) => {
  const cgPath = req.originalUrl.slice('/api/cg'.length);
  const rule = CG_TTLS.find(([re]) => re.test(cgPath));
  if (!rule) return res.status(400).json({ error: 'unsupported path' });
  try {
    res.json(await cgGet(cgPath, rule[1]));
  } catch (err) {
    res.status(err.status === 429 ? 429 : 502).json({ error: 'market data unavailable' });
  }
});

// ── Warm cache + bootstrap payload ───────────────────────────────────────────
// The server refreshes markets + spot prices every minute so no visitor ever
// waits on CoinGecko, and the freshest snapshot is inlined into index.html —
// the page paints with live data before making a single API call.
const MARKETS_PATH =
  '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h';

let bootstrap = null;

// Sparklines downsample to ~40 points — the table only draws ~30 — which keeps
// the inlined payload small.
function downsample(arr, n) {
  if (!Array.isArray(arr) || arr.length <= n) return arr || [];
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
}

async function warm() {
  try {
    const markets = await cgGet(MARKETS_PATH, 55_000);
    const ids = [...new Set(['bitcoin', 'ethereum', ...markets.slice(0, 20).map((c) => c.id)])].sort();
    const pricePath = `/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd,eur,gbp`;
    const prices = await cgGet(pricePath, 55_000);
    bootstrap = {
      t: Date.now(),
      markets: markets.map((c) => ({
        ...c,
        sparkline_in_7d: { price: downsample(c.sparkline_in_7d?.price, 40) },
      })),
      prices,
    };
  } catch {
    // Keep the previous bootstrap; the client falls back to fetching.
  }
}
warm();
setInterval(warm, 60_000);

function sendIndex(res) {
  let html = readFileSync(indexPath, 'utf8');
  const payload = bootstrap ? JSON.stringify(bootstrap).replace(/</g, '\\u003c') : 'null';
  html = html.replace('<!--__BOOTSTRAP__-->', `<script>window.__BOOTSTRAP__=${payload}</script>`);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
}

app.get(['/', '/index.html'], (_req, res) => sendIndex(res));

// no-cache (NOT no-store): browsers revalidate every load via ETag and get a
// cheap 304 unless a deploy changed the file — fixes shipping going stale in
// visitors' tabs for an hour, which the old `maxAge: 1h` caused.
app.use(
  express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  }),
);

// Non-API GETs fall back to the single page.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  sendIndex(res);
});

app.listen(port, host, () => {
  console.log(`ReelGrab — live crypto calculators · http://localhost:${port}`);
});
