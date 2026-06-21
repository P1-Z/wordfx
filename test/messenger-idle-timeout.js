'use strict';

const assert = require('node:assert/strict');
const {
  connectToHost,
  generateAccessCode,
  generateRoomId,
  startHost,
} = require('../messenger-mode');

function closedAfterIdle(label) {
  let resolve;
  const promise = new Promise(resolve_ => { resolve = resolve_; });
  const timer = setTimeout(() => {
    console.error(`${label} did not close after the idle timeout.`);
    process.exit(1);
  }, 140000);
  return {
    promise: promise.finally(() => clearTimeout(timer)),
    resolve,
  };
}

async function main() {
  await new Promise(resolve => setTimeout(resolve, 250));
  const roomId = generateRoomId();
  const accessCode = generateAccessCode();
  let hostClosed;
  let guestClosed;
  const host = await startHost({
    roomId,
    accessCode,
    roomLabel: 'Integration',
    username: 'HOST',
    onEvent: event => {
      if (event.type === 'error' || event.type === 'disconnected') hostClosed?.resolve(event);
    },
    onMessage: () => {},
  });
  await connectToHost({
    roomId,
    accessCode,
    username: 'GUEST',
    onEvent: event => {
      if (event.type === 'error' || event.type === 'disconnected') guestClosed?.resolve(event);
    },
    onMessage: () => {},
  });

  const startedAt = Date.now();
  hostClosed = closedAfterIdle('Host');
  guestClosed = closedAfterIdle('Guest');
  const [hostEvent, guestEvent] = await Promise.all([hostClosed.promise, guestClosed.promise]);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 110000, `Room closed too early after ${elapsed} ms.`);
  assert.ok(elapsed <= 135000, `Room closed too late after ${elapsed} ms.`);
  host.shutdown();
  console.log(`Idle room closed after ${elapsed} ms (${hostEvent.type}/${guestEvent.type}).`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
