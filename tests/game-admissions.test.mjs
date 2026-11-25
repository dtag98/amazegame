import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createGameAdmissions } from '../server/game/admissions.js';

const gameSeat = { processId: 'game-process', roomId: 'room', sessionId: 'seat' };
const player = { id: 'player', sessionId: 'signed-session' };
const otherPlayer = { id: 'other', sessionId: 'other-session' };

test('in-flight reservations count toward both server and account limits', () => {
  const admissions = createGameAdmissions({ totalLimit: 3, pendingLimit: 2, accountLimit: 1 });
  const first = admissions.reserve(player);
  assert.ok(first);
  assert.equal(admissions.reserve({ ...player, sessionId: 'new-login' }), null);

  const second = admissions.reserve(otherPlayer);
  assert.ok(second);
  const third = { id: 'third', sessionId: 'third-session' };
  assert.equal(admissions.reserve(third), null);
  first.release();
  assert.ok(admissions.reserve(third));
});

test('an active socket keeps its slot and a reserved seat belongs to its signed session', () => {
  const admissions = createGameAdmissions({ totalLimit: 1, pendingLimit: 1, accountLimit: 1 });
  admissions.reserve(player).bind(gameSeat);
  const socket = new EventEmitter();
  const anotherSession = { ...player, sessionId: 'another-session' };
  assert.equal(admissions.claim(gameSeat, anotherSession, socket), false);
  assert.equal(admissions.claim({ ...gameSeat, roomId: 'other-room' }, player, socket), false);
  assert.equal(admissions.claim(gameSeat, player, socket), true);
  assert.deepEqual(admissions.connectedSession(gameSeat), player);
  assert.equal(admissions.reserve(otherPlayer), null);
  assert.equal(admissions.claim(gameSeat, player, new EventEmitter()), false);

  socket.emit('close');
  socket.emit('close');
  assert.equal(admissions.connectedSession(gameSeat), null);
  assert.ok(admissions.reserve(otherPlayer));
});

test('unused seats release their slot at the reservation deadline', async () => {
  const admissions = createGameAdmissions({ totalLimit: 1, pendingLimit: 1, accountLimit: 1, seatTimeoutMs: 20 });
  const reservation = admissions.reserve(player);
  reservation.bind(gameSeat);
  await delay(35);
  assert.equal(admissions.claim(gameSeat, player, new EventEmitter()), false);
  reservation.release();
  assert.ok(admissions.reserve(otherPlayer));
});
