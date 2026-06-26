'use strict';

const assert = require('node:assert/strict');
const {
  cleanGuildIcon,
  cleanGuildName,
  cleanMessage,
  cleanUsername,
  normalizeGuildList,
  readKeyTokens,
  renderBoardOutput,
  renderDmOutput,
  renderGuildListOutput,
  statusLabel,
} = require('../guild-mode');

function baseState() {
  return {
    username: 'ERIK',
    frame: 0,
    guilds: [],
    selectedGuild: 0,
    selectedMember: 0,
    memberFocus: false,
    currentGuild: { id: 'abc123def4', name: 'Studio', icon: '#' },
    board: [],
    members: [],
    dms: new Map(),
    dmTarget: '',
    dmKey: '',
    input: '',
    inputCursor: 0,
    loading: '',
    notice: '',
    presence: 'online',
  };
}

assert.equal(cleanUsername('  Erik\n'), 'Erik');
assert.equal(cleanGuildName('  The Board\n'), 'The Board');
assert.equal(cleanGuildIcon('@@@'), '@@@');
assert.equal(cleanGuildIcon(''), '#');
assert.equal(cleanMessage('hello\u0000world'), 'helloworld');
assert.equal(statusLabel('brb'), 'brb');
assert.equal(statusLabel('missing'), 'offline');
assert.deepEqual(readKeyTokens('\x1b[A').tokens, ['up']);
assert.deepEqual(readKeyTokens('\x1b[1;5B').tokens, ['down']);
assert.deepEqual(readKeyTokens('\r').tokens, ['enter']);
assert.deepEqual(readKeyTokens('\x1b', true).tokens, ['escape']);
assert.deepEqual(readKeyTokens('\x1b['), { tokens: [], rest: '\x1b[' });
assert.deepEqual(readKeyTokens('Nhello').tokens, ['N', 'h', 'e', 'l', 'l', 'o']);

const guilds = normalizeGuildList({
  guilds: [
    { id: 'abc123def4', name: 'Studio', icon: '#', createdBy: 'ERIK', memberCount: 3, onlineCount: 2, createdAt: 1, lastActivityAt: 2 },
    { id: 'bad', name: 'Nope' },
  ],
});
assert.equal(guilds.length, 1);
assert.equal(guilds[0].name, 'Studio');

let state = baseState();
state.guilds = guilds;
let output = renderGuildListOutput(state);
assert.match(output, /PUBLIC GUILDS/);
assert.match(output, /Studio/);

state = baseState();
state.board = [{ id: 'm1', author: 'SELINA', text: 'hello guild', createdAt: Date.now() }];
state.members = [
  { username: 'ERIK', status: 'online', lastSeen: Date.now() },
  { username: 'SELINA', status: 'brb', lastSeen: Date.now() },
  { username: 'CATO', status: 'idle', lastSeen: Date.now() },
];
output = renderBoardOutput(state);
assert.match(output, /SERVER BOARD/);
assert.match(output, /USERS/);
assert.match(output, /POSTS/);
assert.match(output, /hello guild/);
assert.match(output, /brb/);
assert.match(output, /idle/);

state.dmTarget = 'SELINA';
state.dmKey = 'selina';
state.dms.set('selina', [{ id: 'd1', author: 'ERIK', to: 'SELINA', text: 'secret hello', createdAt: Date.now() }]);
output = renderDmOutput(state);
assert.match(output, /DM/);
assert.match(output, /secret hello/);

console.log('Guild mode unit tests passed.');
