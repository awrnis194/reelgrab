import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Central configuration. Everything is overridable through environment
 * variables so the app is portable across local, Docker and PaaS hosts.
 */
export const config = {
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',

  root,
  publicDir: path.join(root, 'public'),

  // Where converted files live before download. Wiped per-job after a TTL.
  downloadDir: process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'reelgrab'),

  // Binaries. Override if they aren't on PATH.
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',

  // Optional YouTube cookies (Netscape format) to get past datacenter bot checks.
  // On Render: add a Secret File named `cookies.txt` → it mounts at /etc/secrets/cookies.txt.
  // Locally this path won't exist, so it's simply ignored.
  cookiesFile: process.env.COOKIES_FILE || '/etc/secrets/cookies.txt',

  // How long a finished file is kept on disk before automatic cleanup.
  jobTTLms: Number(process.env.JOB_TTL_MS) || 1000 * 60 * 30, // 30 minutes

  // Optional guard. 0 = unlimited. Rejected at the metadata step.
  maxDurationSeconds: Number(process.env.MAX_DURATION_SECONDS) || 0,
};
