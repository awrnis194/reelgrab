# ReelGrab — Beautiful Media Converter

A stunning, production-ready web app that converts online video to **MP4** (video) and **MP3** (audio). Paste a link, pick a format, watch live progress, and download a clean file.

Built around an **expandable source-handler registry** — adding a new platform (Vimeo, TikTok, …) is literally one new file in `src/handlers/` plus one line in `server.js`.

> **How it gets past YouTube's datacenter block:** YouTube refuses ("Sign in to confirm you're not a bot") any request from a datacenter IP — i.e. every free cloud host. ReelGrab therefore **never extracts from YouTube directly on the server.** Instead it resolves each link through a *pool of free, community-run resolver services* (**Cobalt** and **Piped**) that run on trusted IPs and **proxy the media bytes back** to us. The app then downloads + muxes/transcodes those proxied streams with `ffmpeg`. This is what makes the site work on a free, always-on host with no cookies, no proxy bill, and no machine of your own to keep awake. See [Extraction & reliability](#extraction--reliability).

![ReelGrab](public/favicon.svg)

---

## Highlights

- 🎨 **Aurora-glass UI** — animated mesh backdrop, glassmorphic card, fluid micro-interactions, dark/light themes (system-aware + remembered).
- ⚡ **Live progress** over Server-Sent Events — real percent, speed and ETA, plus phase labels (downloading → merging → finalizing).
- 🧩 **Expandable by design** — a clean handler interface; the UI, streaming, download and cleanup are platform-agnostic.
- 📱 **Responsive** — looks great on desktop, tablet and mobile.
- 🛡️ **Safe execution** — binaries are spawned with argument arrays (never a shell), inputs are validated against allow-lists.
- 🌐 **Datacenter-proof extraction** — multi-provider resolver pool (Cobalt → Piped → yt-dlp) with automatic failover, so a single instance going down doesn't take the site offline.
- 🐳 **One-command Docker** — image bundles `ffmpeg` + `yt-dlp` + `deno`.

---

## Requirements

Primary extraction goes through the Cobalt/Piped provider pools (just HTTP — no binaries needed). For local processing and the fallback path you want:

| Tool | Why | Install |
|------|-----|---------|
| **ffmpeg** | **Required.** Merge video+audio, transcode MP3 | `brew install ffmpeg` · [downloads](https://ffmpeg.org/download.html) |
| **yt-dlp** | Optional last-resort extractor (and non-YouTube sites) | `brew install yt-dlp` · [other methods](https://github.com/yt-dlp/yt-dlp#installation) |
| **deno** | Optional — lets yt-dlp solve YouTube's JS challenges | `brew install deno` |

Plus **Node.js ≥ 18.18** (uses the built-in `fetch`).

> On Linux these are all installed for you by the Dockerfile. `ffmpeg` is the only hard requirement; without `yt-dlp`/`deno` the app simply skips the fallback and relies on the provider pools.

---

## Run it locally

```bash
cd youtube-converter
npm install
npm start
# → http://localhost:3000
```

`npm run dev` restarts on file changes. The banner shows the provider pool sizes plus whether `ffmpeg`/`yt-dlp` were found — `ffmpeg` is required; `yt-dlp` is only the fallback.

### Configuration (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DOWNLOAD_DIR` | system temp | Where files are staged before download |
| `JOB_TTL_MS` | `1800000` | How long a finished file is kept (then auto-deleted) |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg (also passed to yt-dlp) |
| `MAX_DURATION_SECONDS` | `0` (off) | Optional cap on video length |
| `COBALT_INSTANCES` | built-in list | Comma-separated Cobalt API base URLs (failover pool) |
| `PIPED_INSTANCES` | built-in list | Comma-separated Piped API base URLs (failover pool) |
| `PROVIDER_TIMEOUT_MS` | `20000` | Per-instance resolve timeout |
| `ENABLE_YTDLP_FALLBACK` | `true` | Set `false` to disable the direct-yt-dlp last resort |

> **When downloads start failing,** the usual cause is that the free public instances rotated. Probe live health at `GET /api/health?deep=1`, then refresh the pool by setting `COBALT_INSTANCES` / `PIPED_INSTANCES` (on Render: Environment → edit the var → save; no code redeploy needed).

---

## Run with Docker

```bash
docker build -t reelgrab .
docker run -p 3000:3000 reelgrab
```

The image installs `ffmpeg` + `yt-dlp` + `deno`, so nothing else is needed. Deploy it to any container host (Railway, Render, Fly.io, a VPS…). Extraction works from a datacenter IP because it goes through the Cobalt/Piped provider pools, not YouTube directly.

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
│   │   ├── youtube.js      # YouTube handler (delegates to the resolver stack)
│   │   └── _template.js    # copy-me starter for new platforms
│   ├── routes/api.js       # REST + SSE endpoints (+ /health?deep=1 diagnostics)
│   └── utils/
│       ├── providers.js    # Cobalt + Piped resolver pools + metadata (oEmbed)
│       ├── execute.js      # strategy stack: Cobalt → Piped → yt-dlp, with failover
│       ├── media.js        # download-with-progress + ffmpeg (merge / mp3 / remux)
│       └── ytdlp.js        # yt-dlp wrapper (last-resort + non-YouTube sites)
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

Files are wiped per-job after `JOB_TTL_MS`. There's also `GET /api/sources`, `GET /api/jobs/:id`, `DELETE /api/jobs/:id` (cancel), and `GET /api/health?deep=1` (live provider probe).

---

## Extraction & reliability

**The problem.** YouTube blocks every datacenter IP (Render, Fly, Railway, Oracle…) with *"Sign in to confirm you're not a bot."* Cookies are a band-aid that Google deliberately expires within ~an hour on datacenter IPs. A free, always-on host simply cannot extract from YouTube directly.

**The fix.** Don't extract on the server at all. For each job, `execute.js` walks a strategy stack and stops at the first one that yields a file:

1. **Cobalt pool** — POST to community Cobalt instances; they extract at full quality (H.264 for universal playback) and return **tunnel URLs proxied through the instance**, so the bytes are fetchable from any IP. Best quality, proper audio.
2. **Piped pool** — `/streams/{id}` on community Piped instances; pick a progressive stream or mux best video+audio. URLs are instance-proxied too.
3. **yt-dlp direct** — last resort. Works locally (residential IP) and for many non-YouTube sites; usually blocked for YouTube on a datacenter, but free to try.

Each provider is a **pool**: instances are tried in order, the working one is promoted to the front, and any error/rate-limit fails over to the next — across providers and finally to yt-dlp.

**Honest caveat.** This rides on free, volunteer-run infrastructure, which is sparse and shifts over time. Expect the occasional retry or a quality step-down when the best instance is busy. When things degrade, that's not a code bug — it's an instance that rotated: check `GET /api/health?deep=1` and refresh `COBALT_INSTANCES` / `PIPED_INSTANCES`. This is the price of *free + always-on + no machine of your own* — the one combination that has no paid or self-hosted escape hatch, since reliable YouTube access fundamentally needs a residential IP.

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
