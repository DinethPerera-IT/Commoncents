# Node 24 = current LTS (Node 20 reached end-of-life in April 2026).
FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# npm ci installs exactly what package-lock.json says: the same versions on every build.
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY public ./public
COPY migrations ./migrations
# Only the data folder is writable by the app user; its own code stays read-only to it.
RUN mkdir -p /app/data && chown -R app:app /app/data
USER app
EXPOSE 3040
# Docker marks the container unhealthy if /healthz (app + database) stops answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3040/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/index.js"]
