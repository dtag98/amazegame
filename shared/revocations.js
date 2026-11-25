import { readdirSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const markerPattern = /^(\d{1,16})-([a-f0-9]{64})$/;
const rescanIntervalMs = 250;

export function createRevocations(directory) {
  if (!directory || !statSync(directory).isDirectory()) {
    throw new Error('SESSION_REVOCATIONS_DIR must point to the session revocation volume.');
  }

  function markerPath({ sessionId, expiresAt }) {
    const name = `${expiresAt}-${sessionId}`;
    if (!Number.isSafeInteger(expiresAt) || !markerPattern.test(name)) throw new Error('Invalid session metadata');
    return join(directory, name);
  }

  return {
    revoke(session) {
      if (session.expiresAt <= Date.now()) return;
      // Marker existence is the entire record. Persist it before acknowledging logout.
      writeFileSync(markerPath(session), '', { flag: 'a', mode: 0o600, flush: true });
    },
    isRevoked(session) {
      try {
        statSync(markerPath(session));
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') return true;
        try { return !statSync(directory).isDirectory(); }
        catch { return true; }
      }
    },
    prune(now = Date.now()) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const match = entry.isFile() && markerPattern.exec(entry.name);
        if (!match || Number(match[1]) > now) continue;
        try { unlinkSync(join(directory, entry.name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
    watch(onChange) {
      // The periodic sweep covers coalesced or unavailable filesystem events.
      const timer = setInterval(onChange, rescanIntervalMs);
      timer.unref();
      let watcher;
      try {
        watcher = watch(directory, { persistent: false }, onChange);
        watcher.on('error', () => watcher.close());
      } catch {
        // The periodic sweep is already running.
      }
      return () => {
        clearInterval(timer);
        watcher?.close();
      };
    },
  };
}
