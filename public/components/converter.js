// Hero converter: crypto ↔ fiat and crypto ↔ crypto, live, with swap.

import { getSimplePrice, isFiat, FIATS } from '../lib/api.js';
import { fmtFiat, fmtCrypto, parseAmount, animateNumber, debounce } from '../lib/format.js';
import { createCoinSelect } from './coinSelect.js';

export function initConverter({ coins, onError }) {
  const amountEl = document.getElementById('convAmount');
  const resultEl = document.getElementById('convResult');
  const rateEl = document.getElementById('convRate');
  let lastResult = NaN;

  const from = createCoinSelect(document.getElementById('convFrom'), {
    coins,
    value: 'bitcoin',
    withFiats: true,
    label: 'Convert from',
    onChange: () => compute(),
  });
  const to = createCoinSelect(document.getElementById('convTo'), {
    coins,
    value: 'usd',
    withFiats: true,
    label: 'Convert to',
    onChange: () => compute(),
  });

  function symbolOf(id) {
    if (isFiat(id)) return FIATS.find((f) => f.id === id).symbol;
    return (coins.find((c) => c.id === id)?.symbol || id).toUpperCase();
  }

  /** Price of one unit of `id` in usd/eur/gbp, from a simple/price payload. */
  function unit(prices, id, vs) {
    if (isFiat(id)) {
      // Fiat→fiat goes through USD using any priced coin as the bridge.
      const bridge = Object.values(prices)[0];
      if (!bridge) return null;
      return bridge[vs] / bridge[id];
    }
    return prices[id]?.[vs] ?? null;
  }

  async function compute() {
    const amount = parseAmount(amountEl.value);
    const fromId = from.value;
    const toId = to.value;
    if (!Number.isFinite(amount)) {
      resultEl.textContent = '—';
      rateEl.textContent = '';
      return;
    }

    const cryptoIds = [fromId, toId].filter((id) => !isFiat(id));
    // Both fiat: still need one coin as a USD bridge for the cross rate.
    if (!cryptoIds.length) cryptoIds.push('bitcoin');

    try {
      const prices = await getSimplePrice(cryptoIds);
      let rate; // value of 1 `from` in `to`
      if (isFiat(toId)) {
        rate = unit(prices, fromId, toId);
      } else {
        const fromUsd = unit(prices, fromId, 'usd');
        const toUsd = unit(prices, toId, 'usd');
        rate = fromUsd != null && toUsd ? fromUsd / toUsd : null;
      }
      if (rate == null) throw new Error('no rate');

      const result = amount * rate;
      const fmt = isFiat(toId)
        ? (v) => fmtFiat(v, toId)
        : (v) => fmtCrypto(v, symbolOf(toId));
      animateNumber(resultEl, lastResult, result, fmt);
      lastResult = result;
      rateEl.textContent = `1 ${symbolOf(fromId)} = ${
        isFiat(toId) ? fmtFiat(rate, toId) : fmtCrypto(rate, symbolOf(toId))
      }`;
    } catch (err) {
      rateEl.textContent = 'Rates unavailable right now — retrying shortly.';
      onError?.(err);
    }
  }

  amountEl.addEventListener('input', debounce(compute, 300));
  document.getElementById('convSwap').addEventListener('click', () => {
    const a = from.value;
    from.set(to.value);
    to.set(a);
    compute();
  });

  compute();

  return {
    refresh: compute,
    setFrom(id) {
      from.set(id);
      compute();
    },
    setCoins(next) {
      from.setCoins(next);
      to.setCoins(next);
    },
  };
}
