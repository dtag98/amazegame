export class PasswordWorkTimeoutError extends Error {
  constructor() {
    super('Password work expired while waiting.');
    this.name = 'PasswordWorkTimeoutError';
  }
}

export function createPasswordWorkQueue({ maxActive = 2, maxQueuedPerKind = 60, queueTimeoutMs = 30_000 } = {}) {
  const queued = { login: [], register: [] };
  let active = 0;
  let nextKind = 'login';

  function expire(job) {
    clearTimeout(job.timer);
    job.reject(new PasswordWorkTimeoutError());
  }

  function removeExpired(kind) {
    const lane = queued[kind];
    const now = performance.now();
    while (lane[0]?.deadline <= now) expire(lane.shift());
  }

  function start(job) {
    clearTimeout(job.timer);
    active++;
    Promise.resolve().then(() => {
      if (job.deadline !== undefined && job.deadline <= performance.now()) throw new PasswordWorkTimeoutError();
      return job.work();
    }).then(job.resolve, job.reject).finally(() => {
      active--;
      removeExpired('login');
      removeExpired('register');
      const otherKind = nextKind === 'login' ? 'register' : 'login';
      const next = queued[nextKind].shift() ?? queued[otherKind].shift();
      if (next) {
        nextKind = next.kind === 'login' ? 'register' : 'login';
        start(next);
      }
    });
  }

  return {
    run(kind, work) {
      if (!Object.hasOwn(queued, kind)) throw new TypeError('Unknown password work kind.');
      const lane = queued[kind];
      removeExpired(kind);
      if (active >= maxActive && lane.length >= maxQueuedPerKind) return null;

      return new Promise((resolve, reject) => {
        const job = { kind, work, resolve, reject };
        if (active < maxActive) {
          start(job);
          return;
        }

        job.deadline = performance.now() + queueTimeoutMs;
        job.timer = setTimeout(() => {
          const index = lane.indexOf(job);
          if (index !== -1) {
            lane.splice(index, 1);
            expire(job);
          }
        }, queueTimeoutMs);
        lane.push(job);
      });
    },
  };
}

const FAILURE_WINDOW_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 15_000;
const FAILURES_BEFORE_DELAY = 3;
const MAX_DELAY_MS = 30_000;

export function createLoginThrottle({ maxEntries = 16_384, now = () => performance.now() } = {}) {
  const attempts = new Map();
  let nextSweepAt = 0;

  function removeExpired(timestamp) {
    if (timestamp < nextSweepAt) return;
    for (const [username, attempt] of attempts) {
      if (!attempt.inFlight && attempt.expiresAt <= timestamp) attempts.delete(username);
    }
    nextSweepAt = timestamp + SWEEP_INTERVAL_MS;
  }

  return {
    begin(username) {
      const timestamp = now();
      removeExpired(timestamp);
      let attempt = attempts.get(username);
      if (attempt && !attempt.inFlight && attempt.expiresAt <= timestamp) {
        attempts.delete(username);
        attempt = undefined;
      }
      if (!attempt) {
        if (attempts.size >= maxEntries) return { status: 503, retryAfter: 15 };
        attempt = { failures: 0, nextAttemptAt: timestamp, expiresAt: timestamp, inFlight: false };
        attempts.set(username, attempt);
      }
      if (attempt.inFlight || attempt.nextAttemptAt > timestamp) {
        const retryAfter = Math.max(1, Math.ceil((attempt.nextAttemptAt - timestamp) / 1_000));
        return { status: 429, retryAfter };
      }
      attempt.inFlight = true;

      return {
        finish(verified) {
          attempt.inFlight = false;
          if (verified === true || (verified === undefined && attempt.failures === 0)) {
            attempts.delete(username);
          } else if (verified === false) {
            const completedAt = now();
            // Keep the growth exponent bounded once the maximum delay is reached.
            attempt.failures = Math.min(attempt.failures + 1, FAILURES_BEFORE_DELAY + 5);
            const delay = attempt.failures < FAILURES_BEFORE_DELAY
              ? 0 : Math.min(MAX_DELAY_MS, 1_000 * 2 ** (attempt.failures - FAILURES_BEFORE_DELAY));
            attempt.nextAttemptAt = completedAt + delay;
            attempt.expiresAt = completedAt + FAILURE_WINDOW_MS;
          }
        },
      };
    },
  };
}
