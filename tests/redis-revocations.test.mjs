import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { connectRevocationRedis } from '../shared/connect-revocation-redis.js';
import { createRedisRevocationReader, createRedisRevocationWriter } from '../shared/redis-revocations.js';

const revokedSession = { sessionId: 'a'.repeat(64), expiresAt: Date.now() + 60_000 };
const otherSession = { ...revokedSession, sessionId: 'b'.repeat(64) };
const flushCommand = ['WAITAOF', '1', '0', '2000'];

async function waitFor(condition) {
  const deadline = performance.now() + 1000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for the revocation watcher');
    await delay(5);
  }
}

test('Redis logout requires disk confirmation and only stores a digest and expiration', async () => {
  const calls = [];
  let writeReply = [1, 'OK', [1, 0]];
  const pipeline = {
    zAdd(key, entry) {
      calls.push(['add', key, entry]);
      return this;
    },
    set(key, value) {
      assert.equal(key, 'amazegame:revocation-sync:v1');
      assert.equal(value, '1');
      return this;
    },
    addCommand(command) {
      assert.deepEqual(command, flushCommand);
      return this;
    },
    async execAsPipeline() { return writeReply; },
  };
  const writer = await createRedisRevocationWriter({
    async sendCommand(command) {
      assert.deepEqual(command, flushCommand);
      return [1, 0];
    },
    multi: () => pipeline,
    async zRemRangeByScore(...args) { calls.push(['prune', ...args]); },
  });
  await writer.revoke(revokedSession);
  await writer.revoke({ ...otherSession, expiresAt: Date.now() - 1 });
  await assert.rejects(writer.revoke({ ...otherSession, sessionId: 'raw-token' }), /Invalid session metadata/);
  await writer.prune(revokedSession.expiresAt);
  assert.deepEqual(calls, [
    ['add', 'amazegame:revocations:v1', [{ score: revokedSession.expiresAt, value: revokedSession.sessionId }]],
    ['prune', 'amazegame:revocations:v1', '-inf', revokedSession.expiresAt],
  ]);

  writeReply = [0, 'OK', [0, 0]];
  await assert.rejects(writer.revoke(otherSession), /not confirmed on disk/);
  writeReply = [1, 'OK', [1, 0]];
  await writer.revoke(otherSession);
  assert.equal(calls.length, 4, 'a failed write is retried');
  await assert.rejects(createRedisRevocationWriter({ sendCommand: async () => [0, 0] }), /not confirmed on disk/);
});

test('Redis writer batches distinct logouts and coalesces pending and recently persisted duplicates', async () => {
  const firstFlush = Promise.withResolvers();
  const batches = [];
  let now = 0;
  const writer = await createRedisRevocationWriter({
    sendCommand: async () => [1, 0],
    multi() {
      return {
        zAdd(_key, entries) { batches.push(entries); return this; },
        set() { return this; },
        addCommand() { return this; },
        execAsPipeline() { return batches.length === 1 ? firstFlush.promise : Promise.resolve([2, 'OK', [1, 0]]); },
      };
    },
  }, { monotonicNow: () => now });

  const first = writer.revoke(revokedSession);
  const second = writer.revoke(otherSession);
  const retry = writer.revoke(revokedSession);
  const secondRetry = writer.revoke(otherSession);
  assert.deepEqual(batches.map(items => items.length), [1]);
  firstFlush.resolve([1, 'OK', [1, 0]]);
  await Promise.all([first, second, retry, secondRetry]);
  await writer.revoke(revokedSession);
  assert.deepEqual(batches.map(items => items.length), [1, 1]);
  now = 30_001;
  await writer.revoke(revokedSession);
  assert.deepEqual(batches.map(items => items.length), [1, 1, 1]);
});

test('Redis readers start with a snapshot and verify revocations in memory', async context => {
  let reads = 0;
  let sessionIds = [revokedSession.sessionId];
  const reader = await createRedisRevocationReader({
    async zRangeByScore(key, min, max, options) {
      reads++;
      assert.equal(key, 'amazegame:revocations:v1');
      assert.ok(Number.isSafeInteger(min));
      assert.equal(max, '+inf');
      assert.equal(options.LIMIT.offset, 0);
      return sessionIds;
    },
  }, { refreshIntervalMs: 5 });

  assert.equal(reader.isRevoked(revokedSession), true);
  assert.equal(reader.isRevoked(otherSession), false);
  assert.equal(reads, 1);
  sessionIds = [revokedSession.sessionId, otherSession.sessionId];
  let observed = false;
  context.after(reader.watch(() => { observed ||= reader.isRevoked(otherSession); }));
  await waitFor(() => observed);
  assert.equal(reader.isFresh(), true);
});

test('Redis reader fails closed as a snapshot ages and rejects late responses', async context => {
  let reads = 0;
  let now = 0;
  const pending = Promise.withResolvers();
  const reader = await createRedisRevocationReader({
    async zRangeByScore() {
      reads++;
      if (reads === 1) return [];
      if (reads === 2) return pending.promise;
      throw new Error('Redis disconnected');
    },
  }, { refreshIntervalMs: 5, maxSnapshotAgeMs: 30, monotonicNow: () => now });
  let observedStaleness = false;
  context.after(reader.watch(() => { observedStaleness ||= !reader.isFresh(); }));
  await waitFor(() => reads === 2);
  now = 31;
  await waitFor(() => observedStaleness);
  assert.equal(reads, 2, 'refreshes do not overlap');
  assert.equal(reader.isRevoked(otherSession), true);
  pending.resolve([]);
  await waitFor(() => reads >= 3);
  assert.equal(reader.isFresh(), false, 'late response does not clear staleness');
  assert.equal(reader.isRevoked(otherSession), true);
});

test('a stalled Redis snapshot resets the connection and the reader resumes', async context => {
  let reads = 0;
  let resets = 0;
  let now = 0;
  const pending = Promise.withResolvers();
  const reader = await createRedisRevocationReader({
    async zRangeByScore() {
      reads++;
      if (reads === 1) return [];
      if (reads === 2) return pending.promise;
      return [revokedSession.sessionId];
    },
    reset() { resets++; },
  }, { refreshIntervalMs: 5, maxSnapshotAgeMs: 30, readDeadlineMs: 80, monotonicNow: () => now });

  let observedStaleness = false;
  context.after(reader.watch(() => { observedStaleness ||= !reader.isFresh(); }));
  await waitFor(() => reads === 2);
  now = 31;
  await waitFor(() => observedStaleness);
  assert.equal(reader.isRevoked(otherSession), true);
  await waitFor(() => resets === 1 && reader.isFresh());
  assert.equal(reader.isRevoked(revokedSession), true);
  assert.equal(reader.isRevoked(otherSession), false);
  pending.resolve([otherSession.sessionId]);
  await delay(10);
  assert.equal(reader.isRevoked(otherSession), false, 'the abandoned read cannot replace the snapshot');
});

test('Redis reset retires the stalled client and shutdown prevents further reconnects', async () => {
  const clients = [];
  const redis = await connectRevocationRedis(() => {
    const client = new EventEmitter();
    client.connect = async () => { client.isOpen = true; };
    client.destroy = () => { client.isOpen = false; };
    client.zRangeByScore = () => clients.indexOf(client);
    clients.push(client);
    return client;
  }, 'redis://example.invalid');

  assert.equal(redis.zRangeByScore(), 0);
  redis.reset();
  assert.equal(clients[0].isOpen, false);
  assert.equal(redis.zRangeByScore(), 1);
  redis.destroy();
  redis.reset();
  assert.equal(redis.isOpen, false);
  assert.equal(clients.length, 2);
});

test('stopping the watcher prevents a pending timeout from reconnecting', async () => {
  let reads = 0;
  let resets = 0;
  const reader = await createRedisRevocationReader({
    zRangeByScore() {
      reads++;
      if (reads === 1) return [];
      return new Promise(() => {});
    },
    reset() { resets++; },
  }, { refreshIntervalMs: 5, readDeadlineMs: 50 });
  const stop = reader.watch(() => {});
  await waitFor(() => reads === 2);
  stop();
  await delay(70);
  assert.equal(resets, 0);
  assert.equal(reads, 2);
});

test('Redis reader refuses startup with malformed revocation data and closes the client', async () => {
  let closed = false;
  await assert.rejects(createRedisRevocationReader({
    zRangeByScore: async () => ['unexpected-value'],
    destroy() { closed = true; },
  }), /Invalid session revocation snapshot/);
  assert.equal(closed, true);
});
