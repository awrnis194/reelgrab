// ReelGrab edge worker — Cloudflare port of the old Express server (2026-06-12, after
// Render's free 5 GB bandwidth cap suspended the site). Static files ship as Workers
// assets (unmetered bandwidth — the page itself can never be capped or suspended);
// this script only runs for /api/* and unknown-path SPA fallbacks.
//
//   /api/health     — uptime probe
//   /api/bootstrap  — freshest markets+prices snapshot (was inlined into index.html by
//                     Express; index.html now starts this fetch in <head>)
//   /api/cg/*       — whitelisted CoinGecko proxy: every visitor shares the edge cache
//                     (CoinGecko's keyless tier rate-limits per IP), stale beats nothing
//
// A Cron Trigger (*/2 min) rebuilds the snapshot into KV: 720 writes/day, safely under
// the free plan's 1,000. One KV key only — markets, prices, and timestamps travel
// together so a half-updated snapshot can't exist.

const CG_BASE = 'https://api.coingecko.com/api/v3';
const MARKETS_PATH =
  '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h';

// path-regex -> edge cache TTL (seconds). Mirrors the client's lib/api.js TTLs.
const CG_TTLS = [
  [/^\/coins\/markets\?/, 60],
  [/^\/simple\/price\?/, 60],
  [/^\/coins\/[\w-]+\/market_chart\?/, 300],
  [/^\/coins\/[\w-]+\/history\?/, 24 * 60 * 60],
];

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, cacheSeconds = 0) {
  return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
    status,
    headers: cacheSeconds
      ? { ...JSON_HEADERS, 'cache-control': `public, max-age=${cacheSeconds}` }
      : JSON_HEADERS,
  });
}

async function cgFetch(cgPath, env) {
  // CoinGecko 429s are routine on the keyless tier — retry twice with a pause.
  const key = env.COINGECKO_KEY;
  for (let attempt = 0; ; attempt++) {
    const upstream = await fetch(CG_BASE + cgPath, {
      // CoinGecko 403s UA-less requests, and Workers' fetch sends no User-Agent.
      headers: {
        'user-agent': 'reelgrab.xyz market proxy',
        accept: 'application/json',
        ...(key ? { 'x-cg-demo-api-key': key } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (upstream.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!upstream.ok)
      throw Object.assign(new Error(`upstream ${upstream.status}`), { status: upstream.status });
    return upstream.text();
  }
}

// Sparklines downsample to ~40 points — the table only draws ~30 — which keeps
// the snapshot payload small.
function downsample(arr, n) {
  if (!Array.isArray(arr) || arr.length <= n) return arr || [];
  const step = (arr.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => arr[Math.round(i * step)]);
}

// Build the bootstrap snapshot string: top-100 markets + usd/eur/gbp spot prices for
// every id in the table, so any converter/P&L selection is answered without upstream.
async function buildSnapshot(env) {
  const markets = JSON.parse(await cgFetch(MARKETS_PATH, env));
  const ids = [...new Set(markets.map((c) => c.id))].sort();
  const pricePath = `/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd,eur,gbp`;
  const prices = JSON.parse(await cgFetch(pricePath, env));
  return JSON.stringify({
    t: Date.now(),
    markets: markets.map((c) => ({
      ...c,
      sparkline_in_7d: { price: downsample(c.sparkline_in_7d?.price, 40) },
    })),
    prices,
  });
}

// Isolate-level memo of the parsed snapshot so /simple/price slicing doesn't re-parse
// ~200 KB of JSON on every request (free plan CPU budget is small).
let snapMemo = { raw: null, parsed: null };

async function getSnapshot(env, ctx) {
  let raw = await env.CG.get('bootstrap', { cacheTtl: 60 });
  if (!raw) {
    // Cold start (first deploy / KV flush): build on demand, persist in the background.
    raw = await buildSnapshot(env);
    ctx.waitUntil(env.CG.put('bootstrap', raw));
  }
  if (snapMemo.raw !== raw) snapMemo = { raw, parsed: JSON.parse(raw) };
  return snapMemo;
}

// Spot-price requests for warmed coins are sliced from the snapshot — no upstream
// call, so they can never rate-limit. Mirrors Express's sliceWarmPrices().
function sliceWarmPrices(cgPath, snap) {
  if (!snap?.parsed || Date.now() - snap.parsed.t > 90_000) return null;
  const ids = (new URL('http://x' + cgPath).searchParams.get('ids') || '').split(',').filter(Boolean);
  if (!ids.length || !ids.every((id) => snap.parsed.prices[id])) return null;
  return Object.fromEntries(ids.map((id) => [id, snap.parsed.prices[id]]));
}

async function handleCg(cgPath, env, ctx) {
  const rule = CG_TTLS.find(([re]) => re.test(cgPath));
  if (!rule) return json({ error: 'unsupported path' }, 400);
  const ttl = rule[1];

  // Snapshot-served paths first — these cover ~all of a normal visit.
  try {
    if (cgPath.startsWith('/simple/price?')) {
      const snap = await getSnapshot(env, ctx);
      const warm = sliceWarmPrices(cgPath, snap);
      if (warm) return json(warm, 200, 30);
    } else if (cgPath === MARKETS_PATH) {
      const snap = await getSnapshot(env, ctx);
      if (snap?.parsed && Date.now() - snap.parsed.t < 120_000)
        return json(snap.parsed.markets, 200, 30);
    }
  } catch {
    // Snapshot unavailable — fall through to the generic proxy.
  }

  // Generic proxy: per-PoP fresh cache at the rule TTL, plus a 24h stale twin that is
  // served whenever upstream fails (stale beats nothing — same policy as Express).
  const cache = caches.default;
  const freshKey = new Request('https://cg.reelgrab.internal/fresh' + cgPath);
  const staleKey = new Request('https://cg.reelgrab.internal/stale' + cgPath);
  const hit = await cache.match(freshKey);
  if (hit) return hit;

  try {
    const body = await cgFetch(cgPath, env);
    ctx.waitUntil(
      Promise.all([
        cache.put(freshKey, json(body, 200, ttl)),
        cache.put(staleKey, json(body, 200, 24 * 60 * 60)),
      ]),
    );
    return json(body, 200, Math.min(ttl, 60));
  } catch (err) {
    const stale = await cache.match(staleKey);
    if (stale) return stale;
    return json({ error: 'market data unavailable' }, err.status === 429 ? 429 : 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') return json({ ok: true });

    if (pathname === '/api/bootstrap') {
      // Edge-cached for 50s so even a flood of visitors costs ~1 KV read per PoP/min.
      const cache = caches.default;
      const key = new Request(url.origin + '/api/bootstrap');
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const snap = await getSnapshot(env, ctx);
        const res = json(snap.raw, 200, 50);
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (err) {
        console.error('bootstrap unavailable:', err?.stack || err);
        return json({ error: 'snapshot unavailable' }, 502);
      }
    }

    if (pathname.startsWith('/api/cg/')) {
      return handleCg(pathname.slice('/api/cg'.length) + url.search, env, ctx);
    }

    if (pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    // Non-API, non-asset paths: hand to the asset layer, whose
    // single-page-application mode serves index.html (the old `app.get('*')`).
    return env.ASSETS.fetch(request);
  },

  // Cron (*/2 min): keep the KV snapshot fresh so no visitor ever waits on CoinGecko.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      buildSnapshot(env)
        .then((raw) => env.CG.put('bootstrap', raw))
        .catch(() => {/* keep the previous snapshot; next tick retries */}),
    );
  },
};
