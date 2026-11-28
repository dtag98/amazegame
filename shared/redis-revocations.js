import { SESSION_TTL_SECONDS } from './auth.js';

const registryKey = 'amazegame:revocations:v1';
const persistenceKey = 'amazegame:revocation-sync:v1';
const sessionIdPattern = /^[a-f0-9]{64}$/;
const persistenceCommand = ['WAITAOF', '1', '0', '2000'];
const commandDeadlineMs = 4000;
const maxPendingRevocations = 128;
const maxCachedAcknowledgments = 1024;
const acknowledgmentCacheTtlMs = 30_000;
const maxSnapshotEntries = 32_768;

async function withinDeadline(operation, deadlineMs = commandDeadlineMs, onTimeout) {
  let timer;
  const timeoutError = new Error('Session revocation store did not respond in time');
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), deadlineMs);
      }),
    ]);
  } catch (error) {
    if (error === timeoutError) onTimeout?.();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requirePersistence(reply) {
  if (!Array.isArray(reply) || reply[0] !== 1) {
    throw new Error('Session revocation was not confirmed on disk');
  }
}

export async function createRedisRevocationWriter(client, { monotonicNow = () => performance.now() } = {}) {
  requirePersistence(await withinDeadline(client.sendCommand(persistenceCommand)));
  const pending = [];
  const inFlight = new Map();
  const acknowledged = new Map();
  let writing = false;

  function rememberAcknowledgment({ value: sessionId, score: expiresAt }) {
    const cacheFor = Math.min(expiresAt - Date.now(), acknowledgmentCacheTtlMs);
    if (cacheFor <= 0) return;
    acknowledged.set(sessionId, monotonicNow() + cacheFor);
    if (acknowledged.size > maxCachedAcknowledgments) {
      acknowledged.delete(acknowledged.keys().next().value);
    }
  }

  async function writePending() {
    writing = true;
    while (pending.length) {
      const batch = pending.splice(0);
      try {
        // SET forces a write even if ZADD had only existing entries.
        // A pipeline keeps these commands on one connection and permits WAITAOF to block.
        const [written, syncMarker, persisted] = await withinDeadline(client.multi()
          .zAdd(registryKey, batch.map(job => job.entry))
          .set(persistenceKey, '1')
          .addCommand(persistenceCommand)
          .execAsPipeline());
        if (!Number.isSafeInteger(written) || written < 0 || syncMarker !== 'OK') {
          throw new Error('Session revocation could not be written');
        }
        requirePersistence(persisted);
        for (const job of batch) {
          rememberAcknowledgment(job.entry);
          job.resolve();
        }
      } catch (error) {
        for (const job of batch) job.reject(error);
      } finally {
        for (const job of batch) inFlight.delete(job.entry.value);
      }
    }
    writing = false;
  }

  return {
    async revoke({ sessionId, expiresAt }) {
      const now = Date.now();
      if (typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)
          || !Number.isSafeInteger(expiresAt) || expiresAt > now + SESSION_TTL_SECONDS * 1000) {
        throw new Error('Invalid session metadata');
      }
      if (expiresAt <= now) return;
      if (acknowledged.get(sessionId) > monotonicNow()) return;
      acknowledged.delete(sessionId);
      const existing = inFlight.get(sessionId);
      if (existing) return existing.promise;
      if (inFlight.size >= maxPendingRevocations) throw new Error('Session revocation store is busy');

      const job = { entry: { score: expiresAt, value: sessionId }, ...Promise.withResolvers() };
      inFlight.set(sessionId, job);
      pending.push(job);
      if (!writing) void writePending();
      return job.promise;
    },
    async prune(now = Date.now()) {
      await withinDeadline(client.zRemRangeByScore(registryKey, '-inf', now));
    },
  };
}

export async function createRedisRevocationReader(client, {
  refreshIntervalMs = 250,
  maxSnapshotAgeMs = 3000,
  readDeadlineMs = 2000,
  monotonicNow = () => performance.now(),
} = {}) {
  let revokedSessions = new Set();
  let snapshotRequestedAt = -Infinity;
  let refreshing = false;

  async function refresh(onTimeout) {
    const startedAt = monotonicNow();
    const sessionIds = await withinDeadline(client.zRangeByScore(registryKey, Date.now() + 1, '+inf', {
      LIMIT: { offset: 0, count: maxSnapshotEntries + 1 },
    }), readDeadlineMs, onTimeout);
    if (!Array.isArray(sessionIds) || sessionIds.length > maxSnapshotEntries
        || sessionIds.some(id => typeof id !== 'string' || !sessionIdPattern.test(id))) {
      throw new Error('Invalid session revocation snapshot');
    }
    // Count freshness from when the snapshot was requested, including time in transit.
    if (monotonicNow() - startedAt >= maxSnapshotAgeMs) throw new Error('Stale session revocation snapshot');
    revokedSessions = new Set(sessionIds);
    snapshotRequestedAt = startedAt;
  }

  function isFresh() {
    return monotonicNow() - snapshotRequestedAt < maxSnapshotAgeMs;
  }

  try {
    await refresh();
  } catch (error) {
    client.destroy?.();
    throw error;
  }
  return {
    isFresh,
    isRevoked({ sessionId }) {
      return !isFresh() || revokedSessions.has(sessionId);
    },
    watch(onChange) {
      let stopped = false;
      const timer = setInterval(() => {
        // Check freshness even while a Redis request is still pending.
        if (!isFresh()) onChange();
        if (stopped || refreshing) return;
        refreshing = true;
        refresh(() => { if (!stopped) client.reset(); }).then(
          () => { if (!stopped) onChange(); },
          () => { /* Keep the last successful snapshot until it becomes stale. */ },
        ).finally(() => { refreshing = false; });
      }, refreshIntervalMs);
      timer.unref();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
