import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { resolveCobalt, resolvePiped, youtubeId } from './providers.js';
import { downloadToFile, mergeToMp4, remuxToMp4, toMp3 } from './media.js';
import { runDownload } from './ytdlp.js';

/**
 * Orchestrates a YouTube job across the provider strategy stack:
 *   1. Cobalt pool   2. Piped pool   3. yt-dlp direct (last resort)
 * The first strategy that produces a file wins; the rest are tried only on
 * failure. Returns an EventEmitter matching the handler contract
 * ('progress' | 'status' | 'done' | 'error') with a `.cancel()` method.
 */
export function runYoutube({ url, format, quality, outDir }) {
  const emitter = new EventEmitter();
  let ac = null;
  let ytdlp = null;
  let cancelled = false;

  emitter.cancel = () => {
    cancelled = true;
    try {
      ac?.abort();
    } catch {
      /* noop */
    }
    ytdlp?.cancel?.();
  };

  const emit = (ev, payload) => {
    if (!cancelled) emitter.emit(ev, payload);
  };

  (async () => {
    const errors = [];

    // ── Provider strategies (work from any IP) ──
    for (const strat of [
      { name: 'Cobalt', resolve: resolveCobalt },
      { name: 'Piped', resolve: resolvePiped },
    ]) {
      if (cancelled) return;
      try {
        const plan = await strat.resolve(url, { format, quality });
        ac = new AbortController();
        const result = await fulfil({ plan, format, quality, outDir, emit, signal: ac.signal });
        if (cancelled) return;
        console.log(`  ✓ ${format.toUpperCase()} via ${plan.via}`);
        return emit('done', result);
      } catch (e) {
        if (cancelled) return;
        errors.push(`${strat.name}: ${e.message}`);
        emit('status', { phase: 'processing', label: 'Trying another source…' });
      }
    }

    // ── Last resort: yt-dlp straight to YouTube ──
    if (config.enableYtdlpFallback && !cancelled) {
      try {
        const result = await viaYtdlp({
          url,
          format,
          quality,
          outDir,
          emit,
          setEmitter: (e) => (ytdlp = e),
        });
        if (cancelled) return;
        console.log(`  ✓ ${format.toUpperCase()} via yt-dlp (direct)`);
        return emit('done', result);
      } catch (e) {
        errors.push(`yt-dlp: ${e.message}`);
      }
    }

    if (cancelled) return;
    console.warn(`  ✗ all strategies failed for ${url}\n    ${errors.join('\n    ')}`);
    emit('error', new Error(friendlyError()));
  })();

  return emitter;
}

/** Carry out a resolved plan: download, post-process, return {filePath, filename}. */
async function fulfil({ plan, format, quality, outDir, emit, signal }) {
  const title = sanitize(plan.title) || youtubeId(plan.url || '') || 'reelgrab';
  const onProgress = (percent) => emit('progress', { percent: Math.min(99, percent) });
  emit('status', { phase: 'downloading', label: 'Downloading' });

  if (format === 'mp3') {
    const src = path.join(outDir, 'source.audio');
    await downloadToFile(plan.url, src, { signal, onProgress, base: 0, weight: 0.9 });
    emit('status', { phase: 'processing', label: 'Encoding MP3' });
    const out = path.join(outDir, `${title}.mp3`);
    await toMp3(src, out, quality);
    await safeUnlink(src);
    return { filePath: out, filename: `${title}.mp3` };
  }

  if (plan.kind === 'merge') {
    const v = path.join(outDir, 'video.part');
    const a = path.join(outDir, 'audio.part');
    await downloadToFile(plan.video, v, { signal, onProgress, base: 0, weight: 0.75 });
    await downloadToFile(plan.audio, a, { signal, onProgress, base: 75, weight: 0.2 });
    emit('status', { phase: 'processing', label: 'Merging audio & video' });
    const out = path.join(outDir, `${title}.mp4`);
    await mergeToMp4(v, a, out);
    await safeUnlink(v);
    await safeUnlink(a);
    return { filePath: out, filename: `${title}.mp4` };
  }

  // Single progressive file.
  const raw = path.join(outDir, 'source.part');
  await downloadToFile(plan.url, raw, { signal, onProgress, base: 0, weight: 0.95 });
  emit('status', { phase: 'processing', label: 'Finalizing' });
  const out = path.join(outDir, `${title}.mp4`);
  try {
    await remuxToMp4(raw, out);
    await safeUnlink(raw);
  } catch {
    // Remux failed (already a clean container) — just hand back the raw file.
    await fs.rename(raw, out);
  }
  return { filePath: out, filename: `${title}.mp4` };
}

/** Wrap the legacy yt-dlp runner in a promise and forward its events. */
function viaYtdlp({ url, format, quality, outDir, emit, setEmitter }) {
  return new Promise((resolve, reject) => {
    const args = ytdlpArgs({ format, quality, outDir });
    const e = runDownload({ url, args, outDir });
    setEmitter(e);
    e.on('progress', (p) => emit('progress', p));
    e.on('status', (s) => emit('status', s));
    e.on('done', resolve);
    e.on('error', reject);
  });
}

function ytdlpArgs({ format, quality, outDir }) {
  const out = path.join(outDir, '%(title).100B [%(id)s].%(ext)s');
  if (format === 'mp3') {
    const bitrate = ['320', '256', '192', '128'].includes(String(quality)) ? String(quality) : '320';
    return ['-x', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`, '--embed-metadata', '-o', out];
  }
  const cap = quality && quality !== 'best' ? `[height<=${quality}]` : '';
  const selector = [
    `bestvideo${cap}[vcodec^=avc1]+bestaudio[acodec^=mp4a]`,
    `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]`,
    `best${cap}[ext=mp4]`,
    `bestvideo${cap}+bestaudio`,
    `best${cap}`,
  ].join('/');
  return ['-f', selector, '--merge-output-format', 'mp4', '--embed-metadata', '-o', out];
}

function friendlyError() {
  return (
    'Couldn’t fetch this video right now — all download sources were unavailable ' +
    'or rate-limited. Please wait a moment and try again.'
  );
}

function sanitize(name) {
  if (!name) return null;
  return (
    String(name)
      .replace(/[\\/?%*:|"<>\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || null
  );
}

async function safeUnlink(p) {
  try {
    await fs.unlink(p);
  } catch {
    /* best effort */
  }
}
