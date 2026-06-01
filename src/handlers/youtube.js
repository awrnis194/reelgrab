import path from 'node:path';
import { fetchInfo, runDownload } from '../utils/ytdlp.js';

/**
 * YouTube source handler.
 *
 * Implements the registry interface. All YouTube-specific knowledge (URL shapes,
 * format selectors, quality ladders) lives here and nowhere else.
 */

/**
 * Build an MP4-friendly yt-dlp `-f` selector for a given quality.
 *
 * We deliberately prefer H.264 (avc1) video + AAC (m4a) audio so the resulting
 * MP4 plays everywhere — QuickTime, iOS, video editors, smart TVs — instead of
 * AV1/Opus, which YouTube often serves as "best" but many players can't open.
 * The chain falls back step by step so a download never fails.
 */
function videoSelector(quality) {
  const cap = quality && quality !== 'best' ? `[height<=${quality}]` : '';
  return [
    `bestvideo${cap}[vcodec^=avc1]+bestaudio[acodec^=mp4a]`, // H.264 + AAC (ideal)
    `bestvideo${cap}[ext=mp4]+bestaudio[ext=m4a]`, // any mp4 video + m4a audio
    `best${cap}[ext=mp4]`, // pre-muxed mp4
    `bestvideo${cap}+bestaudio`, // last resort: best of anything
    `best${cap}`,
  ].join('/');
}

// MP3 target bitrates (kbps).
const AUDIO_BITRATES = new Set(['320', '256', '192', '128']);

// Try multiple YouTube player clients — some get past the "confirm you're not a
// bot" challenge on datacenter IPs (cloud hosts) without needing cookies.
const PLAYER_ARGS = ['--extractor-args', 'youtube:player_client=default,tv,mweb,web_safari'];

const youtube = {
  id: 'youtube',
  name: 'YouTube',

  // watch?v=, youtu.be/, shorts/, live/, embed/
  matchPattern: /(?:youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)/i,

  formats: {
    mp4: {
      label: 'MP4',
      description: 'Video',
      qualities: ['best', '1080', '720', '480', '360'],
      defaultQuality: '1080',
    },
    mp3: {
      label: 'MP3',
      description: 'Audio',
      qualities: ['320', '256', '192', '128'],
      defaultQuality: '320',
    },
  },

  validateUrl(url) {
    return typeof url === 'string' && this.matchPattern.test(url.trim());
  },

  async fetchMetadata(url) {
    const info = await fetchInfo(url.trim(), PLAYER_ARGS);
    return normalizeInfo(info);
  },

  /**
   * @param {object} opts
   * @param {'mp4'|'mp3'} opts.format
   * @param {string}      opts.quality   one of formats[fmt].qualities
   * @param {string}      opts.outDir    fresh per-job directory
   * @param {Function=}   opts.onProgress optional convenience callback
   * @returns EventEmitter
   */
  download(url, { format, quality, outDir, onProgress } = {}) {
    const args = buildArgs({ format, quality, outDir });
    const emitter = runDownload({ url: url.trim(), args, outDir });
    if (typeof onProgress === 'function') emitter.on('progress', onProgress);
    return emitter;
  },
};

function buildArgs({ format, quality, outDir }) {
  // %(title).100B truncates to 100 *bytes* so multibyte titles stay filesystem-safe.
  const outTemplate = path.join(outDir, '%(title).100B [%(id)s].%(ext)s');

  if (format === 'mp3') {
    const bitrate = AUDIO_BITRATES.has(String(quality)) ? String(quality) : '320';
    return [
      ...PLAYER_ARGS,
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', `${bitrate}K`,
      '--embed-metadata',
      '-o', outTemplate,
    ];
  }

  // Default to MP4 video.
  const selector = videoSelector(quality);
  return [
    ...PLAYER_ARGS,
    '-f', selector,
    '--merge-output-format', 'mp4',
    '--embed-metadata',
    '-o', outTemplate,
  ];
}

/** Reduce yt-dlp's enormous info JSON to the few fields the UI needs. */
function normalizeInfo(info) {
  const heights = (info.formats || []).map((f) => f.height).filter((h) => Number.isFinite(h));
  return {
    id: info.id,
    title: info.title || 'Untitled',
    channel: info.uploader || info.channel || info.uploader_id || null,
    duration: Number.isFinite(info.duration) ? info.duration : null,
    durationText: formatDuration(info.duration),
    thumbnail: pickThumbnail(info),
    maxHeight: heights.length ? Math.max(...heights) : null,
    webpageUrl: info.webpage_url || null,
    isLive: Boolean(info.is_live),
  };
}

function pickThumbnail(info) {
  const thumbs = (info.thumbnails || []).filter((t) => t.url);
  if (thumbs.length) {
    // Prefer the widest still that isn't a giant storyboard.
    const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
    const reasonable = sorted.find((t) => (t.width || 0) <= 1280) || sorted[0];
    return reasonable.url;
  }
  return info.thumbnail || null;
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

export default youtube;
