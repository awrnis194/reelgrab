// Profit / loss calculator. Sell price prefills with the selected coin's live
// price (editable). Quantity ⇄ invested-amount toggle; optional per-side fee.

import { fmtFiat, fmtPct, parseAmount } from '../lib/format.js';
import { createCoinSelect } from './coinSelect.js';

export function initPnl({ coins }) {
  const buyEl = document.getElementById('pnlBuy');
  const sellEl = document.getElementById('pnlSell');
  const qtyEl = document.getElementById('pnlQty');
  const feeEl = document.getElementById('pnlFee');
  const qtyLabel = document.getElementById('pnlQtyLabel');
  const toggle = document.getElementById('pnlModeToggle');

  const out = {
    pl: document.getElementById('pnlPL'),
    pct: document.getElementById('pnlPct'),
    total: document.getElementById('pnlTotal'),
    fees: document.getElementById('pnlFees'),
  };

  let investedMode = false;
  let sellTouched = false;
  let marketData = coins;

  const coinSelect = createCoinSelect(document.getElementById('pnlCoin'), {
    coins,
    value: 'bitcoin',
    label: 'Coin for profit/loss',
    onChange: () => {
      sellTouched = false;
      prefillSell();
      compute();
    },
  });

  function livePrice(id) {
    return marketData.find((c) => c.id === id)?.current_price ?? null;
  }

  function prefillSell() {
    if (sellTouched) return;
    const p = livePrice(coinSelect.value);
    if (p != null) sellEl.value = String(p);
  }

  function paint(el, v, fmt) {
    el.textContent = fmt(v);
    el.classList.toggle('is-gain', v > 0);
    el.classList.toggle('is-loss', v < 0);
  }

  function compute() {
    const buy = parseAmount(buyEl.value);
    const sell = parseAmount(sellEl.value);
    const third = parseAmount(qtyEl.value);
    const feePct = parseAmount(feeEl.value);
    const fee = Number.isFinite(feePct) && feePct > 0 ? feePct / 100 : 0;

    if (!Number.isFinite(buy) || buy <= 0 || !Number.isFinite(sell) || !Number.isFinite(third) || third <= 0) {
      for (const el of Object.values(out)) {
        el.textContent = '—';
        el.classList.remove('is-gain', 'is-loss');
      }
      return;
    }

    const qty = investedMode ? third / buy : third;
    const cost = buy * qty;
    const proceeds = sell * qty;
    const fees = cost * fee + proceeds * fee;
    const pl = proceeds - cost - fees;
    const pct = (pl / cost) * 100;

    paint(out.pl, pl, (v) => fmtFiat(v));
    paint(out.pct, pct, fmtPct);
    out.total.textContent = fmtFiat(proceeds - proceeds * fee);
    out.fees.textContent = fmtFiat(fees);
  }

  toggle.addEventListener('click', () => {
    investedMode = !investedMode;
    qtyLabel.textContent = investedMode ? 'Invested (USD)' : 'Quantity';
    toggle.textContent = investedMode ? 'use quantity' : 'use invested $';
    toggle.setAttribute('aria-pressed', String(investedMode));
    compute();
  });

  sellEl.addEventListener('input', () => {
    sellTouched = true;
    compute();
  });
  for (const el of [buyEl, qtyEl, feeEl]) el.addEventListener('input', compute);

  prefillSell();

  return {
    setCoin(id) {
      coinSelect.set(id);
      sellTouched = false;
      prefillSell();
      compute();
    },
    update(markets) {
      marketData = markets;
      coinSelect.setCoins(markets);
      prefillSell();
      compute();
    },
  };
}
