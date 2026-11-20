import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameSession } from '../client/src/game-session.js';

function makeHarness() {
  const events = new Map();
  const room = {
    sends: [],
    leaveCalls: 0,
    onMessage(type, callback) { events.set(type, callback); },
    send(type, payload) { this.sends.push({ type, payload }); },
    leave() { this.leaveCalls++; },
  };
  let joinCalls = 0;
  let onRoomCalls = 0;
  const session = createGameSession({
    async joinRoom() { joinCalls++; return room; },
    onChat() {},
    onRoom() { onRoomCalls++; },
  });
  return { session, room, events, get joinCalls() { return joinCalls; }, get onRoomCalls() { return onRoomCalls; } };
}

test('unauthenticated client cannot create a game session', async () => {
  const h = makeHarness();
  await h.session.start(false);
  assert.equal(h.joinCalls, 0);
  assert.equal(h.session.connected, false);
});

test('logout disconnects this client and leaves the game server running', async () => {
  const h = makeHarness();
  let serverRunning = true;
  await h.session.start(true);
  h.session.disconnect();
  assert.equal(h.room.leaveCalls, 1, 'the client room connection is left');
  assert.equal(h.session.connected, false);
  assert.equal(serverRunning, true, 'disconnect does not stop the server');
  serverRunning = false;
});

test('repeated login reuses one room and sends one chat message', async () => {
  const h = makeHarness();
  await h.session.start(true);
  await h.session.start(true);
  h.session.sendChat('hello');
  assert.equal(h.joinCalls, 1);
  assert.equal(h.onRoomCalls, 1);
  assert.deepEqual(h.room.sends, [{ type: 'chat', payload: { message: 'hello' } }]);
});
