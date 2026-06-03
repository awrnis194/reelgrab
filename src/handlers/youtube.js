import { youtubeMetadata } from '../utils/providers.js';
import { runYoutube } from '../utils/execute.js';

/**
 * YouTube source handler.
 *
 * The server can't talk to YouTube directly — datacenter IPs are bot-blocked.
 * So extraction is delegated to a strategy stack (Cobalt → Piped → yt-dlp) that
 * runs through trusted public resolvers; see src/utils/execute.js. This handler
 * only owns YouTube-specific knowledge: URL shapes, formats, and quality ladders.
 */
const youtube = {
  id: 'youtube',
  name: 'YouTube',

  // watch?v=, youtu.be/, shorts/, live/, embed/, /v/
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
    return youtubeMetadata(url.trim());
  },

  /**
   * @param {object} opts
   * @param {'mp4'|'mp3'} opts.format
   * @param {string}      opts.quality
   * @param {string}      opts.outDir   fresh per-job directory
   * @returns EventEmitter ('progress' | 'status' | 'done' | 'error') with .cancel()
   */
  download(url, { format, quality, outDir } = {}) {
    return runYoutube({ url: url.trim(), format, quality, outDir });
  },
};

export default youtube;
