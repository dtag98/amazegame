import test from 'node:test';
import assert from 'node:assert/strict';
import { appendChatMessage, createGameSession } from '../client/src/game-session.js';

function makeHarness() {
  const events = new Map();
  const room = {
    sends: [],
    leaveCalls: 0,
    onMessage(type, callback) { events.set(type, callback); },
    onLeave(callback) { events.set('leave', callback); },
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

test('a server-side session close clears the current room and reports its reason', async () => {
  const harness = makeHarness();
  const closeCodes = [];
  const receivedChat = [];
  const session = createGameSession({
    joinRoom: async () => harness.room,
    onRoom() {},
    onRoomLeft: code => closeCodes.push(code),
    onChat: message => receivedChat.push(message),
  });
  await session.start(true);
  harness.events.get('leave')(4401);
  harness.events.get('chat')('late message');
  assert.equal(session.connected, false);
  assert.deepEqual(closeCodes, [4401]);
  assert.deepEqual(receivedChat, []);
});

test('logout while a room join is pending closes the late room', async () => {
  const harness = makeHarness();
  let finishJoin;
  const session = createGameSession({
    joinRoom: () => new Promise(resolve => { finishJoin = resolve; }),
    onRoom() { assert.fail('the late room must stay hidden'); },
    onChat() {},
  });
  const pending = session.start(true);
  session.disconnect();
  finishJoin(harness.room);
  assert.equal(await pending, undefined);
  assert.equal(harness.room.leaveCalls, 1);
  assert.equal(session.connected, false);
});

test('late matchmaking errors do not change the signed-out state', async () => {
  let rejectJoin;
  const session = createGameSession({
    joinRoom: () => new Promise((resolve, reject) => { rejectJoin = reject; }),
    onChat() {},
    onRoom() {},
  });
  const pending = session.start(true);
  session.disconnect();
  rejectJoin(new Error('Join did not finish'));
  assert.equal(await pending, undefined);
  assert.equal(session.connected, false);
});

test('chat retains the latest 100 entries and writes messages as text', () => {
  const children = [];
  const list = {
    ownerDocument: {
      createElement(tag) {
        return {
          tag,
          set innerHTML(_) { assert.fail('chat should render text only'); },
          remove() { children.splice(children.indexOf(this), 1); },
        };
      },
    },
    append(item) { children.push(item); },
    get childElementCount() { return children.length; },
    get firstElementChild() { return children[0]; },
  };

  for (let index = 0; index < 101; index++) {
    appendChatMessage(list, { username: 'player', message: `<${index}>` });
  }
  assert.equal(list.childElementCount, 100);
  assert.equal(children[0].textContent, 'player: <1>');
  assert.equal(children.at(-1).textContent, 'player: <100>');
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
