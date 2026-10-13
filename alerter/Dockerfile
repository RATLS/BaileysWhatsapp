FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Small service: cap the heap so it can never crowd out the worker.
CMD ["node", "--max-old-space-size=64", "index.js"]
