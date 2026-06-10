import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const prod = process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');

// Render's health check (render.yaml → healthCheckPath) hits this.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Optional CoinGecko demo key. The demo key is a public-tier credential; the
// client requests it once and sends it as `x-cg-demo-api-key` to raise limits.
app.get('/api/config', (_req, res) => {
  res.json({ coingeckoKey: process.env.COINGECKO_KEY || null });
});

app.use(
  express.static(publicDir, {
    maxAge: prod ? '1h' : 0,
    extensions: ['html'],
  }),
);

// Non-API GETs fall back to the single page.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile('index.html', { root: publicDir });
});

app.listen(port, host, () => {
  console.log(`ReelGrab — live crypto calculators · http://localhost:${port}`);
});
