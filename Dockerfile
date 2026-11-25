FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client ./
COPY shared /app/shared
RUN npm run build

FROM node:22.23.5-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
ENV NODE_ENV=production
WORKDIR /app/server/game
COPY server/game/package*.json ./
RUN npm ci --omit=dev \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY server/game ./
COPY shared /app/shared
COPY --from=build /app/client/dist ./public
USER node
EXPOSE 3002
CMD ["node", "index.js"]
