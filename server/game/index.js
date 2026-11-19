import express from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Server, Room } from '@colyseus/core';
import { Schema, MapSchema, defineTypes } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';

const app = express();
const origin = process.env.PUBLIC_ORIGIN ?? 'http://localhost';
const key = readFileSync(process.env.JWT_PUBLIC_KEY, 'utf8');
app.disable('x-powered-by');
app.use(helmet({ hsts: process.env.COOKIE_SECURE === 'true' ? { maxAge: 31536000, includeSubDomains: true } : false, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", origin.replace(/^http/, 'ws'), origin], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"] } } }));
app.use(express.static('public', { index: 'index.html', maxAge: '1h' }));
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
      if (now - meta.lastMove < 50) return;
      meta.lastMove = now;
      if (!data || typeof data !== 'object' || !['x','y','z'].every(k => Number.isFinite(data[k]) && Math.abs(data[k]) <= 1000)) return;
      const player = this.state.players[client.sessionId];
      if (player) { player.x = data.x; player.y = data.y; player.z = data.z; }
    });
    this.onMessage('chat', (client, data) => {
      const meta = client.userData;
      if (Date.now() - meta.lastChat < 500) return;
      meta.lastChat = Date.now();
      if (typeof data?.message !== 'string' || data.message.length < 1 || data.message.length > 200) return;
      this.broadcast('chat', { username: meta.username, message: data.message });
    });
  }
  onJoin(client, _options, auth) { client.userData = { username: auth.username, lastMove: 0, lastChat: 0 }; this.state.players[client.sessionId] = new Player(client.sessionId, auth.username); }
  onLeave(client) { delete this.state.players[client.sessionId]; }
  static onAuth(_token, _options, context) {
    if (context.headers.origin !== origin) throw new Error('Unauthorized');
    const cookie = context.headers.cookie ?? '';
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    if (!token) throw new Error('Unauthorized');
    try { return jwt.verify(decodeURIComponent(token), key, { algorithms: ['RS256'], issuer: 'amazegame-auth', audience: 'amazegame' }); }
    catch { throw new Error('Unauthorized'); }
  }
}
gameServer.define('game', GameRoom);
gameServer.listen(Number(process.env.PORT ?? 3002));
