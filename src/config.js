import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** Parse a comma-separated env list, falling back to defaults; normalize slashes. */
function list(envValue, defaults, { trailingSlash = false } = {}) {
  const raw = (envValue ? envValue.split(',') : defaults)
    .map((s) => s.trim())
    .filter(Boolean);
  return raw.map((u) => {
    const noTrail = u.replace(/\/+$/, '');
    return trailingSlash ? `${noTrail}/` : noTrail;
  });
}

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

  // Optional YouTube cookies (Netscape format) for the yt-dlp last-resort path.
  // On Render: add a Secret File named `cookies.txt` → it mounts at /etc/secrets/cookies.txt.
  // Locally this path won't exist, so it's simply ignored. (No longer the primary
  // strategy — the provider pools below do the heavy lifting from trusted IPs.)
  cookiesFile: process.env.COOKIES_FILE || '/etc/secrets/cookies.txt',

  // ── Resolver provider pools ────────────────────────────────────────────────
  // YouTube bot-blocks datacenter IPs, so we never extract from YouTube directly
  // on the server. These free, community-run services run on trusted IPs and
  // proxy the media bytes back to us. Each is a POOL: we try instances in order
  // and fail over on any error/rate-limit. Override via comma-separated env vars
  // when instances come and go (they do) — no code redeploy required.
  // Ordered best-first (verified working at build time). The pool fails over on
  // any error and promotes whichever responds, so stale entries are harmless —
  // but keep COBALT_INSTANCES handy to refresh as instances come and go.
  cobaltInstances: list(
    process.env.COBALT_INSTANCES,
    [
      'https://co.otomir23.me/',
      'https://co.eepy.today/',
      'https://cobalt-api.kwiatekmiki.com/',
      'https://capi.oak.li/',
      'https://dl.khub.app/',
      'https://cobalt.255.ru/',
    ],
    { trailingSlash: true },
  ),
  pipedInstances: list(
    process.env.PIPED_INSTANCES,
    [
      'https://api.piped.private.coffee',
      'https://pipedapi.kavin.rocks',
      'https://pipedapi.adminforge.de',
      'https://api.piped.yt',
      'https://pipedapi.reallyaweso.me',
      'https://pipedapi.ducks.party',
      'https://piped-api.codespace.cz',
    ],
    { trailingSlash: false },
  ),

  // Per-instance request timeout when resolving a stream.
  providerTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS) || 20000,

  // Try yt-dlp straight to YouTube as a final fallback. Rarely succeeds from a
  // datacenter, but it's free and handles odd cases (and works locally).
  enableYtdlpFallback: process.env.ENABLE_YTDLP_FALLBACK !== 'false',

  // How long a finished file is kept on disk before automatic cleanup.
  jobTTLms: Number(process.env.JOB_TTL_MS) || 1000 * 60 * 30, // 30 minutes

  // Optional guard. 0 = unlimited. Rejected at the metadata step.
  maxDurationSeconds: Number(process.env.MAX_DURATION_SECONDS) || 0,
};
