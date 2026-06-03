import express from 'express';
import { promises as fs } from 'node:fs';
import { registry } from '../registry.js';
import { createJob, getJob, publicJob, cancelJob } from '../converter.js';
import { config } from '../config.js';
import { resolveCobalt, resolvePiped } from '../utils/providers.js';

export const api = express.Router();

// Quick liveness; add ?deep=1 to actually probe one Cobalt + one Piped instance
// against a known video (handy for "is the engine working?" from a browser).
api.get('/health', async (req, res) => {
  const base = {
    ok: true,
    providers: { cobalt: config.cobaltInstances.length, piped: config.pipedInstances.length },
  };
  if (req.query.deep === undefined) return res.json(base);

  const probe = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const check = async (fn) => {
    try {
      const plan = await fn(probe, { format: 'mp4', quality: '360' });
      return { ok: true, via: plan.via, kind: plan.kind };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  const [cobalt, piped] = await Promise.all([check(resolveCobalt), check(resolvePiped)]);
  res.json({ ...base, deep: { cobalt, piped }, healthy: cobalt.ok || piped.ok });
});

/** Supported platforms + their formats, for the frontend to render dynamically. */
api.get('/sources', (_req, res) => {
  res.json({ sources: registry.list() });
});

/** Resolve a URL to a preview (title, thumbnail, duration, available formats). */
api.post('/metadata', async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'Please paste a link first.' });

  const handler = registry.findHandler(url);
  if (!handler) {
    return res.status(400).json({ error: 'That link isn’t supported yet — try a YouTube URL.' });
  }
  try {
    const metadata = await handler.fetchMetadata(url);
    res.json({ source: handler.name, sourceId: handler.id, formats: handler.formats, metadata });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Couldn’t load that video’s info.' });
  }
});

/** Create a conversion job. Returns the public job immediately; progress via SSE. */
api.post('/jobs', async (req, res) => {
  const { url, format, quality } = req.body || {};
  try {
    const job = await createJob({ url: String(url || '').trim(), format, quality });
    res.status(201).json(publicJob(job));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** One-shot job state (used as an SSE fallback / on reconnect). */
api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(publicJob(job));
});

/** Live progress stream (Server-Sent Events). */
api.get('/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
  });
  res.flushHeaders?.();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const end = () => {
    res.write('event: end\ndata: {}\n\n');
    res.end();
  };

  // Send current state right away…
  send(publicJob(job));
  if (job.status === 'done' || job.status === 'error') return end();

  // …then stream updates.
  const onUpdate = (pub) => {
    send(pub);
    if (pub.status === 'done' || pub.status === 'error') end();
  };
  job.bus.on('update', onUpdate);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(keepAlive);
    job.bus.off('update', onUpdate);
  });
});

/** Stream the finished file to the browser as a download. */
api.get('/jobs/:id/download', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).send('Job not found.');
  if (job.status !== 'done' || !job.filePath) return res.status(409).send('File isn’t ready yet.');

  try {
    await fs.access(job.filePath);
  } catch {
    return res.status(410).send('This file has expired. Please convert again.');
  }

  res.download(job.filePath, job.filename, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

/** Cancel / clean up a job. */
api.delete('/jobs/:id', async (req, res) => {
  const ok = await cancelJob(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});
