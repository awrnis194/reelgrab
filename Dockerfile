# ReelGrab — Beautiful Media Converter
# Ships with yt-dlp + ffmpeg so it runs anywhere a container does.
FROM node:20-slim

# System deps: ffmpeg (merge/extract) + yt-dlp (downloader).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
