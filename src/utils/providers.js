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

/** Resolve via the Cobalt pool. Throws if every instance fails. */
export async function resolveCobalt(url, { format, quality }) {
  const pool = config.cobaltInstances;
  const errors = [];
  for (const instance of [...pool]) {
    try {
      const res = await fetch(instance, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(cobaltBody(url, format, quality)),
        signal: timeout(config.providerTimeoutMs),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(`HTTP ${res.status}`);
      const plan = cobaltPlan(data, format);
      promote(pool, instance);
      plan.via = `cobalt:${hostOf(instance)}`;
      return plan;
    } catch (e) {
      errors.push(`${hostOf(instance)}: ${e.message}`);
    }
  }
  throw new Error(`Cobalt pool exhausted — ${errors.join(' | ')}`);
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

/** Resolve via the Piped pool. Throws if every instance fails. */
export async function resolvePiped(url, { format, quality }) {
  const id = youtubeId(url);
  if (!id) throw new Error('could not parse video id');
  const pool = config.pipedInstances;
  const errors = [];
  for (const instance of [...pool]) {
    try {
      const res = await fetch(`${instance}/streams/${id}`, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: timeout(config.providerTimeoutMs),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.error) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const plan = pipedPlan(data, format, quality);
      promote(pool, instance);
      plan.via = `piped:${hostOf(instance)}`;
      return plan;
    } catch (e) {
      errors.push(`${hostOf(instance)}: ${e.message}`);
    }
  }
  throw new Error(`Piped pool exhausted — ${errors.join(' | ')}`);
}

// ── Metadata (preview card) ──────────────────────────────────────────────────

/**
 * Lightweight, datacenter-safe metadata for the preview card. YouTube's oEmbed
 * endpoint is public and never bot-blocked, so it's the reliable primary source
 * (title, channel, thumbnail). We then try Piped briefly to enrich duration.
 */
export async function youtubeMetadata(url) {
  const id = youtubeId(url);
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;

  let base = null;
  try {
    const res = await fetch(oembed, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: timeout(8000),
    });
    if (res.ok) base = await res.json();
  } catch {
    /* fall through to Piped */
  }

  let duration = null;
  let maxHeight = null;
  try {
    const meta = await pipedMeta(id);
    if (meta) {
      duration = meta.duration ?? duration;
      maxHeight = meta.maxHeight ?? maxHeight;
      if (!base) base = { title: meta.title, author_name: meta.uploader, thumbnail_url: meta.thumbnail };
    }
  } catch {
    /* best effort */
  }

  if (!base) throw new Error('Couldn’t load that video’s info. The link may be private or invalid.');

  return {
    id,
    title: base.title || 'Untitled',
    channel: base.author_name || null,
    duration: Number.isFinite(duration) ? duration : null,
    durationText: formatDuration(duration),
    thumbnail: base.thumbnail_url || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
    maxHeight,
    webpageUrl: id ? `https://www.youtube.com/watch?v=${id}` : url,
    isLive: false,
  };
}

async function pipedMeta(id) {
  if (!id) return null;
  for (const instance of [...config.pipedInstances]) {
    try {
      const res = await fetch(`${instance}/streams/${id}`, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: timeout(4000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      if (d?.error) continue;
      const heights = (d.videoStreams || []).map((s) => parseHeight(s.quality)).filter(Boolean);
      return {
        title: d.title,
        uploader: d.uploader,
        thumbnail: d.thumbnailUrl,
        duration: d.duration,
        maxHeight: heights.length ? Math.max(...heights) : null,
      };
    } catch {
      /* try next */
    }
  }
  return null;
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
