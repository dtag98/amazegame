FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ENV NODE_ENV=production
WORKDIR /app/server/auth
COPY server/auth/package*.json ./
RUN npm ci --omit=dev \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY server/auth/ ./
COPY shared /app/shared
COPY scripts/ensure-jwt-keys.mjs /app/scripts/ensure-jwt-keys.mjs
RUN mkdir -p /run/jwt-private /run/jwt-public /run/session-revocations \
    && touch /run/jwt-private/.volume /run/jwt-public/.volume /run/session-revocations/.volume \
    && chown -R node:node /run/jwt-private /run/jwt-public /run/session-revocations \
    && chmod 0700 /run/jwt-private /run/session-revocations
USER node
EXPOSE 3001
CMD ["sh", "-c", "node /app/scripts/ensure-jwt-keys.mjs && exec node index.js"]
