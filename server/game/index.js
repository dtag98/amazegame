import express from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { createServer, request as httpProxyRequest } from 'node:http';
import { request as httpsProxyRequest } from 'node:https';
import { Server, Room } from '@colyseus/core';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';

const app = express();
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost';
const jwtSecret = process.env.JWT_SECRET;
const jwtAlgorithm = jwtSecret ? 'HS256' : 'RS256';
const publicKeyPath = process.env.JWT_PUBLIC_KEY;
if (!jwtSecret && !publicKeyPath) {
  throw new Error('JWT key is not configured. Set JWT_SECRET on this service, or set JWT_PUBLIC_KEY to a mounted PEM file.');
}
const verificationKey = jwtSecret ?? readFileSync(publicKeyPath, 'utf8');
app.disable('x-powered-by');
app.use(helmet({ hsts: process.env.COOKIE_SECURE === 'true' ? { maxAge: 31536000, includeSubDomains: true } : false, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", origin.replace(/^http/, 'ws'), origin], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"] } } }));
const authServiceUrl = process.env.AUTH_SERVICE_URL;
const authTarget = authServiceUrl
  ? new URL(authServiceUrl)
  : new URL(`http://${process.env.AUTH_SERVICE_HOSTPORT ?? 'localhost:3001'}`);
if (!['http:', 'https:'].includes(authTarget.protocol)) throw new Error('AUTH_SERVICE_URL must use http or https.');
app.use('/api', (req, res) => {
  if (req.method !== 'GET' && req.headers.origin !== origin) return res.status(403).json({ error: 'Forbidden' });
  const proxyRequest = authTarget.protocol === 'https:' ? httpsProxyRequest : httpProxyRequest;
  const basePath = authTarget.pathname.replace(/\/$/, '');
  const upstream = proxyRequest({ hostname: authTarget.hostname, port: authTarget.port || undefined, path: `${basePath}${req.url}`, method: req.method, headers: { ...req.headers, host: authTarget.host } }, response => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Authentication service unavailable' }); else res.destroy(); });
  upstream.setTimeout(90000, () => upstream.destroy(new Error('Authentication service timed out')));
  req.pipe(upstream);
});
app.use(express.static('public', { index: 'index.html', maxAge: '1h', setHeaders(res, filePath) { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
const httpServer = createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer, maxPayload: 8192 }) });
class Player extends Schema { constructor(id, username) { super(); this.id = id; this.username = username; this.x = 0; this.y = 0; this.z = 0; } }
defineTypes(Player, { id: 'string', username: 'string', x: 'number', y: 'number', z: 'number' });
class GameState extends Schema { constructor() { super(); this.players = new MapSchema(); } }
defineTypes(GameState, { players: { map: Player } });
class GameRoom extends Room {
  onCreate() {
    this.maxClients = 16;
    this.setState(new GameState());
    this.onMessage('move', (client, data) => {
      const now = Date.now();
      const meta = client.userData;
      if (!data || typeof data !== 'object' || !Number.isFinite(data.dx) || !Number.isFinite(data.dz) || Math.abs(data.dx) > 1 || Math.abs(data.dz) > 1) return;
      if (now - meta.lastMove < 50) return;
      const elapsed = Math.min(now - meta.lastMove, 100) / 1000;
      meta.lastMove = now;
      const player = this.state.players.get(client.sessionId);
      if (player) {
        const speed = 5;
        player.x = Math.max(-14, Math.min(14, player.x + data.dx * speed * elapsed));
        player.z = Math.max(-14, Math.min(14, player.z + data.dz * speed * elapsed));
      }
    });
    this.onMessage('chat', (client, data) => {
      const meta = client.userData;
      if (Date.now() - meta.lastChat < 500) return;
      meta.lastChat = Date.now();
      if (typeof data?.message !== 'string' || data.message.length < 1 || data.message.length > 200) return;
      this.broadcast('chat', { username: meta.username, message: data.message });
    });
  }
  onJoin(client, _options, auth) { client.userData = { username: auth.username, lastMove: Date.now(), lastChat: 0 }; this.state.players.set(client.sessionId, new Player(client.sessionId, auth.username)); }
  onLeave(client) { this.state.players.delete(client.sessionId); }
  static onAuth(_token, _options, context) {
    if (context.headers.origin !== origin) throw new Error('Unauthorized');
    const cookie = context.headers.cookie ?? '';
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    if (!token) throw new Error('Unauthorized');
    try { return jwt.verify(decodeURIComponent(token), verificationKey, { algorithms: [jwtAlgorithm], issuer: 'amazegame-auth', audience: 'amazegame' }); }
    catch { throw new Error('Unauthorized'); }
  }
}
gameServer.define('game', GameRoom);
gameServer.listen(Number(process.env.PORT ?? 3002));
