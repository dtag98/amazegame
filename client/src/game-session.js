export function createGameSession({ joinRoom, onChat, onRoom }) {
  let room;
  let starting;
  let sessionVersion = 0;

  return {
    async start(authenticated) {
      if (!authenticated || room) return room;
      if (starting) return starting;
      const version = sessionVersion;
      starting = (async () => {
        const joinedRoom = await joinRoom();
        if (version !== sessionVersion) {
          joinedRoom.leave();
          return undefined;
        }
        room = joinedRoom;
        joinedRoom.onMessage('chat', onChat);
        onRoom(joinedRoom);
        return joinedRoom;
      })();
      try { return await starting; }
      finally { if (version === sessionVersion) starting = undefined; }
    },
    sendChat(message) {
      if (room && message.length > 0 && message.length <= 200) room.send('chat', { message });
    },
    sendMove(dx, dz) { if (room) room.send('move', { dx, dz }); },
    disconnect() {
      sessionVersion++;
      starting = undefined;
      room?.leave();
      room = undefined;
    },
    get connected() { return Boolean(room); },
  };
}
