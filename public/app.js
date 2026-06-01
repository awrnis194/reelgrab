/* ============================================================================
   ReelGrab — frontend controller
   A tiny state machine: idle → resolving → ready → converting → done | error
   Talks to the REST API and subscribes to a Server-Sent Events stream for
   live conversion progress.
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const el = {
  card: $('#card'),
  field: $('#urlField'),
  url: $('#url'),
  paste: $('#pasteBtn'),
  clear: $('#clearBtn'),
  hint: $('#hint'),
  preview: $('#preview'),
  thumb: $('#thumb'),
  duration: $('#duration'),
  metaTitle: $('#metaTitle'),
  metaChannel: $('#metaChannel'),
  sourceBadge: $('#sourceBadge'),
  controls: $('#controls'),
  formatSeg: $('#formatSeg'),
  qualityLabel: $('#qualityLabel'),
  chips: $('#qualityChips'),
  convert: $('#convertBtn'),
  convertLabel: $('.cta-label'),
  progress: $('#progress'),
  progressPhase: $('#progressPhase'),
  progressPercent: $('#progressPercent'),
  progressBar: $('#progressBar'),
  progressBarWrap: $('#progressBarWrap'),
  progressSpeed: $('#progressSpeed'),
  progressEta: $('#progressEta'),
  result: $('#result'),
  resultName: $('#resultName'),
  downloadLink: $('#downloadLink'),
  reset: $('#resetBtn'),
  error: $('#error'),
  errorMsg: $('#errorMsg'),
  retry: $('#retryBtn'),
  themeToggle: $('#themeToggle'),
};

// Default ladders; refined per-source from /api/metadata.
const DEFAULT_FORMATS = {
  mp4: { label: 'MP4', qualities: ['best', '1080', '720', '480', '360'], defaultQuality: '1080' },
  mp3: { label: 'MP3', qualities: ['320', '256', '192', '128'], defaultQuality: '320' },
};

const QUALITY_LABELS = {
  best: 'Best',
  2160: '4K',
  1440: '1440p',
  1080: '1080p',
  720: '720p',
  480: '480p',
  360: '360p',
  320: '320 kbps',
  256: '256 kbps',
  192: '192 kbps',
  128: '128 kbps',
};

// Optimistic client-side check (server is the source of truth).
const SUPPORTED = /(youtube\.com|youtu\.be)/i;

const state = {
  status: 'idle',
  meta: null,
  formats: DEFAULT_FORMATS,
  format: 'mp4',
  quality: DEFAULT_FORMATS.mp4.defaultQuality,
  resolveToken: 0,
  evtSource: null,
};

/* ---- Theme -------------------------------------------------------------- */
(function initTheme() {
  const saved = localStorage.getItem('reelgrab-theme');
  const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
})();

el.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('reelgrab-theme', next);
});

/* ---- Quality chips ------------------------------------------------------ */
function renderChips() {
  const fmt = state.formats[state.format] || DEFAULT_FORMATS[state.format];
  const qualities = fmt.qualities;
  if (!qualities.includes(state.quality)) state.quality = fmt.defaultQuality;

  el.qualityLabel.textContent = state.format === 'mp3' ? 'Bitrate' : 'Quality';
  el.chips.innerHTML = '';
  for (const q of qualities) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (q === state.quality ? ' is-active' : '');
    chip.dataset.quality = q;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(q === state.quality));
    chip.textContent = QUALITY_LABELS[q] || q;
    chip.addEventListener('click', () => {
      state.quality = q;
      renderChips();
      updateConvertLabel();
    });
    el.chips.appendChild(chip);
  }
}

/* ---- Format segmented control ------------------------------------------- */
el.formatSeg.querySelectorAll('.seg-opt').forEach((opt) => {
  opt.addEventListener('click', () => selectFormat(opt.dataset.format));
});

function selectFormat(format) {
  if (format === state.format) return;
  state.format = format;
  el.formatSeg.dataset.active = format;
  el.formatSeg.querySelectorAll('.seg-opt').forEach((o) => {
    const active = o.dataset.format === format;
    o.classList.toggle('is-active', active);
    o.setAttribute('aria-selected', String(active));
  });
  const fmt = state.formats[format] || DEFAULT_FORMATS[format];
  state.quality = fmt.defaultQuality;
  renderChips();
  updateConvertLabel();
}

/* ---- URL input ---------------------------------------------------------- */
let resolveTimer;
el.url.addEventListener('input', () => {
  const val = el.url.value.trim();
  el.clear.hidden = !val;
  el.paste.hidden = !!val;
  clearTimeout(resolveTimer);

  if (state.status === 'converting') return;
  resetToIdleVisuals();

  if (!val) {
    setHint('');
    updateConvertReady(false);
    return;
  }
  if (!SUPPORTED.test(val)) {
    setHint('Paste a YouTube link (more platforms coming soon).', 'error');
    updateConvertReady(false);
    return;
  }
  setHint('Looks good — fetching details…');
  updateConvertReady(true);
  resolveTimer = setTimeout(() => resolveUrl(val), 550);
});

el.url.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !el.convert.disabled) startConversion();
});

el.paste.addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      el.url.value = text;
      el.url.dispatchEvent(new Event('input'));
      el.url.focus();
    }
  } catch {
    el.url.focus();
    setHint('Clipboard blocked — paste manually with ⌘V / Ctrl V.', 'error');
  }
});

el.clear.addEventListener('click', () => {
  el.url.value = '';
  el.url.dispatchEvent(new Event('input'));
  el.url.focus();
});

/* ---- Resolve metadata --------------------------------------------------- */
async function resolveUrl(url) {
  const token = ++state.resolveToken;
  showPreviewSkeleton();
  try {
    const res = await fetch('/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (token !== state.resolveToken) return; // superseded by newer input
    if (!res.ok) throw new Error(data.error || 'Could not load video info.');

    state.meta = data.metadata;
    if (data.formats) state.formats = data.formats;
    renderPreview(data);
    renderChips();
    setHint('Ready to convert.', 'ok');
    updateConvertLabel();
  } catch (err) {
    if (token !== state.resolveToken) return;
    el.preview.hidden = true;
    setHint(err.message, 'error');
  }
}

function showPreviewSkeleton() {
  el.preview.hidden = false;
  el.thumb.classList.remove('loaded');
  el.thumb.removeAttribute('src');
  el.duration.hidden = true;
  el.metaTitle.textContent = 'Loading…';
  el.metaChannel.textContent = '';
  el.sourceBadge.hidden = true;
}

function renderPreview(data) {
  const m = state.meta;
  el.preview.hidden = false;
  el.metaTitle.textContent = m.title || 'Untitled';
  el.metaChannel.textContent = m.channel || '';
  if (m.durationText) {
    el.duration.textContent = m.durationText;
    el.duration.hidden = false;
  }
  if (data.source) {
    el.sourceBadge.textContent = data.source;
    el.sourceBadge.hidden = false;
  }
  if (m.thumbnail) {
    el.thumb.onload = () => el.thumb.classList.add('loaded');
    el.thumb.src = m.thumbnail;
  } else {
    el.thumb.classList.add('loaded');
  }
}

/* ---- Convert button state ----------------------------------------------- */
function updateConvertReady(ready) {
  el.convert.disabled = !ready || state.status === 'converting';
  updateConvertLabel();
}

function updateConvertLabel() {
  if (!el.url.value.trim() || !SUPPORTED.test(el.url.value)) {
    el.convertLabel.textContent = 'Paste a link to start';
    return;
  }
  const fmtLabel = (state.formats[state.format] || DEFAULT_FORMATS[state.format]).label;
  const q = QUALITY_LABELS[state.quality] || state.quality;
  el.convertLabel.textContent = `Convert to ${fmtLabel} · ${q}`;
}

/* ---- Conversion + SSE --------------------------------------------------- */
el.convert.addEventListener('click', startConversion);

async function startConversion() {
  const url = el.url.value.trim();
  if (!url || el.convert.disabled) return;

  state.status = 'converting';
  el.convert.classList.add('is-loading');
  el.convert.disabled = true;
  el.controls.classList.add('is-collapsed');
  el.error.hidden = true;
  el.result.hidden = true;
  showProgress(0, 'Starting…', true);

  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: state.format, quality: state.quality }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || 'Could not start conversion.');
    subscribe(job.id);
  } catch (err) {
    showError(err.message);
  }
}

function subscribe(jobId) {
  closeStream();
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  state.evtSource = es;

  es.onmessage = (e) => {
    let job;
    try {
      job = JSON.parse(e.data);
    } catch {
      return;
    }
    applyJob(job);
  };
  es.addEventListener('end', () => closeStream());
  es.onerror = () => {
    // The stream closes itself after a terminal event; only surface an error
    // if we're still mid-conversion.
    if (state.status === 'converting') {
      closeStream();
      showError('Lost connection to the server. Please try again.');
    }
  };
}

function applyJob(job) {
  if (job.status === 'downloading') {
    const indeterminate = job.percent == null || job.percent === 0;
    showProgress(job.percent || 0, job.label || 'Downloading', indeterminate);
    el.progressSpeed.textContent = job.speed ? `↓ ${job.speed}` : '';
    el.progressEta.textContent = job.eta ? `ETA ${job.eta}` : '';
  } else if (job.status === 'processing') {
    showProgress(100, job.label || 'Processing', true);
    el.progressSpeed.textContent = '';
    el.progressEta.textContent = 'Almost there…';
  } else if (job.status === 'done') {
    showDone(job);
  } else if (job.status === 'error') {
    showError(job.error || 'Conversion failed.');
  }
}

function showProgress(percent, phase, indeterminate) {
  el.progress.hidden = false;
  el.progress.classList.toggle('indeterminate', !!indeterminate);
  el.progressPhase.textContent = phase;
  const p = Math.round(percent);
  el.progressPercent.textContent = indeterminate ? '' : `${p}%`;
  if (!indeterminate) el.progressBar.style.width = `${p}%`;
  el.progressBarWrap.setAttribute('aria-valuenow', String(p));
}

function showDone(job) {
  closeStream();
  state.status = 'done';
  el.convert.classList.remove('is-loading');
  el.progress.hidden = true;
  el.error.hidden = true;
  el.result.hidden = false;
  el.convert.classList.add('is-collapsed');
  el.resultName.textContent = job.filename || '';
  el.downloadLink.href = job.downloadUrl;
  // Restart the checkmark draw animation.
  el.result.querySelectorAll('.check-ring, .check-mark').forEach((n) => {
    n.style.animation = 'none';
    void n.offsetWidth;
    n.style.animation = '';
  });
}

function showError(message) {
  closeStream();
  state.status = 'error';
  el.convert.classList.remove('is-loading', 'is-collapsed');
  el.progress.hidden = true;
  el.result.hidden = true;
  el.error.hidden = false;
  el.errorMsg.textContent = message;
}

function closeStream() {
  if (state.evtSource) {
    state.evtSource.close();
    state.evtSource = null;
  }
}

/* ---- Reset -------------------------------------------------------------- */
function resetToIdleVisuals() {
  el.error.hidden = true;
  el.result.hidden = true;
  el.progress.hidden = true;
  el.controls.classList.remove('is-collapsed');
  el.convert.classList.remove('is-collapsed', 'is-loading');
  if (state.status !== 'converting') state.status = 'idle';
}

el.reset.addEventListener('click', fullReset);
el.retry.addEventListener('click', () => {
  el.error.hidden = true;
  resetToIdleVisuals();
  if (el.url.value.trim()) startConversion();
});

function fullReset() {
  closeStream();
  state.status = 'idle';
  state.meta = null;
  el.url.value = '';
  el.clear.hidden = true;
  el.paste.hidden = false;
  el.preview.hidden = true;
  el.result.hidden = true;
  el.error.hidden = true;
  el.progress.hidden = true;
  el.controls.classList.remove('is-collapsed');
  el.convert.classList.remove('is-collapsed', 'is-loading');
  el.progressBar.style.width = '0%';
  setHint('');
  updateConvertReady(false);
  el.url.focus();
}

/* ---- Helpers ------------------------------------------------------------ */
function setHint(text, kind) {
  el.hint.textContent = text;
  el.hint.className = 'hint' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
  if (kind === 'error' && text) {
    el.field.classList.remove('shake');
    void el.field.offsetWidth;
    el.field.classList.add('shake');
  }
}

/* ---- Init --------------------------------------------------------------- */
el.formatSeg.dataset.active = state.format;
renderChips();
updateConvertLabel();
el.url.focus();
