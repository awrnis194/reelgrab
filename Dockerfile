# ReelGrab — live crypto calculators.
# Static SPA served by a tiny Express server; all market data is fetched
# client-side from CoinGecko, so no extra system binaries are needed.
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
