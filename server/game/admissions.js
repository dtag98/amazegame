export const GAME_LIMITS = Object.freeze({
  rooms: 4,
  playersPerRoom: 16,
  pending: 32,
  perAccount: 2,
  seatTimeoutSeconds: 15,
  messagesPerSecond: 30,
});

function seatKey({ processId, roomId, sessionId }) {
  return `${processId}/${roomId}/${sessionId}`;
}

export function createGameAdmissions({
  totalLimit = GAME_LIMITS.rooms * GAME_LIMITS.playersPerRoom,
  pendingLimit = GAME_LIMITS.pending,
  accountLimit = GAME_LIMITS.perAccount,
  seatTimeoutMs = GAME_LIMITS.seatTimeoutSeconds * 1000,
} = {}) {
  const byAccount = new Map();
  const bySeat = new Map();
  let pending = 0;
  let total = 0;

  function reserve(session) {
    const accountCount = byAccount.get(session.id) ?? 0;
    if (pending >= pendingLimit || total >= totalLimit || accountCount >= accountLimit) return null;

    pending++;
    total++;
    byAccount.set(session.id, accountCount + 1);
    const entry = { session, phase: 'pending', key: undefined, timer: undefined, release };

    function release() {
      if (entry.phase === 'released') return;
      if (entry.phase === 'pending') pending--;
      total--;
      const remaining = byAccount.get(session.id) - 1;
      if (remaining === 0) byAccount.delete(session.id);
      else byAccount.set(session.id, remaining);
      entry.phase = 'released';
      clearTimeout(entry.timer);
      if (entry.key !== undefined) bySeat.delete(entry.key);
    }

    return {
      bind(seat) {
        const key = seatKey(seat);
        if (entry.phase !== 'pending' || entry.key !== undefined || bySeat.has(key)) {
          throw new Error('Could not bind a game seat');
        }
        entry.key = key;
        bySeat.set(key, entry);
        // Keep the slot while Colyseus holds its seat, even if the JWT expires first.
        entry.timer = setTimeout(release, seatTimeoutMs).unref();
      },
      release,
    };
  }

  function claim(seat, session, socket) {
    const entry = bySeat.get(seatKey(seat));
    if (entry?.phase !== 'pending' || entry.session.sessionId !== session.sessionId
        || entry.session.id !== session.id) return false;

    entry.phase = 'connected';
    entry.session = session;
    pending--;
    clearTimeout(entry.timer);
    // Release only once the transport closes, including failures before onJoin.
    socket.once('close', entry.release);
    return true;
  }

  function connectedSession(seat) {
    const entry = bySeat.get(seatKey(seat));
    return entry?.phase === 'connected' ? entry.session : null;
  }

  return { reserve, claim, connectedSession };
}
