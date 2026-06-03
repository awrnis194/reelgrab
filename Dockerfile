# ReelGrab — media converter
# Bundles ffmpeg (mux/transcode) + yt-dlp & deno (last-resort extractor).
# Primary extraction goes through the Cobalt/Piped provider pools, which need no
# binaries — but we ship these so the yt-dlp fallback and non-YouTube sites work.
FROM node:20-slim

# System deps. deno lets yt-dlp solve YouTube's JS challenges when it's used.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl unzip \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
  && unzip -o /tmp/deno.zip -d /usr/local/bin \
  && chmod a+rx /usr/local/bin/deno \
  && rm -f /tmp/deno.zip \
  && apt-get purge -y unzip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
