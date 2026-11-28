export async function connectRevocationRedis(createClient, url) {
  const options = {
    url,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 64,
    socket: {
      connectTimeout: 3_000,
      reconnectStrategy: retries => Math.min(1_000, 100 * (retries + 1)),
    },
  };
  let client;
  let closed = false;
  let reportedConnectionError = false;

  function reportConnectionError() {
    if (!reportedConnectionError) console.error('Session revocation store connection failed');
    reportedConnectionError = true;
  }

  async function open() {
    const nextClient = createClient(options);
    client = nextClient;
    nextClient.on('error', () => {
      if (!closed && client === nextClient) reportConnectionError();
    });
    nextClient.on('ready', () => {
      if (!closed && client === nextClient) reportedConnectionError = false;
    });
    await nextClient.connect();
  }

  function closeClient() {
    if (client?.isOpen) client.destroy();
  }

  try {
    await open();
  } catch (error) {
    closeClient();
    throw error;
  }

  return {
    get isOpen() { return client.isOpen; },
    destroy() {
      closed = true;
      closeClient();
    },
    reset() {
      if (closed) return;
      closeClient();
      // A separate client drops queued replies from the stalled socket.
      void open().catch(() => { if (!closed) reportConnectionError(); });
    },
    sendCommand(...args) { return client.sendCommand(...args); },
    multi() { return client.multi(); },
    zRemRangeByScore(...args) { return client.zRemRangeByScore(...args); },
    zRangeByScore(...args) { return client.zRangeByScore(...args); },
  };
}
