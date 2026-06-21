'use strict';

const assert = require('node:assert/strict');
const {
  connectToHost,
  displayAccessCode,
  dissolveText,
  generateAccessCode,
  generateRoomId,
  historyRows,
  normalizeAccessCode,
  normalizeMessagePayload,
  normalizeRoomId,
  renderChat,
  renderChatStartupFrame,
  scrollChatState,
  shouldNotifyForIncomingMessage,
  startHost,
  jumpChatToLatest,
} = require('../messenger-mode');

function deferred(timeoutMessage) {
  let resolve;
  let reject;
  const promise = new Promise((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  const timer = setTimeout(() => reject(new Error(timeoutMessage)), 5000);
  return {
    promise: promise.finally(() => clearTimeout(timer)),
    resolve,
  };
}

async function main() {
  assert.equal(displayAccessCode('ab12cd34e'), 'AB1-2CD-34E');
  assert.equal(normalizeAccessCode(displayAccessCode('ab12cd34e')), 'AB12CD34E');
  assert.equal(normalizeRoomId(generateRoomId()).length, 10);
  assert.equal(dissolveText('hello', 16, 16), '     ');
  assert.equal(normalizeMessagePayload({ id: 'abc', text: 'hello', replyTo: { id: 'x', username: 'guest', text: 'hi' } }).replyTo.username, 'guest');
  assert.match(renderChatStartupFrame(0, 30), /PRIVATE MESSENGER/);
  assert.match(renderChatStartupFrame(30, 30), /SECURE MESSENGER READY/);
  assert.ok(historyRows([
    { kind: 'message', id: '1', username: 'GUEST', text: 'hello there', outgoing: false, time: '12:00' },
    { kind: 'message', id: '2', username: 'HOST', text: 'message received', outgoing: true, time: '12:01' },
  ], 60).rows.some(row => row.raw.includes('message received')));
  const scrollState = { offset: 8, followBottom: true, unread: 0 };
  const scrollLayout = { maximumOffset: 8, page: 4 };
  scrollChatState(scrollState, scrollLayout, -4);
  assert.deepEqual(scrollState, { offset: 4, followBottom: false, unread: 0 });
  scrollState.unread = 2;
  scrollChatState(scrollState, scrollLayout, 4);
  assert.deepEqual(scrollState, { offset: 8, followBottom: true, unread: 0 });
  assert.equal(shouldNotifyForIncomingMessage({ followBottom: true }), false);
  assert.equal(shouldNotifyForIncomingMessage({ followBottom: false }), true);
  scrollChatState(scrollState, { maximumOffset: 0, page: 4 }, -4);
  assert.equal(scrollState.followBottom, true);
  scrollState.unread = 3;
  jumpChatToLatest(scrollState, scrollLayout);
  assert.deepEqual(scrollState, { offset: 8, followBottom: true, unread: 0 });
  const originalWrite = process.stdout.write;
  let rendered = '';
  process.stdout.write = chunk => {
    rendered += chunk;
    return true;
  };
  try {
    renderChat({
      hostMode: true,
      roomLabel: 'Friends',
      accessCode: 'ABC123',
      history: [{ kind: 'message', id: '1', username: 'GUEST', text: 'hello', outgoing: false, time: '12:00' }],
      input: 'draft',
      connected: true,
      followBottom: true,
      offset: 0,
      unread: 0,
      replyTo: undefined,
      selectedMessageId: '1',
      remoteTyping: false,
      remoteTypingUsername: '',
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(rendered, /PRIVATE MESSENGER/);
  assert.match(rendered, /MESSAGE > .*draft/);

  rendered = '';
  process.stdout.write = chunk => {
    rendered += chunk;
    return true;
  };
  try {
    renderChat({
      hostMode: false,
      roomLabel: 'Friends',
      history: Array.from({ length: 20 }, (_, index) => ({
        kind: 'message', id: String(index), username: 'GUEST', text: `message ${index}`, outgoing: false, time: '12:00',
      })),
      input: '',
      connected: true,
      followBottom: false,
      offset: 0,
      unread: 2,
      replyTo: undefined,
      replySelectionActive: false,
      selectedMessageId: null,
      remoteTyping: false,
      remoteTypingUsername: '',
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(rendered, /\u2193 2 NEW/);

  const roomId = generateRoomId();
  const accessCode = generateAccessCode();
  const guestAuthenticated = deferred('Host did not authenticate the guest.');
  let hostReceived;
  let guestReceived;

  const host = await startHost({
    roomId,
    accessCode,
    roomLabel: 'Integration',
    username: 'HOST',
    onEvent: event => {
      if (event.type === 'connected') guestAuthenticated.resolve(event.username);
    },
    onMessage: message => hostReceived?.resolve(message),
  });

  const guest = await connectToHost({
    roomId,
    accessCode,
    username: 'GUEST',
    onMessage: message => guestReceived?.resolve(message),
  });

  assert.equal(await guestAuthenticated.promise, 'GUEST');
  hostReceived = deferred('Host did not receive the guest message.');
  guestReceived = deferred('Guest did not receive the host message.');
  assert.equal(guest.sendMessage({ id: 'guest-1', text: 'hello host' }), true);
  assert.deepEqual(await hostReceived.promise, { username: 'GUEST', id: 'guest-1', text: 'hello host', replyTo: undefined });
  assert.equal(host.sendMessage({ id: 'host-1', text: 'hello guest' }), true);
  assert.deepEqual(await guestReceived.promise, { username: 'HOST', id: 'host-1', text: 'hello guest', replyTo: undefined });

  guest.destroy();
  host.shutdown();
  console.log('Cloudflare relay integration passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
