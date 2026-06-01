/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HANDLER TEMPLATE — copy this file to add a new platform.                 │
 * │                                                                           │
 * │  1. Copy to e.g. src/handlers/vimeo.js                                    │
 * │  2. Fill in id / name / matchPattern / formats and the three methods.     │
 * │  3. Register it in server.js:  registry.register(vimeo)                   │
 * │                                                                           │
 * │  That's it. The UI, progress streaming, download and cleanup all work     │
 * │  automatically because they only ever talk to this interface.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Most sites are supported out of the box by yt-dlp, so a new handler is often
 * just a different matchPattern plus a tweaked format ladder. Reuse the shared
 * helpers in ../utils/ytdlp.js (fetchInfo, runDownload) like youtube.js does.
 */
import path from 'node:path';
import { fetchInfo, runDownload } from '../utils/ytdlp.js';

const example = {
  id: 'example', // unique slug
  name: 'Example', // shown in the UI

  // Decides whether this handler owns a pasted URL.
  matchPattern: /(?:example\.com\/video\/)/i,

  // Formats + quality ladders this platform should offer.
  formats: {
    mp4: { label: 'MP4', description: 'Video', qualities: ['best', '720', '360'], defaultQuality: '720' },
    mp3: { label: 'MP3', description: 'Audio', qualities: ['320', '192', '128'], defaultQuality: '320' },
  },

  validateUrl(url) {
    return typeof url === 'string' && this.matchPattern.test(url.trim());
  },

  // Return { title, channel, duration, durationText, thumbnail, ... } for the
  // preview card. yt-dlp's JSON already contains all of this for most sites.
  async fetchMetadata(url) {
    const info = await fetchInfo(url.trim());
    return {
      id: info.id,
      title: info.title || 'Untitled',
      channel: info.uploader || null,
      duration: info.duration || null,
      durationText: null, // format however you like
      thumbnail: info.thumbnail || null,
      webpageUrl: info.webpage_url || null,
    };
  },

  // Return an EventEmitter emitting 'progress' | 'status' | 'done' | 'error'.
  download(url, { format, quality, outDir, onProgress } = {}) {
    const outTemplate = path.join(outDir, '%(title).100B.%(ext)s');
    const args =
      format === 'mp3'
        ? ['-x', '--audio-format', 'mp3', '--audio-quality', `${quality}K`, '-o', outTemplate]
        : ['-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '-o', outTemplate];

    const emitter = runDownload({ url: url.trim(), args, outDir });
    if (typeof onProgress === 'function') emitter.on('progress', onProgress);
    return emitter;
  },
};

export default example;
