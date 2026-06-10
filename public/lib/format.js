// Number formatting helpers. Everything that shows a value goes through here
// so decimals and tabular alignment stay consistent.

const SIGNS = { usd: '$', eur: '€', gbp: '£' };

/** Fiat money. Small prices get more precision so sub-cent coins read sanely. */
export function fmtFiat(value, currency = 'usd') {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const opts =
    abs >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumSignificantDigits: 4 };
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    ...opts,
  }).format(value);
}

/** Crypto amounts: trim trailing noise, keep significance for tiny values. */
export function fmtCrypto(value, symbol = '') {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  const n = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: digits,
  }).format(value);
  return symbol ? `${n} ${symbol.toUpperCase()}` : n;
}

/** Signed percent with 2 decimals: "+4.21%" / "−1.08%". */
export function fmtPct(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/** Compact large numbers for caps/volumes: "$1.23T", "$845.2B". */
export function fmtCompact(value, currency = 'usd') {
  if (value == null || !Number.isFinite(value)) return '—';
  const n = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
  return (SIGNS[currency] ?? '') + n;
}

/** "12s ago" / "3m ago" for the refresh indicator. */
export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.floor(s / 60)}m ago`;
}

/** Parse a user-typed decimal; returns NaN for junk, accepts "1,234.5". */
export function parseAmount(str) {
  if (typeof str !== 'string') return NaN;
  const cleaned = str.replace(/,/g, '').trim();
  if (cleaned === '') return NaN;
  return Number(cleaned);
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Tween a numeric value into an element. Skips animation if reduced motion. */
export function animateNumber(el, from, to, fmt, ms = 350) {
  if (reducedMotion.matches || !Number.isFinite(from) || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const start = performance.now();
  cancelAnimationFrame(el._tween);
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) el._tween = requestAnimationFrame(step);
  };
  el._tween = requestAnimationFrame(step);
}

/** Debounce helper for inputs. */
export function debounce(fn, ms = 300) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}
