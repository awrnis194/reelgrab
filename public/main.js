// App orchestration: load markets once, wire components together, poll on 60s.

import { getMarkets, onStatus, status } from './lib/api.js';
import { fmtFiat, timeAgo } from './lib/format.js';
import { initConverter } from './components/converter.js';
import { initPnl } from './components/pnl.js';
import { initWhatIf } from './components/whatIf.js';
import { initMarketTable } from './components/marketTable.js';
import { initTvChart } from './components/tvChart.js';

const POLL_MS = 60_000;

const updatedEl = document.getElementById('updatedAgo');
const delayedEl = document.getElementById('delayedBadge');

onStatus((s) => {
  delayedEl.hidden = !s.delayed;
});
setInterval(() => {
  updatedEl.textContent = timeAgo(status.lastUpdated);
}, 5000);

function paintTicker(markets) {
  for (const el of document.querySelectorAll('[data-ticker]')) {
    const coin = markets.find((c) => c.id === el.dataset.ticker);
    if (coin) el.querySelector('.ticker__price').textContent = fmtFiat(coin.current_price);
  }
}

async function boot() {
  let markets;
  try {
    markets = await getMarkets();
  } catch {
    document.getElementById('marketBody').innerHTML =
      `<tr class="market-table__empty"><td colspan="7">Couldn't reach the market API — it will retry automatically.</td></tr>`;
    setTimeout(boot, 45_000);
    return;
  }

  paintTicker(markets);
  updatedEl.textContent = timeAgo(status.lastUpdated);

  const converter = initConverter({ coins: markets });
  const pnl = initPnl({ coins: markets });
  const whatIf = initWhatIf({ coins: markets });
  const chart = initTvChart({ coins: markets });
  const table = initMarketTable({
    onSelect(id) {
      chart.setCoin(id);
      converter.setFrom(id);
      pnl.setCoin(id);
      document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });
  table.update(markets);
  table.setSelected('bitcoin');

  // 60s poll — cache TTLs make this exactly one markets call per cycle, and a
  // failed poll silently serves the previous data (never blanks the UI).
  setInterval(async () => {
    try {
      const next = await getMarkets();
      paintTicker(next);
      table.update(next);
      pnl.update(next);
      whatIf.update(next);
      chart.update(next);
      converter.setCoins(next);
      converter.refresh();
    } catch {
      // status badge already shows "rates delayed" via onStatus
    }
  }, POLL_MS);
}

boot();
