// Market data layer. Requests go to our own server's /api/cg proxy (which
// holds a shared server-side CoinGecko cache), then through a localStorage
// cache with a TTL and a backoff so failures never turn into hammering loops.
// On failure we serve the last cached value (however old) and flag "delayed".

const BASE = '/api/cg';
const CACHE_PREFIX = 'rg:';

const TTL = {
  price: 60_000,
  markets: 60_000,
  chart: 5 * 60_000,
  history: 24 * 60 * 60_000,
};

// ── status pub/sub (drives "updated Xs ago" + "rates delayed" badge) ────────
const listeners = new Set();
export const status = { lastUpdated: null, delayed: false };

export function onStatus(fn) {
  listeners.add(fn);
  fn(status);
}

function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of listeners) fn(status);
}

// ── bootstrap payload ────────────────────────────────────────────────────────
// The server inlines a fresh markets+prices snapshot into index.html, so the
// first paint needs zero API round-trips. Treated as live for 90s, after
// which the normal fetch path takes over.
const boot = typeof window !== 'undefined' ? window.__BOOTSTRAP__ : null;
const BOOT_MAX_AGE = 90_000;

function fromBoot(kind) {
  if (!boot || Date.now() - boot.t > BOOT_MAX_AGE) return null;
  return boot[kind] || null;
}

// ── localStorage cache (tolerates quota errors / private mode) ──────────────
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
  } catch {
    // Quota full or storage unavailable — fine, we just lose the cache.
  }
}

// ── backoff: after a 429/network error, don't hit the API again for a bit ───
let backoffUntil = 0;
let backoffMs = 30_000;

function noteFailure(isRateLimit) {
  backoffUntil = Date.now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
  setStatus({ delayed: true });
  if (isRateLimit) console.warn('CoinGecko rate limit hit — backing off');
}

function noteSuccess() {
  backoffMs = 30_000;
  setStatus({ delayed: false, lastUpdated: Date.now() });
}

// In-flight dedupe so two components asking for the same thing share one fetch.
const inflight = new Map();

async function cachedFetch(path, ttl) {
  const hit = cacheGet(path);
  const fresh = hit && Date.now() - hit.t < ttl;
  if (fresh) return hit.data;

  // In a backoff window: serve stale rather than poking the API again.
  if (Date.now() < backoffUntil) {
    if (hit) return hit.data;
    throw new Error('Rate limited and no cached data yet');
  }

  if (inflight.has(path)) return inflight.get(path);

  const p = (async () => {
    try {
      const res = await fetch(BASE + path);
      if (!res.ok) {
        noteFailure(res.status === 429);
        if (hit) return hit.data;
        throw new Error(`CoinGecko ${res.status}`);
      }
      const data = await res.json();
      cacheSet(path, data);
      noteSuccess();
      return data;
    } catch (err) {
      if (!(err.message || '').startsWith('CoinGecko')) noteFailure(false);
      if (hit) return hit.data;
      throw err;
    } finally {
      inflight.delete(path);
    }
  })();

  inflight.set(path, p);
  return p;
}

// ── public API ───────────────────────────────────────────────────────────────
export const FIATS = [
  { id: 'usd', symbol: 'USD', name: 'US Dollar', sign: '$', color: '#3fbf6f' },
  { id: 'eur', symbol: 'EUR', name: 'Euro', sign: '€', color: '#4d7cfe' },
  { id: 'gbp', symbol: 'GBP', name: 'British Pound', sign: '£', color: '#8e6cf1' },
];

export function isFiat(id) {
  return FIATS.some((f) => f.id === id);
}

/** Top 100 coins by market cap, with 7d sparkline and 24h change. */
export function getMarkets() {
  const m = fromBoot('markets');
  if (m) {
    setStatus({ delayed: false, lastUpdated: boot.t });
    return Promise.resolve(m);
  }
  return cachedFetch(
    '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=24h',
    TTL.markets,
  );
}

/** Spot prices for a set of coin ids in usd/eur/gbp. */
export function getSimplePrice(ids) {
  const unique = [...new Set(ids)].sort();
  const p = fromBoot('prices');
  if (p && unique.every((id) => p[id])) {
    return Promise.resolve(Object.fromEntries(unique.map((id) => [id, p[id]])));
  }
  return cachedFetch(
    `/simple/price?ids=${encodeURIComponent(unique.join(','))}&vs_currencies=usd,eur,gbp`,
    TTL.price,
  );
}

/** Price series for the detail chart. days: 1 | 7 | 30 | 365 */
export function getMarketChart(id, days) {
  return cachedFetch(
    `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`,
    TTL.chart,
  );
}

/** Historical snapshot for the what-if calculator. date: JS Date */
export function getHistory(id, date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return cachedFetch(
    `/coins/${encodeURIComponent(id)}/history?date=${dd}-${mm}-${yyyy}`,
    TTL.history,
  );
}
