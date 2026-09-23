FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
EXPOSE 3040
CMD ["node", "server/index.js"]
