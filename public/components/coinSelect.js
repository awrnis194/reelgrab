// Searchable select for coins (and optionally fiats). Renders a button that
// opens a panel with a filter input and a keyboard-navigable listbox.

import { FIATS } from '../lib/api.js';

let uid = 0;

/**
 * @param {HTMLElement} mount
 * @param {{ coins: Array, value: string, withFiats?: boolean, label: string,
 *           onChange: (id: string) => void }} opts
 * Returned handle: { get value(), set(id), setCoins(coins) }
 */
export function createCoinSelect(mount, opts) {
  const id = `combo-${++uid}`;
  let { coins } = opts;
  let value = opts.value;
  let open = false;
  let activeIndex = -1;
  let filtered = [];

  mount.classList.add('combo');
  mount.innerHTML = `
    <button type="button" class="combo__btn" id="${id}-btn"
      aria-haspopup="listbox" aria-expanded="false" aria-label="${opts.label}">
      <img class="combo__icon" alt="" hidden />
      <span class="combo__sym"></span>
      <span class="combo__name"></span>
      <svg class="combo__caret" viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
        <path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <div class="combo__panel" hidden>
      <input class="combo__search" type="text" placeholder="Search…" role="combobox"
        aria-expanded="true" aria-controls="${id}-list" aria-autocomplete="list" autocomplete="off" />
      <ul class="combo__list" id="${id}-list" role="listbox" aria-label="${opts.label}"></ul>
    </div>
  `;

  const btn = mount.querySelector('.combo__btn');
  const panel = mount.querySelector('.combo__panel');
  const search = mount.querySelector('.combo__search');
  const list = mount.querySelector('.combo__list');
  const icon = mount.querySelector('.combo__icon');
  const sym = mount.querySelector('.combo__sym');
  const name = mount.querySelector('.combo__name');

  function allOptions() {
    const coinOpts = coins.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      image: c.image,
      kind: 'crypto',
    }));
    if (!opts.withFiats) return coinOpts;
    const fiatOpts = FIATS.map((f) => ({ ...f, kind: 'fiat' }));
    return [...fiatOpts, ...coinOpts];
  }

  function find(idWanted) {
    return allOptions().find((o) => o.id === idWanted);
  }

  function renderButton() {
    const o = find(value);
    if (!o) return;
    sym.textContent = o.symbol.toUpperCase();
    name.textContent = o.name;
    if (o.image) {
      icon.src = o.image;
      icon.hidden = false;
    } else {
      icon.hidden = true;
    }
  }

  function renderList(query = '') {
    const q = query.trim().toLowerCase();
    filtered = allOptions().filter(
      (o) => !q || o.name.toLowerCase().includes(q) || o.symbol.toLowerCase().includes(q),
    );
    activeIndex = Math.max(0, filtered.findIndex((o) => o.id === value));

    if (!filtered.length) {
      list.innerHTML = `<li class="combo__empty">No matches</li>`;
      return;
    }
    let lastKind = null;
    list.innerHTML = filtered
      .map((o, i) => {
        let group = '';
        if (opts.withFiats && o.kind !== lastKind) {
          lastKind = o.kind;
          group = `<li class="combo__group" role="presentation">${o.kind === 'fiat' ? 'Fiat' : 'Crypto'}</li>`;
        }
        return `${group}<li class="combo__opt${i === activeIndex ? ' combo__opt--active' : ''}"
          id="${id}-opt-${i}" role="option" data-idx="${i}"
          aria-selected="${o.id === value}">
          ${o.image ? `<img class="combo__icon" src="${o.image}" alt="" loading="lazy" />` : `<span class="combo__icon" aria-hidden="true"></span>`}
          <span class="combo__sym">${o.symbol.toUpperCase()}</span>
          <span class="combo__name">${o.name}</span>
        </li>`;
      })
      .join('');
  }

  function setActive(i) {
    if (!filtered.length) return;
    activeIndex = (i + filtered.length) % filtered.length;
    list.querySelectorAll('.combo__opt').forEach((el) => {
      const isActive = Number(el.dataset.idx) === activeIndex;
      el.classList.toggle('combo__opt--active', isActive);
      if (isActive) el.scrollIntoView({ block: 'nearest' });
    });
    search.setAttribute('aria-activedescendant', `${id}-opt-${activeIndex}`);
  }

  function openPanel() {
    open = true;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    search.value = '';
    renderList();
    search.focus();
  }

  function closePanel(refocus = true) {
    if (!open) return;
    open = false;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }

  function choose(i) {
    const o = filtered[i];
    if (!o) return;
    value = o.id;
    renderButton();
    closePanel();
    opts.onChange(value);
  }

  btn.addEventListener('click', () => (open ? closePanel() : openPanel()));
  search.addEventListener('input', () => renderList(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive(activeIndex + 1));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive(activeIndex - 1));
    else if (e.key === 'Enter') (e.preventDefault(), choose(activeIndex));
    else if (e.key === 'Escape') (e.preventDefault(), closePanel());
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.combo__opt');
    if (li) choose(Number(li.dataset.idx));
  });
  document.addEventListener('pointerdown', (e) => {
    if (open && !mount.contains(e.target)) closePanel(false);
  });

  renderButton();

  return {
    get value() {
      return value;
    },
    set(idWanted) {
      if (!find(idWanted)) return;
      value = idWanted;
      renderButton();
    },
    setCoins(next) {
      coins = next;
      renderButton();
      if (open) renderList(search.value);
    },
  };
}
