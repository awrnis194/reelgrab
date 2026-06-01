import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { registry } from './registry.js';
import { config } from './config.js';

/**
 * Converter service: owns the in-memory job store and orchestrates the chosen
 * handler. Each job has its own event bus that the SSE route subscribes to.
 */

/** @type {Map<string, object>} */
const jobs = new Map();

export function getJob(id) {
  return jobs.get(id);
}

export async function createJob({ url, format, quality }) {
  const handler = registry.findHandler(url);
  if (!handler) throw httpError(400, 'That link isn’t supported yet.');
  if (!handler.validateUrl(url)) throw httpError(400, `This doesn’t look like a valid ${handler.name} URL.`);

  const fmt = handler.formats?.[format];
  if (!fmt) throw httpError(400, `Unsupported format “${format}”.`);

  // Resolve + sanitize quality against the handler's allow-list.
  let resolvedQuality = quality;
  if (!resolvedQuality || !fmt.qualities.includes(String(resolvedQuality))) {
    resolvedQuality = fmt.defaultQuality;
  }

  const id = randomUUID();
  const outDir = path.join(config.downloadDir, id);
  await fs.mkdir(outDir, { recursive: true });

  const job = {
    id,
    url,
    format,
    quality: resolvedQuality,
    handlerName: handler.name,
    status: 'queued', // queued | downloading | processing | done | error
    percent: 0,
    speed: null,
    eta: null,
    label: 'Queued',
    filePath: null,
    filename: null,
    error: null,
    createdAt: Date.now(),
    outDir,
    bus: new EventEmitter(),
    _emitter: null,
  };
  jobs.set(id, job);

  // Fire and forget — progress is delivered through the job bus / SSE.
  run(job, handler).catch((e) => fail(job, e));

  return job;
}

async function run(job, handler) {
  update(job, { status: 'downloading', label: 'Starting…' });

  const emitter = handler.download(job.url, {
    format: job.format,
    quality: job.quality,
    outDir: job.outDir,
  });
  job._emitter = emitter;

  emitter.on('progress', (p) => {
    update(job, {
      status: 'downloading',
      percent: p.percent ?? job.percent,
      speed: p.speed,
      eta: p.eta,
      label: 'Downloading',
    });
  });

  emitter.on('status', (s) => {
    update(job, { status: 'processing', label: s.label || 'Processing', speed: null, eta: null });
  });

  emitter.on('done', ({ filePath, filename }) => {
    update(job, {
      status: 'done',
      percent: 100,
      label: 'Ready',
      filePath,
      filename,
      speed: null,
      eta: null,
    });
    scheduleCleanup(job);
  });

  emitter.on('error', (err) => fail(job, err));
}

function update(job, patch) {
  Object.assign(job, patch);
  job.bus.emit('update', publicJob(job));
}

function fail(job, err) {
  Object.assign(job, {
    status: 'error',
    label: 'Failed',
    error: err?.message || String(err),
  });
  job.bus.emit('update', publicJob(job));
  scheduleCleanup(job);
}

/** Cancel a running job and clean it up immediately. */
export async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job._emitter?.cancel?.();
  await cleanup(id);
  return true;
}

/** The shape sent to clients — never leaks absolute paths or internals. */
export function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    percent: Math.max(0, Math.min(100, Math.round(job.percent || 0))),
    speed: job.speed,
    eta: job.eta,
    label: job.label,
    filename: job.filename,
    error: job.error,
    format: job.format,
    quality: job.quality,
    source: job.handlerName,
    downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/download` : null,
  };
}

function scheduleCleanup(job) {
  setTimeout(() => {
    cleanup(job.id).catch(() => {});
  }, config.jobTTLms).unref?.();
}

export async function cleanup(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  try {
    await fs.rm(job.outDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
