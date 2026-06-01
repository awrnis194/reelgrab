# ReelGrab — Beautiful Media Converter

A stunning, production-ready web app that converts online video to **MP4** (video) and **MP3** (audio). Paste a link, pick a format, watch live progress, and download a clean file.

Built around an **expandable source-handler registry** — adding a new platform (Vimeo, TikTok, …) is literally one new file in `src/handlers/` plus one line in `server.js`.

![ReelGrab](public/favicon.svg)

---

## Highlights

- 🎨 **Aurora-glass UI** — animated mesh backdrop, glassmorphic card, fluid micro-interactions, dark/light themes (system-aware + remembered).
- ⚡ **Live progress** over Server-Sent Events — real percent, speed and ETA, plus phase labels (downloading → merging → finalizing).
- 🧩 **Expandable by design** — a clean handler interface; the UI, streaming, download and cleanup are platform-agnostic.
- 📱 **Responsive** — looks great on desktop, tablet and mobile.
- 🛡️ **Safe execution** — binaries are spawned with argument arrays (never a shell), inputs are validated against allow-lists.
- 🐳 **One-command Docker** — image bundles `yt-dlp` + `ffmpeg`.

---

## Requirements

Two binaries do the heavy lifting:

| Tool | Why | Install |
|------|-----|---------|
| **yt-dlp** | Extract metadata + download | `brew install yt-dlp` · [other methods](https://github.com/yt-dlp/yt-dlp#installation) |
| **ffmpeg** | Merge video+audio, extract MP3 | `brew install ffmpeg` · [downloads](https://ffmpeg.org/download.html) |

Plus **Node.js ≥ 18.18**.

> On Linux: `sudo apt install ffmpeg` and grab the `yt-dlp` binary from its releases page (see the Dockerfile for the exact commands).

---

## Run it locally

```bash
cd youtube-converter
npm install
npm start
# → http://localhost:3000
```

`npm run dev` restarts on file changes. The server prints a banner showing whether `yt-dlp` and `ffmpeg` were found — if either says `NOT FOUND`, install it and restart.

### Configuration (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DOWNLOAD_DIR` | system temp | Where files are staged before download |
| `JOB_TTL_MS` | `1800000` | How long a finished file is kept (then auto-deleted) |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg (also passed to yt-dlp) |
| `MAX_DURATION_SECONDS` | `0` (off) | Optional cap on video length |

---

## Run with Docker

```bash
docker build -t reelgrab .
docker run -p 3000:3000 reelgrab
```

The image installs `yt-dlp` + `ffmpeg`, so nothing else is needed. Deploy it to any container host (Railway, Render, Fly.io, a VPS…).

> ⚠️ This app needs a **persistent Node server with binaries and a writable filesystem**. It is *not* a fit for static/edge hosts like Cloudflare Pages or Vercel Edge — use a container or Node runtime.

---

## Architecture

```
youtube-converter/
├── server.js              # Express app: wiring, static, handler registration
├── src/
│   ├── config.js          # env-driven config
│   ├── registry.js        # source-handler registry (the expandability core)
│   ├── converter.js       # job store + orchestration + cleanup
│   ├── handlers/
│   │   ├── youtube.js      # YouTube handler (reference implementation)
│   │   └── _template.js    # copy-me starter for new platforms
│   ├── routes/api.js       # REST + SSE endpoints
│   └── utils/ytdlp.js      # yt-dlp wrapper (probe, metadata, download)
└── public/                # the beautiful frontend (no build step)
    ├── index.html
    ├── styles.css
    └── app.js
```

### Request flow

1. **`POST /api/metadata`** → registry picks a handler → `fetchMetadata()` → preview card (title, thumbnail, duration, formats).
2. **`POST /api/jobs`** → creates a job, returns its `id`; conversion starts in the background.
3. **`GET /api/jobs/:id/events`** (SSE) → streams `{ status, percent, speed, eta, label }` until `done`/`error`.
4. **`GET /api/jobs/:id/download`** → streams the finished file with a friendly filename.

Files are wiped per-job after `JOB_TTL_MS`. There's also `GET /api/sources`, `GET /api/jobs/:id`, and `DELETE /api/jobs/:id` (cancel).

---

## Adding a new platform

The whole point of the architecture. Three steps:

1. **Copy** `src/handlers/_template.js` → `src/handlers/vimeo.js`.
2. **Implement** the interface:

   ```js
   export default {
     id: 'vimeo',
     name: 'Vimeo',
     matchPattern: /vimeo\.com\//i,
     formats: { mp4: {...}, mp3: {...} },
     validateUrl(url) { ... },
     async fetchMetadata(url) { ... },      // → { title, thumbnail, duration, ... }
     download(url, { format, quality, outDir }) { ... } // → EventEmitter
   };
   ```

   Most sites are already supported by yt-dlp, so you can reuse the shared
   `fetchInfo()` / `runDownload()` helpers — often the handler is just a new
   `matchPattern` and a tweaked quality ladder.

3. **Register** it in `server.js`:

   ```js
   import vimeo from './src/handlers/vimeo.js';
   registry.register(vimeo);
   ```

That's it. The frontend automatically accepts the new URLs, shows previews, streams progress and serves downloads — no UI changes required.

---

## Legal & responsible use

This tool is for downloading content **you own or have the right to use** (your own uploads, Creative Commons / public-domain works, or media you have explicit permission to download).

Downloading copyrighted content without authorization may violate the source platform's Terms of Service and applicable copyright law. **You are responsible for how you use it.** Respect creators and the law.

---

## License

MIT.
