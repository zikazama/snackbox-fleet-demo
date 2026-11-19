# SnackBox demo — no build step, no dependencies, just Node.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/snackbox.db

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY api ./api
COPY public ./public

# Writable volume for the SQLite file (docker-compose mounts a named volume here).
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 8080
CMD ["node", "server.js"]
