// Detail chart: official TradingView Advanced Chart embed. Pulls its own data
// from TradingView (no CoinGecko dependency), with built-in symbol search,
// interval picker and date-range buttons. We re-inject the widget when a coin
// is chosen here or clicked in the market table.

import { createCoinSelect } from './coinSelect.js';

const EMBED_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

// Coins whose `${SYMBOL}USDT` pair doesn't exist on Binance, or that track
// another asset. The widget's own search covers anything not mapped here.
const SYMBOL_EXCEPTIONS = {
  tether: 'KRAKEN:USDTUSD',
  'usd-coin': 'KRAKEN:USDCUSD',
  'staked-ether': 'BINANCE:ETHUSDT',
  weth: 'BINANCE:ETHUSDT',
  'wrapped-bitcoin': 'BINANCE:BTCUSDT',
  'wrapped-steth': 'BINANCE:ETHUSDT',
  dai: 'KRAKEN:DAIUSD',
  'leo-token': 'BITFINEX:LEOUSD',
  monero: 'KRAKEN:XMRUSD',
};

export function initTvChart({ coins }) {
  const host = document.getElementById('tvChart');
  let marketData = coins;

  const select = createCoinSelect(document.getElementById('tvCoin'), {
    coins,
    value: 'bitcoin',
    label: 'Coin to chart',
    onChange: (id) => render(id),
  });

  function tvSymbol(id) {
    const mapped = SYMBOL_EXCEPTIONS[id];
    if (mapped) return mapped;
    const coin = marketData.find((c) => c.id === id);
    if (!coin) return 'BINANCE:BTCUSDT';
    // No exchange prefix: TradingView resolves the pair on whichever exchange
    // lists it (forcing BINANCE: 404'd coins like USDY that trade elsewhere).
    return `${coin.symbol.toUpperCase()}USDT`;
  }

  function render(id) {
    host.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '100%';
    container.style.width = '100%';

    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.height = '100%';
    widget.style.width = '100%';
    container.appendChild(widget);

    const script = document.createElement('script');
    script.src = EMBED_SRC;
    script.async = true;
    // The embed script reads its config from its own text content.
    script.textContent = JSON.stringify({
      autosize: true,
      symbol: tvSymbol(id),
      interval: '60',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      withdateranges: true,
      allow_symbol_change: true,
      hide_side_toolbar: true,
      backgroundColor: 'rgba(20, 28, 36, 1)',
      gridColor: 'rgba(38, 51, 63, 0.5)',
      support_host: 'https://www.tradingview.com',
    });
    container.appendChild(script);
    host.appendChild(container);
  }

  render('bitcoin');

  return {
    setCoin(id) {
      if (id === select.value) return;
      select.set(id);
      render(id);
    },
    update(markets) {
      marketData = markets;
      select.setCoins(markets);
    },
  };
}
