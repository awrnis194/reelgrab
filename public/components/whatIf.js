// "What if I'd invested" — historical price via /coins/{id}/history, compares
// units bought then against today's value.

import { getHistory } from '../lib/api.js';
import { fmtFiat, fmtPct, fmtCrypto, parseAmount, debounce } from '../lib/format.js';
import { createCoinSelect } from './coinSelect.js';

export function initWhatIf({ coins }) {
  const amountEl = document.getElementById('wiAmount');
  const dateEl = document.getElementById('wiDate');
  const statusEl = document.getElementById('wiStatus');
  const statsEl = document.getElementById('wiStats');
  const out = {
    now: document.getElementById('wiNow'),
    ret: document.getElementById('wiReturn'),
    units: document.getElementById('wiUnits'),
    then: document.getElementById('wiThen'),
  };

  let marketData = coins;
  let seq = 0;

  const coinSelect = createCoinSelect(document.getElementById('wiCoin'), {
    coins,
    value: 'bitcoin',
    label: 'Coin for what-if',
    onChange: () => compute(),
  });

  // Date input: any past date up to yesterday, back to early Bitcoin pricing.
  const yesterday = new Date(Date.now() - 86_400_000);
  dateEl.max = yesterday.toISOString().slice(0, 10);
  dateEl.min = '2013-04-28';
  const yearAgo = new Date(Date.now() - 365 * 86_400_000);
  dateEl.value = yearAgo.toISOString().slice(0, 10);

  function showStatus(msg) {
    statsEl.hidden = true;
    statusEl.hidden = false;
    statusEl.textContent = msg;
  }

  async function compute() {
    const amount = parseAmount(amountEl.value);
    const dateStr = dateEl.value;
    const id = coinSelect.value;
    if (!Number.isFinite(amount) || amount <= 0 || !dateStr) {
      showStatus('Pick a coin, an amount and a past date.');
      return;
    }
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.getTime()) || date > new Date()) {
      showStatus('That date is in the future — pick a past one.');
      return;
    }

    const mySeq = ++seq;
    showStatus('Looking up the historical price…');
    try {
      const hist = await getHistory(id, date);
      if (mySeq !== seq) return; // a newer query superseded this one
      const priceThen = hist?.market_data?.current_price?.usd;
      const coin = marketData.find((c) => c.id === id);
      const priceNow = coin?.current_price;
      if (!priceThen || !priceNow) {
        showStatus(`No price data for ${coin?.name ?? id} on that date — try a later one.`);
        return;
      }

      const units = amount / priceThen;
      const valueNow = units * priceNow;
      const pct = ((valueNow - amount) / amount) * 100;

      statusEl.hidden = true;
      statsEl.hidden = false;
      out.now.textContent = `${fmtFiat(valueNow)} (${(valueNow / amount).toFixed(2)}×)`;
      out.now.classList.toggle('is-gain', valueNow >= amount);
      out.now.classList.toggle('is-loss', valueNow < amount);
      out.ret.textContent = fmtPct(pct);
      out.ret.classList.toggle('is-gain', pct >= 0);
      out.ret.classList.toggle('is-loss', pct < 0);
      out.units.textContent = fmtCrypto(units, coin.symbol);
      out.then.textContent = fmtFiat(priceThen);
    } catch {
      if (mySeq !== seq) return;
      showStatus("Couldn't fetch the historical price — try again in a minute.");
    }
  }

  const debounced = debounce(compute, 400);
  amountEl.addEventListener('input', debounced);
  dateEl.addEventListener('change', compute);

  compute();

  return {
    update(markets) {
      marketData = markets;
      coinSelect.setCoins(markets);
    },
  };
}
