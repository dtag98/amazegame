FROM node:22-alpine AS build
WORKDIR /app
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client ./client
COPY shared ./shared
RUN cd client && npm run build

FROM node:22-alpine
WORKDIR /app
COPY server/game/package*.json ./
RUN npm install --omit=dev
COPY server/game ./
COPY --from=build /app/client/dist ./public
COPY scripts/ensure-jwt-keys.mjs ./ensure-jwt-keys.mjs
EXPOSE 3002
CMD ["node", "index.js"]
