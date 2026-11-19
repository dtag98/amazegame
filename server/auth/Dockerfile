FROM node:22-alpine
WORKDIR /app
COPY server/auth/package*.json ./
RUN npm install --omit=dev
COPY server/auth/ ./
COPY scripts/ensure-jwt-keys.mjs /usr/local/bin/ensure-jwt-keys.mjs
EXPOSE 3001
CMD ["sh", "-c", "node /usr/local/bin/ensure-jwt-keys.mjs && node index.js"]
