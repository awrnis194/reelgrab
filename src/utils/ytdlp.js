import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

// Unique marker we prepend to progress lines so they're trivial to parse and
// can never collide with yt-dlp's own output.
const PROG = '[[PROG]]';

// Cached path to the writable cookies copy (see cookieArgs).
let cookiesPathCache = null;

/**
 * If a cookies file is present, pass it to yt-dlp (gets past datacenter bot
 * checks). yt-dlp writes refreshed cookies *back* to the file, but Render mounts
 * Secret Files as read-only — so we copy the secret to a writable temp file once
 * and hand yt-dlp that, avoiding "[Errno 30] Read-only file system" errors.
 */
function cookieArgs() {
  if (!config.cookiesFile || !existsSync(config.cookiesFile)) return [];
  try {
    if (!cookiesPathCache || !existsSync(cookiesPathCache)) {
      const dest = path.join(os.tmpdir(), 'reelgrab-cookies.txt');
      copyFileSync(config.cookiesFile, dest);
      cookiesPathCache = dest;
    }
    return ['--cookies', cookiesPathCache];
  } catch {
    // Couldn't make a writable copy — fall back to the original (read-only) path.
    return ['--cookies', config.cookiesFile];
  }
}

/** Turn a raw spawn failure into a message a human can act on. */
function launchError(e) {
  if (e?.code === 'ENOENT') {
    return new Error('yt-dlp isn’t installed on the server. See README.md to install it.');
  }
  return new Error(`Failed to launch yt-dlp: ${e.message}`);
}

/**
 * Detect whether the required binaries are installed and return their versions.
 * Never throws — a missing binary resolves to `null`.
 */
export async function probeBinaries() {
  const [ytdlp, ffmpeg] = await Promise.all([
    getVersion(config.ytdlpPath, ['--version']),
    getVersion(config.ffmpegPath, ['-version']),
  ]);
  return { ytdlp, ffmpeg };
}

function getVersion(bin, args) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn(bin, args);
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 ? out.trim().split('\n')[0] : null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Fetch full metadata for a URL as JSON. yt-dlp does the heavy lifting of
 * extracting title / thumbnail / duration / formats for any supported site.
 */
export function fetchInfo(url, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--no-warnings', '--no-playlist', ...cookieArgs(), ...extraArgs, url];
    let json = '';
    let err = '';
    let p;
    try {
      p = spawn(config.ytdlpPath, args);
    } catch (e) {
      return reject(launchError(e));
    }
    p.stdout.on('data', (d) => (json += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(launchError(e)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`));
      try {
        resolve(JSON.parse(json));
      } catch {
        reject(new Error('Could not parse the video metadata.'));
      }
    });
  });
}

/**
 * Run a download/convert job. Returns an EventEmitter that emits:
 *   - 'progress' { percent, speed, eta }
 *   - 'status'   { phase, label }
 *   - 'done'     { filePath, filename }
 *   - 'error'    Error
 * The returned emitter also exposes `.cancel()` to kill the process.
 *
 * `outDir` must be a fresh, job-specific directory; the produced media file is
 * located by scanning it after a successful exit.
 */
export function runDownload({ url, args, outDir }) {
  const emitter = new EventEmitter();

  const fullArgs = [
    '--newline',
    '--no-playlist',
    '--no-warnings',
    '--progress-template',
    `download:${PROG}%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s`,
    ...(process.env.FFMPEG_PATH ? ['--ffmpeg-location', process.env.FFMPEG_PATH] : []),
    ...cookieArgs(),
    ...args,
    url,
  ];

  let stderr = '';
  let stdoutBuffer = '';
  let p;

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith(PROG)) {
      const [percentStr, speed, eta] = line.slice(PROG.length).split('|');
      const percent = parseFloat(String(percentStr).replace('%', '').trim());
      emitter.emit('progress', {
        percent: Number.isFinite(percent) ? percent : null,
        speed: clean(speed),
        eta: clean(eta),
      });
    } else if (/\[ExtractAudio\]|Destination:.*\.mp3/.test(line)) {
      emitter.emit('status', { phase: 'processing', label: 'Extracting audio' });
    } else if (/\[Merger\]/.test(line)) {
      emitter.emit('status', { phase: 'processing', label: 'Merging audio & video' });
    } else if (/\[VideoConvertor\]|\[VideoRemuxer\]/.test(line)) {
      emitter.emit('status', { phase: 'processing', label: 'Finalizing' });
    }
  };

  try {
    p = spawn(config.ytdlpPath, fullArgs);
  } catch (e) {
    queueMicrotask(() => emitter.emit('error', launchError(e)));
    return emitter;
  }

  p.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // keep partial line
    for (const line of lines) handleLine(line);
  });
  p.stderr.on('data', (d) => (stderr += d.toString()));
  p.on('error', (e) => emitter.emit('error', launchError(e)));
  p.on('close', async (code) => {
    if (stdoutBuffer) handleLine(stdoutBuffer);
    if (code !== 0) {
      return emitter.emit('error', new Error(cleanError(stderr) || `Conversion failed (exit ${code})`));
    }
    try {
      const filePath = await pickOutputFile(outDir);
      if (!filePath) throw new Error('No output file was produced.');
      emitter.emit('done', { filePath, filename: path.basename(filePath) });
    } catch (e) {
      emitter.emit('error', e);
    }
  });

  emitter.cancel = () => {
    try {
      p?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };

  return emitter;
}

/** Pick the largest real media file in a job directory (ignores temp files). */
async function pickOutputFile(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of entries) {
    if (name.startsWith('.') || /\.(part|ytdl|temp)$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fs.stat(full);
      if (st.isFile()) candidates.push({ full, size: st.size });
    } catch {
      /* skip */
    }
  }
  candidates.sort((a, b) => b.size - a.size);
  return candidates[0]?.full || null;
}

/** Pull the most relevant line out of yt-dlp's noisy stderr. */
function cleanError(err) {
  if (!err) return null;
  const lines = err.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /error/i.test(l));
  const chosen = errLine || lines.pop();
  if (!chosen) return null;
  return chosen.replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function clean(v) {
  const s = (v ?? '').toString().trim();
  return s && s !== 'NA' && s !== 'Unknown' ? s : null;
}
