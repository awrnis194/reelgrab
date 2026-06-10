// Detail chart: TradingView Lightweight Charts (lazy-loaded from CDN) with a
// 24h/7d/30d/1y timeframe switch, header stats, skeleton and error states.

import { getMarketChart } from '../lib/api.js';
import { fmtFiat, fmtPct } from '../lib/format.js';

const LIB_URL = 'https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js';

let libPromise = null;
function loadLib() {
  libPromise ??= new Promise((resolve, reject) => {
    if (window.LightweightCharts) return resolve(window.LightweightCharts);
    const s = document.createElement('script');
    s.src = LIB_URL;
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => {
      libPromise = null; // allow retry to re-attempt the script load
      reject(new Error('chart lib failed to load'));
    };
    document.head.appendChild(s);
  });
  return libPromise;
}

export function initChart({ coins }) {
  const host = document.getElementById('chartCanvas');
  const skeleton = document.getElementById('chartSkeleton');
  const errorBox = document.getElementById('chartError');
  const titleEl = document.querySelector('.detail__coin');
  const priceEl = document.getElementById('detailPrice');
  const changeEl = document.getElementById('detailChange');
  const rangeEl = document.getElementById('detailRange');
  const tfSwitch = document.getElementById('tfSwitch');

  let marketData = coins;
  let coinId = 'bitcoin';
  let days = 7;
  let chart = null;
  let series = null;
  let seq = 0;

  function setLoading(loading) {
    skeleton.hidden = !loading;
    skeleton.style.display = loading ? '' : 'none';
  }

  function showError(show) {
    errorBox.hidden = !show;
  }

  function paintHeader() {
    const c = marketData.find((x) => x.id === coinId);
    if (!c) return;
    titleEl.textContent = c.name;
    priceEl.textContent = fmtFiat(c.current_price);
    const ch = c.price_change_percentage_24h;
    changeEl.textContent = `${fmtPct(ch)} (24h)`;
    changeEl.classList.toggle('is-gain', ch >= 0);
    changeEl.classList.toggle('is-loss', ch < 0);
  }

  async function ensureChart() {
    if (chart) return;
    const LWC = await loadLib();
    chart = LWC.createChart(host, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8da0ad',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(38, 51, 63, 0.4)' },
        horzLines: { color: 'rgba(38, 51, 63, 0.4)' },
      },
      rightPriceScale: { borderColor: '#26333f' },
      timeScale: { borderColor: '#26333f', timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: '#14807b' }, vertLine: { labelBackgroundColor: '#14807b' } },
      autoSize: true,
      handleScroll: false,
      handleScale: false,
    });
    series = chart.addAreaSeries({
      lineColor: '#1fb8b0',
      topColor: 'rgba(31, 184, 176, 0.25)',
      bottomColor: 'rgba(31, 184, 176, 0.0)',
      lineWidth: 2,
      priceLineVisible: false,
    });
  }

  async function load() {
    const mySeq = ++seq;
    setLoading(true);
    showError(false);
    paintHeader();
    try {
      const [, data] = await Promise.all([ensureChart(), getMarketChart(coinId, days)]);
      if (mySeq !== seq) return;
      const points = (data.prices || []).map(([t, v]) => ({ time: Math.floor(t / 1000), value: v }));
      if (!points.length) throw new Error('empty series');

      series.setData(points);
      chart.timeScale().fitContent();

      const values = points.map((p) => p.value);
      const hi = Math.max(...values);
      const lo = Math.min(...values);
      const label = { 1: '24h', 7: '7d', 30: '30d', 365: '1y' }[days];
      rangeEl.textContent = `${label} range  ${fmtFiat(lo)} – ${fmtFiat(hi)}`;
      setLoading(false);
    } catch {
      if (mySeq !== seq) return;
      setLoading(false);
      showError(true);
    }
  }

  tfSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg__btn');
    if (!btn) return;
    days = Number(btn.dataset.days);
    tfSwitch.querySelectorAll('.seg__btn').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('seg__btn--active', active);
      b.setAttribute('aria-pressed', String(active));
    });
    load();
  });

  document.getElementById('chartRetry').addEventListener('click', load);

  load();

  return {
    setCoin(id) {
      if (id === coinId) return;
      coinId = id;
      load();
    },
    update(markets) {
      marketData = markets;
      paintHeader();
    },
  };
}
