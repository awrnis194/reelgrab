import express from 'express';
import { promises as fs } from 'node:fs';
import { config } from './src/config.js';
import { registry } from './src/registry.js';
import { api } from './src/routes/api.js';
import { probeBinaries } from './src/utils/ytdlp.js';

// ── Register source handlers ────────────────────────────────────────────────
// Adding a platform is a one-line change here + one new file in src/handlers/.
import youtube from './src/handlers/youtube.js';
registry.register(youtube);
// import vimeo from './src/handlers/vimeo.js';   registry.register(vimeo);
// import tiktok from './src/handlers/tiktok.js';  registry.register(tiktok);

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use('/api', api);
// Cache static assets in production, but revalidate every load in dev so design
// changes appear on a normal refresh (no hard-reload needed).
app.use(
  express.static(config.publicDir, {
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    extensions: ['html'],
  }),
);

// Non-API GETs fall back to the single page.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile('index.html', { root: config.publicDir });
});

// ── Boot ────────────────────────────────────────────────────────────────────
await fs.mkdir(config.downloadDir, { recursive: true });

const bins = await probeBinaries();

app.listen(config.port, config.host, () => {
  const line = '─'.repeat(46);
  console.log(`\n  ┌${line}┐`);
  console.log(`  │  ✦  ReelGrab — Media Converter`);
  console.log(`  │  →  http://localhost:${config.port}`);
  console.log(`  │`);
  console.log(`  │  yt-dlp : ${bins.ytdlp ? '✓ ' + bins.ytdlp : '✗ NOT FOUND'}`);
  console.log(`  │  ffmpeg : ${bins.ffmpeg ? '✓ installed' : '✗ NOT FOUND'}`);
  console.log(`  └${line}┘\n`);

  if (!bins.ytdlp) {
    console.warn('  ⚠  yt-dlp is required. Install it, then restart. See README.md.\n');
  }
  if (!bins.ffmpeg) {
    console.warn('  ⚠  ffmpeg is required for MP3 extraction and MP4 merging. See README.md.\n');
  }
});
