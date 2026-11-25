import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createLoginThrottle, createPasswordWorkQueue, PasswordWorkTimeoutError } from '../server/auth/password-work.js';

test('password work bounds active and waiting jobs and releases slots on failure', async () => {
  const queue = createPasswordWorkQueue({ maxActive: 2, maxQueuedPerKind: 1 });
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const started = [];
  const firstJob = queue.run('login', () => {
    started.push('first');
    return first.promise;
  });
  const secondJob = queue.run('register', () => {
    started.push('second');
    return second.promise;
  });
  const waitingJob = queue.run('login', () => {
    started.push('waiting');
    return 'done';
  });
  assert.equal(queue.run('login', () => assert.fail('A saturated queue admitted more work')), null);
  await setImmediate();
  assert.deepEqual(started, ['first', 'second']);

  const failedJob = assert.rejects(firstJob, /verification failed/);
  first.reject(new Error('verification failed'));
  await failedJob;
  assert.equal(await waitingJob, 'done');
  assert.deepEqual(started, ['first', 'second', 'waiting']);
  second.resolve(true);
  assert.equal(await secondJob, true);
  assert.equal(await queue.run('register', () => 'reused'), 'reused');
});

test('signup cannot fill the login queue and both queues get turns in order', async () => {
  const queue = createPasswordWorkQueue({ maxActive: 1, maxQueuedPerKind: 2 });
  const active = Promise.withResolvers();
  const started = [];
  const first = queue.run('register', () => active.promise);
  const signupOne = queue.run('register', () => started.push('signup one'));
  const signupTwo = queue.run('register', () => started.push('signup two'));
  assert.equal(queue.run('register', () => assert.fail('The signup queue was full')), null);

  const loginOne = queue.run('login', () => started.push('login one'));
  const loginTwo = queue.run('login', () => started.push('login two'));
  assert.ok(loginOne);
  assert.ok(loginTwo);
  assert.equal(queue.run('login', () => assert.fail('The login queue was full')), null);

  active.resolve();
  await Promise.all([first, signupOne, signupTwo, loginOne, loginTwo]);
  assert.deepEqual(started, ['login one', 'signup one', 'login two', 'signup two']);
});

test('waiting work expires and frees its slot while active work can finish', async () => {
  const queue = createPasswordWorkQueue({ maxActive: 1, maxQueuedPerKind: 1, queueTimeoutMs: 25 });
  const active = Promise.withResolvers();
  const first = queue.run('login', () => active.promise);
  const expired = queue.run('register', () => assert.fail('Expired work ran'));
  await assert.rejects(expired, PasswordWorkTimeoutError);

  const replacement = queue.run('register', () => 'replacement');
  assert.ok(replacement);
  active.resolve('active');
  assert.equal(await first, 'active');
  assert.equal(await replacement, 'replacement');
});

test('work past its deadline cannot start before the expiration timer runs', async context => {
  let now = 0;
  context.mock.method(performance, 'now', () => now);
  const queue = createPasswordWorkQueue({ maxActive: 1 });
  const active = Promise.withResolvers();
  const first = queue.run('login', () => active.promise);
  const expired = queue.run('login', () => assert.fail('Expired work ran'));
  const rejected = assert.rejects(expired, PasswordWorkTimeoutError);

  now = 30_001;
  active.resolve();
  await Promise.all([first, rejected]);
});

test('login throttling serializes a username and backs off after repeated failures', () => {
  let now = 0;
  const login = createLoginThrottle({ now: () => now });
  const first = login.begin('player_one');
  assert.deepEqual(login.begin('player_one'), { status: 429, retryAfter: 1 });
  login.begin('player_two').finish(true);
  first.finish(false);
  login.begin('player_one').finish(false);
  login.begin('player_one').finish(false);
  assert.deepEqual(login.begin('player_one'), { status: 429, retryAfter: 1 });

  now += 1_000;
  login.begin('player_one').finish(); // A refused work item does not reset or add a failure.
  login.begin('player_one').finish(false);
  assert.deepEqual(login.begin('player_one'), { status: 429, retryAfter: 2 });

  for (const seconds of [2, 4, 8, 16, 30, 30]) {
    now += seconds * 1_000;
    login.begin('player_one').finish(false);
    assert.equal(login.begin('player_one').retryAfter, Math.min(30, seconds * 2));
  }
  now += 30_000;
  login.begin('player_one').finish(true);
  login.begin('player_one').finish(false);
  login.begin('player_one').finish(true);
});

test('login throttling bounds tracked usernames and frees expired or unsuccessful admissions', () => {
  let now = 0;
  const login = createLoginThrottle({ maxEntries: 1, now: () => now });
  login.begin('player_one').finish();
  login.begin('player_two').finish(false);
  assert.deepEqual(login.begin('player_one'), { status: 503, retryAfter: 15 });
  now += 15 * 60_000;
  login.begin('player_one').finish(true);
  login.begin('player_two').finish(true);
});
