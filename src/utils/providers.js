import { config } from '../config.js';
import { UA } from './media.js';

/**
 * Provider resolvers.
 *
 * A datacenter host (Render, Fly, …) is bot-blocked by YouTube, so we never talk
 * to YouTube directly from the server. Instead we ask free, community-run媒
 * media-resolver services that run on trusted IPs and proxy the bytes back to
 * us. Each resolver turns a YouTube URL into a normalized "plan" the executor
 * can fulfil:
 *
 *   { kind: 'single', url }              one ready-to-save file (progressive)
 *   { kind: 'merge',  video, audio }     two streams → ffmpeg mux to MP4
 *   { kind: 'audio',  url }              an audio source → ffmpeg transcode to MP3
 *
 * Plans also carry an optional { title } used for the download filename.
 *
 * Both Cobalt and Piped are pools: we try instances in order and rotate the
 * first one that works to the front, so transient outages / rate-limits on any
 * single instance don't take the site down.
 */

const jsonHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': UA,
};

function timeout(ms) {
  return AbortSignal.timeout(ms);
}

/** Pull the 11-char video id out of any common YouTube URL shape. */
export function youtubeId(url) {
  const u = String(url).trim();
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/v\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = u.match(re);
    if (m) return m[1];
  }
  return null;
}

// Rotate the instance that just worked to the front of its pool (in-memory only).
function promote(pool, instance) {
  const i = pool.indexOf(instance);
  if (i > 0) {
    pool.splice(i, 1);
    pool.unshift(instance);
  }
}

/**
 * Resolve across an ENTIRE pool in parallel and return the first instance that
 * succeeds — instead of trying them one-by-one and waiting out each timeout.
 * The moment one wins, the losing requests are aborted (polite to the free
 * instances); we only reject once every instance has failed.
 */
function raceResolve(pool, attempt, timeoutMs = config.providerTimeoutMs) {
  const snapshot = [...pool];
  if (snapshot.length === 0) return Promise.reject(new Error('empty pool'));
  return new Promise((resolve, reject) => {
    const controllers = snapshot.map(() => new AbortController());
    const errors = [];
    let remaining = snapshot.length;
    let settled = false;

    snapshot.forEach((instance, i) => {
      const signal = AbortSignal.any([controllers[i].signal, AbortSignal.timeout(timeoutMs)]);
      Promise.resolve()
        .then(() => attempt(instance, signal))
        .then((result) => {
          if (settled) return;
          settled = true;
          controllers.forEach((c, j) => {
            if (j !== i) {
              try {
                c.abort();
              } catch {
                /* noop */
              }
            }
          });
          promote(pool, instance);
          resolve(result);
        })
        .catch((e) => {
          errors.push(`${hostOf(instance)}: ${e?.message || e}`);
          remaining -= 1;
          if (remaining === 0 && !settled) {
            reject(new Error(`pool exhausted — ${errors.join(' | ')}`));
          }
        });
    });
  });
}

// ── Cobalt ──────────────────────────────────────────────────────────────────

function cobaltBody(url, format, quality) {
  if (format === 'mp3') {
    // Ask for the best raw audio; we transcode to the exact MP3 bitrate ourselves.
    return { url, downloadMode: 'audio', audioFormat: 'best', filenameStyle: 'basic' };
  }
  return {
    url,
    videoQuality: quality === 'best' ? 'max' : String(quality),
    youtubeVideoCodec: 'h264', // H.264 → plays everywhere (iOS, editors, TVs)
    filenameStyle: 'basic',
    downloadMode: 'auto',
  };
}

function cobaltPlan(data, format) {
  const title = data?.output?.metadata?.title || stripExt(data?.filename || data?.output?.filename);
  const status = data?.status;

  if (status === 'error') {
    throw new Error(data?.error?.code || data?.text || 'cobalt error');
  }

  // Single, ready-to-stream URL.
  if ((status === 'tunnel' || status === 'redirect' || status === 'stream') && data.url) {
    return format === 'mp3'
      ? { kind: 'audio', url: data.url, title }
      : { kind: 'single', url: data.url, title };
  }

  // Newer Cobalt: client-side post-processing with one or two tunnel URLs.
  if (status === 'local-processing' && Array.isArray(data.tunnel) && data.tunnel.length) {
    if (format === 'mp3') return { kind: 'audio', url: data.tunnel[0], title };
    if (data.type === 'merge' && data.tunnel.length >= 2) {
      return { kind: 'merge', video: data.tunnel[0], audio: data.tunnel[1], title };
    }
    return { kind: 'single', url: data.tunnel[0], title };
  }

  // Picker (multiple options) — take the first usable one.
  if (status === 'picker' && Array.isArray(data.picker) && data.picker.length) {
    const pick = data.picker.find((p) => p.url) || data.picker[0];
    if (pick?.url) {
      return format === 'mp3'
        ? { kind: 'audio', url: pick.url, title }
        : { kind: 'single', url: pick.url, title };
    }
  }

  throw new Error(`unexpected cobalt status "${status}"`);
}

/** Resolve via the Cobalt pool — all instances raced in parallel. */
export function resolveCobalt(url, { format, quality }) {
  return raceResolve(config.cobaltInstances, async (instance, signal) => {
    const res = await fetch(instance, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(cobaltBody(url, format, quality)),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
    const plan = cobaltPlan(data, format);
    plan.via = `cobalt:${hostOf(instance)}`;
    return plan;
  });
}

// ── Piped ───────────────────────────────────────────────────────────────────

function parseHeight(q) {
  const m = String(q || '').match(/(\d{3,4})/);
  return m ? Number(m[1]) : 0;
}

function pipedPlan(data, format, quality) {
  const title = data?.title || null;
  const videoStreams = Array.isArray(data?.videoStreams) ? data.videoStreams : [];
  const audioStreams = Array.isArray(data?.audioStreams) ? data.audioStreams : [];

  if (format === 'mp3') {
    const audio = bestAudio(audioStreams);
    if (!audio) throw new Error('no audio streams');
    return { kind: 'audio', url: audio.url, title };
  }

  const cap = quality === 'best' ? Infinity : parseHeight(quality);
  const isMp4 = (s) => /mp4|m4a|MPEG_4/i.test(s.format || s.mimeType || '');

  // Prefer a progressive (audio+video) MP4 at or below the requested height.
  const progressive = videoStreams
    .filter((s) => !s.videoOnly && isMp4(s))
    .filter((s) => parseHeight(s.quality) <= cap)
    .sort((a, b) => parseHeight(b.quality) - parseHeight(a.quality))[0];
  if (progressive?.url) return { kind: 'single', url: progressive.url, title };

  // Otherwise mux best video-only (prefer H.264) + best audio.
  const video = videoStreams
    .filter((s) => s.videoOnly && parseHeight(s.quality) <= cap)
    .sort(
      (a, b) =>
        parseHeight(b.quality) - parseHeight(a.quality) ||
        h264Rank(b) - h264Rank(a),
    )[0];
  const audio = bestAudio(audioStreams);
  if (video?.url && audio?.url) {
    return { kind: 'merge', video: video.url, audio: audio.url, title };
  }
  if (video?.url) return { kind: 'single', url: video.url, title };
  throw new Error('no usable streams');
}

function h264Rank(s) {
  return /avc|h264/i.test(s.codec || s.format || '') ? 1 : 0;
}

function bestAudio(audioStreams) {
  return [...audioStreams]
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
    .find((s) => s.url);
}

/** Resolve via the Piped pool — all instances raced in parallel. */
export function resolvePiped(url, { format, quality }) {
  const id = youtubeId(url);
  if (!id) return Promise.reject(new Error('could not parse video id'));
  return raceResolve(config.pipedInstances, async (instance, signal) => {
    const res = await fetch(`${instance}/streams/${id}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.error) throw new Error(data?.error || `HTTP ${res.status}`);
    const plan = pipedPlan(data, format, quality);
    plan.via = `piped:${hostOf(instance)}`;
    return plan;
  });
}

// ── Metadata (preview card) ──────────────────────────────────────────────────

/**
 * Lightweight, datacenter-safe metadata for the preview card. YouTube's oEmbed
 * endpoint is public and never bot-blocked, so it's the reliable primary source
 * (title, channel, thumbnail). We then try Piped briefly to enrich duration.
 */
export async function youtubeMetadata(url) {
  const id = youtubeId(url);

  // Run both lookups at once so the preview is as fast as the quicker of them.
  const [base, meta] = await Promise.all([oembed(url), pipedMeta(id).catch(() => null)]);

  let duration = null;
  let maxHeight = null;
  let info = base;
  if (meta) {
    duration = meta.duration ?? null;
    maxHeight = meta.maxHeight ?? null;
    if (!info) info = { title: meta.title, author_name: meta.uploader, thumbnail_url: meta.thumbnail };
  }

  if (!info) throw new Error('Couldn’t load that video’s info. The link may be private or invalid.');

  return {
    id,
    title: info.title || 'Untitled',
    channel: info.author_name || null,
    duration: Number.isFinite(duration) ? duration : null,
    durationText: formatDuration(duration),
    thumbnail: info.thumbnail_url || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
    maxHeight,
    webpageUrl: id ? `https://www.youtube.com/watch?v=${id}` : url,
    isLive: false,
  };
}

/** YouTube oEmbed — public, datacenter-safe, fast. Title + channel + thumbnail. */
async function oembed(url) {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  try {
    const res = await fetch(endpoint, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: timeout(6000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Duration + quality ladder from Piped — instances raced, short timeout. */
async function pipedMeta(id) {
  if (!id) return null;
  try {
    return await raceResolve(
      config.pipedInstances,
      async (instance, signal) => {
        const res = await fetch(`${instance}/streams/${id}`, {
          headers: { Accept: 'application/json', 'User-Agent': UA },
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (d?.error) throw new Error(d.error);
        const heights = (d.videoStreams || []).map((s) => parseHeight(s.quality)).filter(Boolean);
        return {
          title: d.title,
          uploader: d.uploader,
          thumbnail: d.thumbnailUrl,
          duration: d.duration,
          maxHeight: heights.length ? Math.max(...heights) : null,
        };
      },
      4000,
    );
  } catch {
    return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function stripExt(name) {
  if (!name) return null;
  return String(name).replace(/\.[a-z0-9]{2,4}$/i, '');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
