import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

// A browser-ish UA. Some provider proxies reject the default Node fetch agent.
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Stream a remote URL straight to a file, reporting progress as a percentage of
 * the slice we own: callers pass `base` (already-done %) and `weight` (0..1, how
 * much of the overall job this download represents). That lets a two-file
 * (video+audio) job report one smooth 0→100 bar.
 *
 * Returns the number of bytes written. Honors an AbortSignal for cancellation.
 */
export async function downloadToFile(url, dest, { onProgress, signal, base = 0, weight = 1 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const node = Readable.fromWeb(res.body);
  node.on('data', (chunk) => {
    received += chunk.length;
    if (onProgress && total > 0) {
      onProgress(base + (received / total) * weight * 100);
    }
  });

  await pipeline(node, createWriteStream(dest));
  if (received === 0) throw new Error('Download produced no data.');
  return received;
}

/** Run ffmpeg with the given args; resolves on exit 0, rejects with stderr tail otherwise. */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let err = '';
    let p;
    try {
      p = spawn(config.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    } catch (e) {
      return reject(new Error(`Could not launch ffmpeg: ${e.message}`));
    }
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = err.split('\n').filter(Boolean).slice(-2).join(' ').trim();
      reject(new Error(tail || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Mux a video-only and an audio-only file into one MP4. Video is stream-copied
 * (fast, lossless); audio is re-encoded to AAC so the result is always a valid,
 * universally-playable MP4 regardless of the source audio codec (Opus/Vorbis).
 */
export function mergeToMp4(videoPath, audioPath, outPath) {
  return runFfmpeg([
    '-i', videoPath,
    '-i', audioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    outPath,
  ]);
}

/** Remux an already-progressive file into a clean MP4 container (faststart for web). */
export function remuxToMp4(inputPath, outPath) {
  return runFfmpeg(['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outPath]);
}

/** Transcode any audio/video source to MP3 at the requested bitrate (kbps). */
export function toMp3(inputPath, outPath, bitrate = '320') {
  return runFfmpeg([
    '-i', inputPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', `${bitrate}k`,
    '-id3v2_version', '3',
    outPath,
  ]);
}
