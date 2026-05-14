FROM node:22-alpine

# Build deps needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer caching — only re-runs when package.json changes)
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY server.js ./
COPY oid-reference.html ./

# Create data directory for SQLite database
RUN mkdir -p /data && chown node:node /data

# Run as non-root
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/oid-cache.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
