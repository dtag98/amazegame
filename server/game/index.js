import express from 'express';
import helmet from 'helmet';
import { createClient } from '@redis/client';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ClientState, createEndpoint, createRouter, defineServer, ServerError, Room, matchMaker } from '@colyseus/core';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { browserConfig, SESSION_ENDED_CLOSE_CODE } from '../../shared/auth.js';
import { createRevocations } from '../../shared/revocations.js';
import { connectRevocationRedis } from '../../shared/connect-revocation-redis.js';
import { revocationRedisUrl } from '../../shared/revocation-redis-config.js';
import { createRedisRevocationReader } from '../../shared/redis-revocations.js';
import { createGameAdmissions, GAME_LIMITS } from './admissions.js';
import { createSessionVerifier } from './session.js';

const app = express();
const { origin, secure, sessionCookie } = browserConfig(process.env.PUBLIC_ORIGIN);
const verifySession = createSessionVerifier(readFileSync(process.env.JWT_PUBLIC_KEY, 'utf8'), sessionCookie);
const revocationsRedisUrl = revocationRedisUrl(process.env, 'reader');
const redis = revocationsRedisUrl ? await connectRevocationRedis(createClient, revocationsRedisUrl) : null;
const revocations = redis ? await createRedisRevocationReader(redis) : createRevocations(process.env.SESSION_REVOCATIONS_DIR);
const admissions = createGameAdmissions();
const openRooms = new Set();
const activeClients = new Set();
matchMaker.controller.getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': origin });
// The app's join route is the only public entry that can allocate a game seat.
matchMaker.controller.exposedMethods = [];

function sessionIsCurrent(session) {
  return Date.now() < session.expiresAt && !revocations.isRevoked(session);
}

function readSession(cookie) {
  const session = verifySession(cookie);
  return session && sessionIsCurrent(session) ? session : null;
}

function requireActiveSession(client) {
  const player = client.userData;
  if (!player || player.ended) return false;
  if (sessionIsCurrent(player.session)) return true;

  player.ended = true;
  clearTimeout(player.expiryTimer);
  client.leave(SESSION_ENDED_CLOSE_CODE, 'Session ended');
  return false;
}

function armExpiry(client) {
  const player = client.userData;
  if (player.ended) return;
  const millisecondsLeft = player.session.expiresAt - Date.now();
  if (millisecondsLeft <= 0) {
    requireActiveSession(client);
    return;
  }
  player.expiryTimer = setTimeout(() => armExpiry(client), millisecondsLeft).unref();
}

const joinEndpoint = '/matchmake/joinOrCreate/game';
const matchmakerResponse = (body, status) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
const routes = createRouter({
  joinGame: createEndpoint(joinEndpoint, { method: 'POST', disableBody: true }, async ({ request }) => {
    if (request.headers.get('origin') !== origin) return matchmakerResponse({ error: 'Forbidden' }, 403);
    const session = readSession(request.headers.get('cookie') ?? '');
    if (!session) return matchmakerResponse({ error: 'Unauthorized' }, 401);
    const reservation = admissions.reserve(session);
    if (!reservation) return matchmakerResponse({ error: 'Game capacity reached. Try again shortly.' }, 429);

    try {
      const seat = await matchMaker.joinOrCreate('game');
      reservation.bind(seat);
      return matchmakerResponse(seat, 200);
    } catch {
      reservation.release();
      return matchmakerResponse({ error: 'No game seat is available. Try again shortly.' }, 503);
    }
  }),
}, {
  openapi: { disabled: true },
  onRequest(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/matchmake/') && path !== joinEndpoint) return new Response(null, { status: 404 });
  },
});

function verifyUpgrade({ req }) {
  if (req.headers.origin !== origin || !req.url?.startsWith('/')) return false;
  const url = new URL(`http://game${req.url}`);
  const path = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const seatIds = url.searchParams.getAll('sessionId');
  if (!path || seatIds.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(seatIds[0])
      || url.searchParams.has('reconnectionToken') || url.searchParams.has('skipHandshake')) return false;
  const [, processId, roomId] = path;
  const sessionId = seatIds[0];
  if (processId !== matchMaker.processId) return false;
  const room = matchMaker.getLocalRoomById(roomId);
  if (!(room instanceof GameRoom) || !room.hasReservedSeat(sessionId)) return false;
  const session = readSession(req.headers.cookie);
  return Boolean(session && admissions.claim({ processId, roomId, sessionId }, session, req.socket));
}

app.disable('x-powered-by');
app.use(helmet({
  strictTransportSecurity: secure ? { maxAge: 31_536_000 } : false,
  contentSecurityPolicy: { directives: {
    connectSrc: ["'self'", origin.replace(/^http/, 'ws')],
    imgSrc: ["'self'", 'data:'],
    styleSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: secure ? [] : null,
  } },
}));
app.get('/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = readSession(req.headers.cookie);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: { id: session.id, username: session.username } });
});
app.use(express.static('public', { index: 'index.html', maxAge: '1h', setHeaders(res, filePath) { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/health', (_req, res) => {
  if (revocations.isFresh && !revocations.isFresh()) {
    return res.status(503).json({ status: 'unavailable' });
  }
  res.json({ status: 'ok' });
});
class Player extends Schema { constructor(id, username) { super(); this.id = id; this.username = username; this.x = 0; this.y = 0; this.z = 0; } }
defineTypes(Player, { id: 'string', username: 'string', x: 'number', y: 'number', z: 'number' });
class GameState extends Schema { constructor() { super(); this.players = new MapSchema(); } }
defineTypes(GameState, { players: { map: Player } });
class GameRoom extends Room {
  onCreate() {
    if (openRooms.size >= GAME_LIMITS.rooms) throw new ServerError(503, 'No game room is available');
    openRooms.add(this);
    this.maxClients = GAME_LIMITS.playersPerRoom;
    this.maxMessagesPerSecond = GAME_LIMITS.messagesPerSecond;
    this.seatReservationTimeout = GAME_LIMITS.seatTimeoutSeconds;
    this.state = new GameState();
    this.onMessage('move', (client, data) => {
      if (!requireActiveSession(client)) return;
      const now = performance.now();
      const meta = client.userData;
      if (!data || typeof data !== 'object' || !Number.isFinite(data.dx) || !Number.isFinite(data.dz) || Math.abs(data.dx) > 1 || Math.abs(data.dz) > 1) return;
      if (now - meta.lastMove < 50) return;
      const elapsed = Math.min(now - meta.lastMove, 100) / 1000;
      meta.lastMove = now;
      const player = this.state.players.get(client.sessionId);
      if (player) {
        const distance = 5 * elapsed / Math.max(1, Math.hypot(data.dx, data.dz));
        player.x = Math.max(-14, Math.min(14, player.x + data.dx * distance));
        player.z = Math.max(-14, Math.min(14, player.z + data.dz * distance));
      }
    });
    this.onMessage('chat', (client, data) => {
      if (!requireActiveSession(client)) return;
      const now = performance.now();
      const meta = client.userData;
      if (now - meta.lastChat < 500 || typeof data?.message !== 'string'
          || data.message.length < 1 || data.message.length > 200) return;
      meta.lastChat = now;
      // Avoid accumulating chat for a socket that has not completed joining.
      this.broadcast('chat', { username: meta.session.username, message: data.message }, {
        except: this.clients.filter(other => other.state !== ClientState.JOINED),
      });
    });
  }

  onJoin(client) {
    const session = admissions.connectedSession({
      processId: matchMaker.processId, roomId: this.roomId, sessionId: client.sessionId,
    });
    if (!session || !sessionIsCurrent(session)) throw new ServerError(401, 'Unauthorized');

    client.userData = { session, lastMove: performance.now(), lastChat: -Infinity, ended: false };
    activeClients.add(client);
    this.state.players.set(client.sessionId, new Player(client.sessionId, session.username));
    armExpiry(client);
  }

  onLeave(client) {
    if (client.userData) {
      client.userData.ended = true;
      clearTimeout(client.userData.expiryTimer);
    }
    activeClients.delete(client);
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    openRooms.delete(this);
  }
}

const gameServer = defineServer({
  rooms: { game: GameRoom },
  routes,
  transport: new WebSocketTransport({
    server: createServer(app),
    maxPayload: 8192,
    closeTimeout: 4000,
    verifyClient: verifyUpgrade,
  }),
});
const stopWatching = revocations.watch(() => {
  for (const client of activeClients) requireActiveSession(client);
});
gameServer.onShutdown(() => {
  stopWatching();
  if (redis?.isOpen) redis.destroy();
});
gameServer.listen(Number(process.env.PORT ?? 3002));
