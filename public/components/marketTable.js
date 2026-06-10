// Market table: top 50 coins with price, colored 24h %, 7d sparkline, cap and
// volume. Row click selects the coin for the detail chart + converter.

import { fmtFiat, fmtPct, fmtCompact } from '../lib/format.js';

const SHOW = 50;

/** Downsampled inline-SVG sparkline from the 7d price series. */
function sparkline(prices, gain) {
  if (!prices?.length) return '';
  const step = Math.max(1, Math.floor(prices.length / 30));
  const pts = prices.filter((_, i) => i % step === 0);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 120;
  const h = 36;
  const d = pts
    .map((p, i) => {
      const x = ((i / (pts.length - 1)) * (w - 2) + 1).toFixed(1);
      const y = (h - 3 - ((p - min) / span) * (h - 6)).toFixed(1);
      return `${i ? 'L' : 'M'}${x},${y}`;
    })
    .join('');
  const color = gain ? 'var(--gain)' : 'var(--loss)';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" /></svg>`;
}

export function initMarketTable({ onSelect }) {
  const body = document.getElementById('marketBody');
  const search = document.getElementById('marketSearch');
  let rows = [];
  let selectedId = null;

  function render(markets) {
    const q = search.value.trim().toLowerCase();
    rows = markets
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q))
      .slice(0, SHOW);

    if (!rows.length) {
      body.innerHTML = `<tr class="market-table__empty"><td colspan="7">No coins match “${search.value.replace(/[<>&"]/g, '')}”.</td></tr>`;
      return;
    }

    body.innerHTML = rows
      .map((c) => {
        const ch = c.price_change_percentage_24h;
        const week = c.sparkline_in_7d?.price;
        const weekGain = week?.length ? week[week.length - 1] >= week[0] : ch >= 0;
        return `<tr class="fade-in${c.id === selectedId ? ' is-selected' : ''}" data-id="${c.id}">
          <td class="t-right muted">${c.market_cap_rank ?? '—'}</td>
          <td><span class="coin-cell">
            <button type="button" aria-label="Select ${c.name}">
              <img src="${c.image}" alt="" loading="lazy" width="20" height="20" />
              <span>${c.name}</span><span class="sym">${c.symbol.toUpperCase()}</span>
            </button>
          </span></td>
          <td class="t-right">${fmtFiat(c.current_price)}</td>
          <td class="t-right ${ch >= 0 ? 'is-gain' : 'is-loss'}">${fmtPct(ch)}</td>
          <td class="t-center">${sparkline(week, weekGain)}</td>
          <td class="t-right">${fmtCompact(c.market_cap)}</td>
          <td class="t-right">${fmtCompact(c.total_volume)}</td>
        </tr>`;
      })
      .join('');
  }

  let lastMarkets = [];

  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    selectedId = tr.dataset.id;
    body.querySelectorAll('tr').forEach((r) => r.classList.toggle('is-selected', r.dataset.id === selectedId));
    onSelect(selectedId);
  });

  search.addEventListener('input', () => render(lastMarkets));

  return {
    update(markets) {
      lastMarkets = markets;
      render(markets);
    },
    setSelected(id) {
      selectedId = id;
      body.querySelectorAll('tr').forEach((r) => r.classList.toggle('is-selected', r.dataset.id === id));
    },
  };
}
