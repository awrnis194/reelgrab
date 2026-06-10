// App orchestration: load markets once, wire components together, poll on 60s.

import { getMarkets, status } from './lib/api.js';
import { fmtFiat, timeAgo } from './lib/format.js';
import { initConverter } from './components/converter.js';
import { initPnl } from './components/pnl.js';
import { initWhatIf } from './components/whatIf.js';
import { initMarketTable } from './components/marketTable.js';
import { initTvChart } from './components/tvChart.js';

const POLL_MS = 60_000;

const updatedEl = document.getElementById('updatedAgo');

setInterval(() => {
  updatedEl.textContent = timeAgo(status.lastUpdated);
}, 5000);

function paintTicker(markets) {
  for (const el of document.querySelectorAll('[data-ticker]')) {
    const coin = markets.find((c) => c.id === el.dataset.ticker);
    if (coin) el.querySelector('.ticker__price').textContent = fmtFiat(coin.current_price);
  }
}

// Known majors so every control works the instant the page opens, even if the
// market feed is down. Real data replaces this as soon as it arrives.
const FALLBACK_COINS = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
  { id: 'tether', symbol: 'usdt', name: 'Tether' },
  { id: 'ripple', symbol: 'xrp', name: 'XRP' },
  { id: 'binancecoin', symbol: 'bnb', name: 'BNB' },
  { id: 'solana', symbol: 'sol', name: 'Solana' },
  { id: 'usd-coin', symbol: 'usdc', name: 'USDC' },
  { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin' },
  { id: 'cardano', symbol: 'ada', name: 'Cardano' },
  { id: 'tron', symbol: 'trx', name: 'TRON' },
  { id: 'chainlink', symbol: 'link', name: 'Chainlink' },
  { id: 'avalanche-2', symbol: 'avax', name: 'Avalanche' },
  { id: 'polkadot', symbol: 'dot', name: 'Polkadot' },
  { id: 'litecoin', symbol: 'ltc', name: 'Litecoin' },
];

function boot() {
  // Everything renders immediately — no component waits on the market feed.
  const converter = initConverter({ coins: FALLBACK_COINS });
  const pnl = initPnl({ coins: FALLBACK_COINS });
  const whatIf = initWhatIf({ coins: FALLBACK_COINS });
  const chart = initTvChart({ coins: FALLBACK_COINS });
  const table = initMarketTable({
    onSelect(id) {
      chart.setCoin(id);
      converter.setFrom(id);
      pnl.setCoin(id);
      document.getElementById('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });
  table.setSelected('bitcoin');

  let haveData = false;

  async function refresh() {
    try {
      const markets = await getMarkets();
      haveData = true;
      paintTicker(markets);
      table.update(markets);
      pnl.update(markets);
      whatIf.update(markets);
      chart.update(markets);
      converter.setCoins(markets);
      converter.refresh();
    } catch {
      if (!haveData) {
        document.getElementById('marketBody').innerHTML =
          `<tr class="market-table__empty"><td colspan="7">Couldn't reach the market feed — retrying automatically.</td></tr>`;
      }
      // With data already on screen, a failed poll just keeps the old values;
      // the "rates delayed" badge is driven by onStatus.
    }
  }

  refresh().then(() => {
    // Until the first successful load, retry briskly; then settle into polling.
    const fast = setInterval(async () => {
      if (haveData) return clearInterval(fast);
      await refresh();
    }, 20_000);
  });
  setInterval(refresh, POLL_MS);
}

boot();
