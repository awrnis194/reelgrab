import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');

// Render's health check (render.yaml → healthCheckPath) hits this.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── CoinGecko proxy ──────────────────────────────────────────────────────────
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

app.get('/api/cg/*', async (req, res) => {
  const path = req.originalUrl.slice('/api/cg'.length);
  const rule = CG_TTLS.find(([re]) => re.test(path));
  if (!rule) return res.status(400).json({ error: 'unsupported path' });

  const hit = cgCache.get(path);
  if (hit && Date.now() - hit.t < rule[1]) return res.json(hit.data);

  if (!cgInflight.has(path)) {
    cgInflight.set(
      path,
      (async () => {
        const key = process.env.COINGECKO_KEY;
        const upstream = await fetch(CG_BASE + path, {
          headers: key ? { 'x-cg-demo-api-key': key } : {},
          signal: AbortSignal.timeout(15_000),
        });
        if (!upstream.ok) throw Object.assign(new Error('upstream'), { status: upstream.status });
        const data = await upstream.json();
        if (cgCache.size > 300) cgCache.delete(cgCache.keys().next().value);
        cgCache.set(path, { t: Date.now(), data });
        return data;
      })().finally(() => cgInflight.delete(path)),
    );
  }

  try {
    res.json(await cgInflight.get(path));
  } catch (err) {
    if (hit) return res.json(hit.data); // stale beats nothing
    res.status(err.status === 429 ? 429 : 502).json({ error: 'market data unavailable' });
  }
});

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
  res.sendFile('index.html', {
    root: publicDir,
    headers: { 'Cache-Control': 'no-cache' },
  });
});

app.listen(port, host, () => {
  console.log(`ReelGrab — live crypto calculators · http://localhost:${port}`);
});
