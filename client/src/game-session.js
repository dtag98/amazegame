const MAX_CHAT_MESSAGES = 100;

export function appendChatMessage(list, { username, message }) {
  const item = list.ownerDocument.createElement('li');
  item.textContent = `${username}: ${message}`;
  list.append(item);
  if (list.childElementCount > MAX_CHAT_MESSAGES) list.firstElementChild.remove();
}

export function createGameSession({ joinRoom, onChat, onRoom, onRoomLeft = () => {} }) {
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
        joinedRoom.onMessage('chat', message => {
          if (room === joinedRoom) onChat(message);
        });
        joinedRoom.onLeave(code => {
          if (room !== joinedRoom) return;
          room = undefined;
          onRoomLeft(code);
        });
        onRoom(joinedRoom);
        return joinedRoom;
      })().catch(error => {
        if (version === sessionVersion) throw error;
      });
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
      const previousRoom = room;
      room = undefined;
      previousRoom?.leave();
    },
    get connected() { return Boolean(room); },
  };
}
