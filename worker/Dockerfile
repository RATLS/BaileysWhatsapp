FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Heap sizing lives here (not NODE_OPTIONS): CMD args are passed straight to
# node, so any valid V8 flag works and an invalid one fails loudly at startup
# instead of the cryptic exit-9 loop NODE_OPTIONS' allowlist causes.
# Fails as "unhealthy" if start() never runs or the process is wedged
# (heartbeat file missing or older than 3 missed 30s ticks).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "process.exit(Date.now()-require('fs').statSync('/tmp/worker-heartbeat').mtimeMs<90000?0:1)"

CMD ["node", "--max-old-space-size=512", "index.js"]
