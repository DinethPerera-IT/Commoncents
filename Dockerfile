FROM node:22-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
COPY SCHEMA.sql ./
RUN mkdir -p /app/data && chown -R app:app /app/data
USER app
EXPOSE 3040
CMD ["node", "server/index.js"]
