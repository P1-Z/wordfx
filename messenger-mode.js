#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require('node:crypto');
const { registeredUsername } = require('./credentials');
const { playSound, playTypingSound, warmSoundSystem } = require('./sound');
const {
  ansi: paint,
  getSkin,
  renderThemeBar,
  themeSpinner,
} = require('./theme');

const PROTOCOL_VERSION = 3;
const MAX_FRAME_LENGTH = 16 * 1024;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_REPLY_PREVIEW_LENGTH = 120;
const AUTH_TIMEOUT_MS = 15000;
const MAX_HISTORY_ITEMS = 500;
const DISSOLVE_FRAME_COUNT = 24;
const DISSOLVE_FRAME_MS = 28;
const ROOM_ID_LENGTH = 10;
const ROOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ACCESS_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MIN_ACCESS_CODE_LENGTH = 4;
const MAX_ACCESS_CODE_LENGTH = 24;
const RELAY_CONFIG_PATH = path.join(__dirname, 'relay-config.json');
const SELECTION_BACKGROUND = '\x1b[48;2;36;46;88m';

function generateToken(length, alphabet) {
  const bytes = randomBytes(length);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function generateRoomId() {
  return generateToken(ROOM_ID_LENGTH, ROOM_ALPHABET);
}

function generateAccessCode() {
  const token = generateToken(9, ACCESS_CODE_ALPHABET);
  return `${token.slice(0, 3)}-${token.slice(3, 6)}-${token.slice(6, 9)}`;
}

function normalizeRoomId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_ID_LENGTH);
}

function normalizeAccessCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function displayAccessCode(value) {
  const normalized = normalizeAccessCode(value).slice(0, MAX_ACCESS_CODE_LENGTH);
  return normalized.match(/.{1,3}/g)?.join('-') || '';
}

function validAccessCode(value) {
  const normalized = normalizeAccessCode(value);
  return normalized.length >= MIN_ACCESS_CODE_LENGTH && normalized.length <= MAX_ACCESS_CODE_LENGTH;
}

function cleanUsername(value) {
  const username = String(value || 'USER').trim().replace(/[\r\n\x00-\x1f\x7f]/g, '');
  return (username || 'USER').slice(0, 24);
}

function cleanRoomLabel(value, fallback = '') {
  const label = String(value || fallback || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
  return (label || fallback || 'ROOM').slice(0, 32);
}

function createMessageId() {
  return randomBytes(8).toString('hex');
}

function previewText(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_REPLY_PREVIEW_LENGTH) return compact;
  return `${compact.slice(0, MAX_REPLY_PREVIEW_LENGTH - 1)}…`;
}

function sanitizeReplyReference(reply) {
  if (!reply || typeof reply !== 'object') return undefined;
  if (typeof reply.id !== 'string' || !reply.id) return undefined;
  const username = cleanUsername(reply.username);
  const text = previewText(reply.text);
  if (!text) return undefined;
  return {
    id: reply.id.slice(0, 64),
    username,
    text,
  };
}

function proof(accessCode, purpose, ...parts) {
  return createHmac('sha256', normalizeAccessCode(accessCode))
    .update([`wordfx-chat-v${PROTOCOL_VERSION}`, purpose, ...parts].join(':'))
    .digest('hex');
}

function proofsMatch(actual, expected) {
  try {
    const actualBuffer = Buffer.from(String(actual), 'hex');
    const expectedBuffer = Buffer.from(String(expected), 'hex');
    return actualBuffer.length === expectedBuffer.length
      && actualBuffer.length > 0
      && timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

function deriveSessionKey(accessCode, serverNonce, clientNonce, roomId) {
  return createHmac('sha256', normalizeAccessCode(accessCode))
    .update(`wordfx-chat-v${PROTOCOL_VERSION}:encryption:${roomId}:${serverNonce}:${clientNonce}`)
    .digest();
}

function encryptPayload(key, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(payload);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    type: 'message',
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptPayload(key, frame) {
  if (!key
    || typeof frame.iv !== 'string'
    || typeof frame.ciphertext !== 'string'
    || typeof frame.tag !== 'string') {
    throw new Error('Invalid encrypted message.');
  }
  const iv = Buffer.from(frame.iv, 'base64');
  const ciphertext = Buffer.from(frame.ciphertext, 'base64');
  const tag = Buffer.from(frame.tag, 'base64');
  if (iv.length !== 12 || !ciphertext.length || ciphertext.length > MAX_MESSAGE_LENGTH * 8 || tag.length !== 16) {
    throw new Error('Invalid encrypted message.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

function validMessageText(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_MESSAGE_LENGTH
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function normalizeMessagePayload(payload) {
  if (typeof payload === 'string') {
    if (!validMessageText(payload)) return null;
    return { id: createMessageId(), text: payload };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!validMessageText(payload.text)) return null;
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 64) return null;
  return {
    id: payload.id,
    text: payload.text,
    replyTo: sanitizeReplyReference(payload.replyTo),
  };
}

function createRateLimiter() {
  let messages = [];
  return () => {
    const now = Date.now();
    messages = messages.filter(time => now - time < 10000);
    messages.push(now);
    return messages.length <= 30;
  };
}

function relayBaseUrl() {
  let configured = process.env.WORDFX_CHAT_RELAY;
  if (!configured && fs.existsSync(RELAY_CONFIG_PATH)) {
    try {
      configured = JSON.parse(fs.readFileSync(RELAY_CONFIG_PATH, 'utf8')).url;
    } catch {
      throw new Error('relay-config.json is invalid. Rebuild the Cloudflare relay configuration.');
    }
  }
  if (!configured || /REPLACE_WITH/i.test(configured)) {
    throw new Error('Cloudflare chat relay is not deployed yet. Set WORDFX_CHAT_RELAY or update relay-config.json.');
  }

  const url = new URL(String(configured).trim());
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const localDevelopment = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && localDevelopment)) {
    throw new Error('The Cloudflare relay URL must use secure WebSockets (wss://).');
  }
  return url;
}

function relayHttpBaseUrl() {
  const url = relayBaseUrl();
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  return url;
}

function relayRoomUrl(roomId, role, metadata = {}) {
  const url = relayBaseUrl();
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/room/${normalizeRoomId(roomId)}`;
  const search = new URLSearchParams({ role });
  if (metadata.label) search.set('label', cleanRoomLabel(metadata.label));
  if (metadata.hostUsername) search.set('host', cleanUsername(metadata.hostUsername));
  url.search = search.toString();
  return url.toString();
}

function relayHttpUrl(pathname, searchParams) {
  const url = relayHttpBaseUrl();
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${pathname}`;
  url.search = searchParams ? new URLSearchParams(searchParams).toString() : '';
  return url;
}

async function relayJson(pathname, searchParams) {
  const response = await fetch(relayHttpUrl(pathname, searchParams));
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Relay request failed with ${response.status}.`);
  }
  return response.json();
}

async function listPublicRooms() {
  const payload = await relayJson('/rooms');
  if (!payload || !Array.isArray(payload.rooms)) throw new Error('The relay returned invalid room data.');
  return payload.rooms
    .filter(room => room && typeof room === 'object')
    .map(room => ({
      roomId: normalizeRoomId(room.roomId),
      label: cleanRoomLabel(room.label, 'ROOM'),
      hostUsername: cleanUsername(room.hostUsername),
      createdAt: Number.isFinite(room.createdAt) ? room.createdAt : Date.now(),
    }))
    .filter(room => room.roomId.length === ROOM_ID_LENGTH);
}

function ensureWebSocketSupport() {
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
    throw new Error('Cloudflare chat requires Node.js 22 or newer. Update Node.js and try again.');
  }
}

function parseRelayFrame(event) {
  if (typeof event.data !== 'string' || event.data.length > MAX_FRAME_LENGTH) {
    throw new Error('The relay sent an invalid or oversized frame.');
  }
  const frame = JSON.parse(event.data);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('The relay sent invalid chat data.');
  }
  return frame;
}

function sendFrame(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function startHost({ roomId, accessCode, roomLabel, username, onEvent = () => {}, onMessage = () => {} }) {
  ensureWebSocketSupport();
  const hostUsername = cleanUsername(username);
  const normalizedRoomId = normalizeRoomId(roomId);
  const normalizedAccessCode = normalizeAccessCode(accessCode);
  const label = cleanRoomLabel(roomLabel, `${hostUsername}'S ROOM`);
  let authenticated = false;
  let peerUsername = '';
  let serverNonce = '';
  let sessionKey;
  let closing = false;
  const withinRateLimit = createRateLimiter();
  const socket = new WebSocket(relayRoomUrl(normalizedRoomId, 'host', { label, hostUsername }));

  const transport = {
    sendMessage(payload) {
      return authenticated && sendFrame(socket, encryptPayload(sessionKey, payload));
    },
    sendTyping(active) {
      return authenticated && sendFrame(socket, { type: 'typing', active: Boolean(active) });
    },
    shutdown() {
      closing = true;
      socket.close(1000, 'Host left');
    },
    destroy() {
      this.shutdown();
    },
  };

  function resetPeer(notify = true) {
    if (notify && authenticated) onEvent({ type: 'disconnected', username: peerUsername });
    authenticated = false;
    peerUsername = '';
    serverNonce = '';
    sessionKey = undefined;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const connectionTimer = setTimeout(() => fail(new Error('Cloudflare relay connection timed out.')), AUTH_TIMEOUT_MS);

    function fail(error) {
      if (!settled) {
        settled = true;
        clearTimeout(connectionTimer);
        reject(error);
      } else if (!closing) {
        onEvent({ type: 'error', message: error.message });
      }
      closing = true;
      if (socket.readyState < WebSocket.CLOSING) socket.close(4000, 'Client error');
    }

    socket.addEventListener('open', () => {
      settled = true;
      clearTimeout(connectionTimer);
      resolve(transport);
    });

    socket.addEventListener('message', event => {
      try {
        const frame = parseRelayFrame(event);
        if (frame.type === 'relay-ready') return;
        if (frame.type === 'relay-peer-connected') {
          resetPeer(false);
          serverNonce = randomBytes(24).toString('hex');
          sendFrame(socket, { v: PROTOCOL_VERSION, type: 'challenge', nonce: serverNonce });
          return;
        }
        if (frame.type === 'relay-peer-disconnected') {
          resetPeer(true);
          return;
        }
        if (frame.type === 'relay-room-idle') {
          fail(new Error('Room closed after two minutes without typing.'));
          return;
        }

        if (!authenticated) {
          if (!serverNonce
            || frame.type !== 'auth'
            || frame.v !== PROTOCOL_VERSION
            || typeof frame.clientNonce !== 'string'
            || frame.clientNonce.length !== 48) {
            sendFrame(socket, { type: 'error', message: 'Authentication failed.' });
            return;
          }
          const candidateUsername = cleanUsername(frame.username);
          const expected = proof(normalizedAccessCode, 'client', normalizedRoomId, serverNonce, frame.clientNonce, candidateUsername);
          if (!proofsMatch(frame.proof, expected)) {
            sendFrame(socket, { type: 'error', message: 'Room code rejected.' });
            return;
          }
          authenticated = true;
          peerUsername = candidateUsername;
          sessionKey = deriveSessionKey(normalizedAccessCode, serverNonce, frame.clientNonce, normalizedRoomId);
          sendFrame(socket, {
            v: PROTOCOL_VERSION,
            type: 'auth-ok',
            username: hostUsername,
            proof: proof(normalizedAccessCode, 'server', normalizedRoomId, frame.clientNonce, serverNonce, hostUsername),
          });
          onEvent({ type: 'connected', username: peerUsername });
          return;
        }

        if (frame.type === 'typing') {
          onEvent({ type: 'typing', username: peerUsername, active: Boolean(frame.active) });
          return;
        }
        if (frame.type !== 'message' || !withinRateLimit()) {
          sendFrame(socket, { type: 'error', message: 'Invalid message or message rate exceeded.' });
          return;
        }
        const payload = normalizeMessagePayload(decryptPayload(sessionKey, frame));
        if (!payload) {
          sendFrame(socket, { type: 'error', message: 'Invalid message or message rate exceeded.' });
          return;
        }
        onMessage({ username: peerUsername, ...payload });
      } catch {
        fail(new Error('The relay sent invalid chat data.'));
      }
    });

    socket.addEventListener('error', () => fail(new Error('Could not connect to the Cloudflare relay.')));
    socket.addEventListener('close', () => {
      clearTimeout(connectionTimer);
      if (!settled) fail(new Error('The Cloudflare relay rejected the host connection.'));
      else if (!closing) {
        resetPeer(true);
        onEvent({ type: 'error', message: 'Cloudflare relay connection closed.' });
      }
    });
  });
}

function connectToHost({ roomId, accessCode, username, onEvent = () => {}, onMessage = () => {} }) {
  ensureWebSocketSupport();
  const clientUsername = cleanUsername(username);
  const normalizedRoomId = normalizeRoomId(roomId);
  const normalizedAccessCode = normalizeAccessCode(accessCode);
  const clientNonce = randomBytes(24).toString('hex');
  const withinRateLimit = createRateLimiter();
  let serverNonce = '';
  let authenticated = false;
  let hostUsername = '';
  let sessionKey;
  let closing = false;
  const socket = new WebSocket(relayRoomUrl(normalizedRoomId, 'guest'));

  const transport = {
    sendMessage(payload) {
      return authenticated && sendFrame(socket, encryptPayload(sessionKey, payload));
    },
    sendTyping(active) {
      return authenticated && sendFrame(socket, { type: 'typing', active: Boolean(active) });
    },
    destroy() {
      closing = true;
      socket.close(1000, 'Guest left');
    },
    shutdown() {
      this.destroy();
    },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const authenticationTimer = setTimeout(() => fail(new Error('Room connection timed out. Check the code and ask the host to stay online.')), AUTH_TIMEOUT_MS);

    function fail(error) {
      if (!settled) {
        settled = true;
        clearTimeout(authenticationTimer);
        reject(error);
      } else if (!closing) {
        onEvent({ type: 'error', message: error.message });
      }
      closing = true;
      if (socket.readyState < WebSocket.CLOSING) socket.close(4001, 'Authentication failed');
    }

    socket.addEventListener('message', event => {
      try {
        const frame = parseRelayFrame(event);
        if (frame.type === 'relay-ready' || frame.type === 'relay-peer-connected') return;
        if (frame.type === 'relay-peer-disconnected') {
          if (authenticated) onEvent({ type: 'disconnected', username: hostUsername });
          if (!closing) fail(new Error('The host left the room.'));
          return;
        }
        if (frame.type === 'relay-room-idle') {
          fail(new Error('Room closed after two minutes without typing.'));
          return;
        }
        if (frame.type === 'error') {
          fail(new Error(typeof frame.message === 'string' ? frame.message : 'Connection rejected.'));
          return;
        }

        if (!serverNonce) {
          if (frame.type !== 'challenge'
            || frame.v !== PROTOCOL_VERSION
            || typeof frame.nonce !== 'string'
            || frame.nonce.length !== 48) {
            fail(new Error('The host did not speak the expected chat protocol.'));
            return;
          }
          serverNonce = frame.nonce;
          sendFrame(socket, {
            v: PROTOCOL_VERSION,
            type: 'auth',
            username: clientUsername,
            clientNonce,
            proof: proof(normalizedAccessCode, 'client', normalizedRoomId, serverNonce, clientNonce, clientUsername),
          });
          return;
        }

        if (!authenticated) {
          const candidateUsername = cleanUsername(frame.username);
          const expected = proof(normalizedAccessCode, 'server', normalizedRoomId, clientNonce, serverNonce, candidateUsername);
          if (frame.type !== 'auth-ok' || frame.v !== PROTOCOL_VERSION || !proofsMatch(frame.proof, expected)) {
            fail(new Error('Host authentication failed. Check the room code.'));
            return;
          }
          authenticated = true;
          hostUsername = candidateUsername;
          sessionKey = deriveSessionKey(normalizedAccessCode, serverNonce, clientNonce, normalizedRoomId);
          settled = true;
          clearTimeout(authenticationTimer);
          resolve(transport);
          return;
        }

        if (frame.type === 'typing') {
          onEvent({ type: 'typing', username: hostUsername, active: Boolean(frame.active) });
          return;
        }
        if (frame.type !== 'message' || !withinRateLimit()) {
          fail(new Error('The host sent an invalid message or exceeded the message rate.'));
          return;
        }
        const payload = normalizeMessagePayload(decryptPayload(sessionKey, frame));
        if (!payload) {
          fail(new Error('The host sent an invalid message or exceeded the message rate.'));
          return;
        }
        onMessage({ username: hostUsername, ...payload });
      } catch {
        fail(new Error('The relay sent invalid chat data.'));
      }
    });

    socket.addEventListener('error', () => fail(new Error('Could not connect to the Cloudflare relay.')));
    socket.addEventListener('close', () => {
      clearTimeout(authenticationTimer);
      if (!settled) fail(new Error('The Cloudflare relay rejected the room connection.'));
      else if (authenticated && !closing) onEvent({ type: 'disconnected', username: hostUsername });
    });
  });
}

function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const onTyping = data => playTypingSound(data);
  process.stdin.on('data', onTyping);
  return new Promise(resolve => prompt.question(question, answer => {
    process.stdin.off('data', onTyping);
    prompt.close();
    resolve(answer.trim());
  }));
}

function timeLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function wrapMessage(text, width) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word_ of words) {
      let word = word_;
      while (word.length > width) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + word.length + 1 <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

const at = (row, column, text) => `\x1b[${row};${column}H${text}`;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stripAnsi = value => String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function terminalSize() {
  return {
    width: Math.max(42, process.stdout.columns || 80),
    height: Math.max(14, process.stdout.rows || 24),
  };
}

function centeredAt(row, content, width) {
  const column = Math.max(1, Math.floor((width - stripAnsi(content).length) / 2) + 1);
  return at(row, column, content);
}

function renderChatStartupFrame(frame, frameCount = 30) {
  const { width, height } = terminalSize();
  const progress = Math.max(0, Math.min(1, frame / frameCount));
  const eased = 1 - Math.pow(1 - progress, 3);
  const middle = Math.max(5, Math.floor(height / 2));
  const barWidth = Math.max(8, Math.min(42, width - 12));
  const stages = ['LOADING IDENTITY', 'LOCATING RELAY', 'PREPARING ENCRYPTION'];
  const stageProgress = progress * stages.length;
  let output = '\x1b[?25l\x1b[H';

  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');

  if (getSkin() === 'macintosh') {
    output += centeredAt(middle - 4, `${paint.bold}${paint.white}PRIVATE MESSENGER${paint.reset}`, width);
  } else {
    output += centeredAt(middle - 4, `${paint.purple}${paint.bold}:// PRIVATE MESSENGER${paint.reset}`, width);
  }
  output += centeredAt(middle - 2, `${paint.dim}END-TO-END ENCRYPTED CHANNEL${paint.reset}`, width);
  output += centeredAt(middle, renderThemeBar(eased, barWidth, frame), width);

  stages.forEach((stage, index) => {
    const complete = progress === 1 || index < Math.floor(stageProgress);
    const active = !complete && index === Math.floor(stageProgress);
    const marker = complete ? '[OK]' : active ? `[${themeSpinner(frame)}]` : '[ ]';
    const color = complete ? paint.green : active ? paint.cyan : paint.dim;
    const textColor = complete || active ? paint.white : paint.muted;
    output += centeredAt(
      middle + 2 + index,
      `${color}${marker}${paint.reset} ${textColor}${stage}${paint.reset}`,
      width
    );
  });

  if (progress === 1) {
    output += centeredAt(middle + 6, `${paint.green}${paint.bold}SECURE MESSENGER READY${paint.reset}`, width);
  } else {
    output += centeredAt(middle + 6, `${paint.dim}${String(Math.round(progress * 100)).padStart(3)}%${paint.reset}`, width);
  }
  return output;
}

async function playChatStartupAnimation() {
  const frames = 30;
  await warmSoundSystem();
  if (process.env.WORDFX_SKIP_STARTUP_SOUND !== '1') playSound('opening or loading');
  process.stdout.write('\x1b[r\x1b[3J\x1b[2J\x1b[H\x1b[?25l');
  for (let frame = 0; frame <= frames; frame++) {
    process.stdout.write(renderChatStartupFrame(frame, frames));
    await wait(28);
  }
  await wait(120);
  process.stdout.write('\x1b[3J\x1b[2J\x1b[H\x1b[?25h');
}

function dissolveText(text, frame, frameCount) {
  const glyphs = '01#@$%&*+<>\u2593\u2592\u2591';
  const progress = frame / frameCount;
  return Array.from(text, (character, index) => {
    const threshold = ((index * 37) % 101) / 100;
    if (threshold < progress) return ' ';
    if (threshold < progress + 0.24) return glyphs[(frame + index) % glyphs.length];
    return character;
  }).join('');
}

function historyRows(history, contentWidth, selectedMessageId = null) {
  const rows = [];
  const messageRows = [];
  const bubbleWidth = Math.max(18, Math.min(68, Math.floor(contentWidth * 0.78)));
  const messageWidth = Math.max(10, bubbleWidth - 4);

  for (const entry of history) {
    if (entry.kind === 'event') {
      rows.push({
        raw: `-- ${entry.text} --`,
        align: 'center',
        color: entry.color || paint.dim,
        dim: !entry.color,
      });
      rows.push({ raw: '' });
      continue;
    }

    const outgoing = Boolean(entry.outgoing);
    const selected = selectedMessageId && entry.id === selectedMessageId;
    const start = rows.length;
    const label = outgoing
      ? `${entry.time}  YOU  ◆`
      : `◆  ${cleanUsername(entry.username).toUpperCase()}  ${entry.time}`;
    rows.push({
      raw: label,
      align: outgoing ? 'right' : 'left',
      color: outgoing ? paint.green : paint.cyan,
      bold: true,
      selected,
    });
    if (entry.replyTo) {
      rows.push({
        raw: outgoing
          ? `↳ ${entry.replyTo.username}: ${previewText(entry.replyTo.text)}  │`
          : `│  ↳ ${entry.replyTo.username}: ${previewText(entry.replyTo.text)}`,
        align: outgoing ? 'right' : 'left',
        color: paint.dim,
        selected,
      });
    }
    for (const line of wrapMessage(entry.text, messageWidth)) {
      rows.push({
        raw: outgoing ? `${line}  │` : `│  ${line}`,
        align: outgoing ? 'right' : 'left',
        color: paint.white,
        selected,
      });
    }
    rows.push({ raw: '', selected });
    messageRows.push({ id: entry.id, start, end: rows.length - 1 });
  }
  return { rows, messageRows };
}

function clipped(value, width) {
  const text = String(value);
  if (text.length <= width) return text;
  return width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width);
}

function scrollChatState(state, layout, delta) {
  const maximumOffset = Math.max(0, layout?.maximumOffset || 0);
  state.offset = Math.max(0, Math.min(maximumOffset, state.offset + delta));
  state.followBottom = state.offset >= maximumOffset;
  if (state.followBottom) state.unread = 0;
}

function jumpChatToLatest(state, layout) {
  state.offset = Math.max(0, layout?.maximumOffset || 0);
  state.followBottom = true;
  state.unread = 0;
}

function shouldNotifyForIncomingMessage(state) {
  return state?.followBottom === false;
}

function renderChat(state) {
  const { width, height } = terminalSize();
  const boxWidth = Math.min(118, width - 2);
  const inside = boxWidth - 2;
  const contentWidth = inside - 4;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const visibleRows = Math.max(2, height - 9);
  const activeSelectionId = state.replySelectionActive ? state.selectedMessageId : null;
  const layout = historyRows(state.history, contentWidth, activeSelectionId);
  const rows = layout.rows;
  const maximumOffset = Math.max(0, rows.length - visibleRows);
  if (state.followBottom) state.offset = maximumOffset;
  else state.offset = Math.max(0, Math.min(state.offset, maximumOffset));

  const selectedBounds = layout.messageRows.find(item => item.id === activeSelectionId);
  if (selectedBounds) {
    if (selectedBounds.start < state.offset) state.offset = selectedBounds.start;
    if (selectedBounds.end >= state.offset + visibleRows) {
      state.offset = Math.min(maximumOffset, selectedBounds.end - visibleRows + 1);
    }
  }

  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  output += at(1, left, `${paint.purple}╭${'─'.repeat(inside)}╮${paint.reset}`);

  const mode = state.hostMode ? 'HOST' : 'GUEST';
  const titleRoom = state.roomLabel ? `  //  ${state.roomLabel.toUpperCase()}` : '';
  const title = clipped(`:// PRIVATE MESSENGER  //  ${mode}${titleRoom}`, contentWidth);
  output += at(2, left, `${paint.purple}│${paint.reset}  ${paint.bold}${paint.white}${title}${paint.reset}${' '.repeat(contentWidth - title.length)}  ${paint.purple}│${paint.reset}`);

  const connection = state.connected ? `${paint.green}● LIVE${paint.reset}` : `${paint.yellow}○ WAITING${paint.reset}`;
  const room = state.hostMode && state.accessCode ? `  //  CODE ${displayAccessCode(state.accessCode)}` : '';
  const statusRaw = clipped(`E2E ENCRYPTED  //  BUILT-IN ROOM DIRECTORY${room}`, Math.max(0, contentWidth - 10));
  const statusPadding = Math.max(0, contentWidth - 8 - statusRaw.length);
  output += at(3, left, `${paint.purple}│${paint.reset}  ${connection}  ${paint.dim}${statusRaw}${paint.reset}${' '.repeat(statusPadding)}  ${paint.purple}│${paint.reset}`);
  output += at(4, left, `${paint.purple}├${'─'.repeat(inside)}┤${paint.reset}`);

  for (let row = 0; row < visibleRows; row++) {
    const item = rows[state.offset + row];
    let rendered = '';
    if (item) {
      const raw = clipped(item.raw, contentWidth);
      let before = 0;
      if (item.align === 'right') before = contentWidth - raw.length;
      else if (item.align === 'center') before = Math.max(0, Math.floor((contentWidth - raw.length) / 2));
      const after = Math.max(0, contentWidth - before - raw.length);
      const emphasis = item.bold ? paint.bold : item.dim ? paint.dim : '';
      const selected = item.selected ? SELECTION_BACKGROUND : '';
      rendered = `${selected}${' '.repeat(before)}${emphasis}${item.color || ''}${raw}${paint.reset}${selected}${' '.repeat(after)}${paint.reset}`;
    } else {
      rendered = ' '.repeat(contentWidth);
    }
    output += at(5 + row, left, `${paint.purple}│${paint.reset}  ${rendered}  ${paint.purple}│${paint.reset}`);
  }

  const dividerRow = 5 + visibleRows;
  output += at(dividerRow, left, `${paint.purple}├${'─'.repeat(inside)}┤${paint.reset}`);
  const inputPrefix = 'MESSAGE > ';
  const availableInput = Math.max(1, contentWidth - inputPrefix.length);
  const visibleInput = clipped(state.input.slice(-availableInput), availableInput);
  const inputColor = paint.cyan;
  output += at(dividerRow + 1, left, `${paint.purple}│${paint.reset}  ${inputColor}${paint.bold}${inputPrefix}${paint.reset}${paint.white}${visibleInput}${paint.reset}${' '.repeat(availableInput - visibleInput.length)}  ${paint.purple}│${paint.reset}`);

  const statusLine = state.replySelectionActive
    ? 'SELECT A MESSAGE TO REPLY TO  *  ENTER CONFIRM  *  CTRL+R CANCEL  *  ESC CLOSE'
    : state.replyTo
      ? `REPLYING TO ${state.replyTo.username.toUpperCase()}: ${previewText(state.replyTo.text)}`
      : state.remoteTyping
        ? `${cleanUsername(state.remoteTypingUsername || 'PEER').toUpperCase()} IS TYPING...`
        : state.unread
          ? `\u2193 ${state.unread} NEW MESSAGE${state.unread === 1 ? '' : 'S'}  *  PGDN/END TO LATEST`
          : 'ARROWS/WHEEL/PGUP/PGDN SCROLL  *  ROOM CLOSES AFTER 2 MINUTES IDLE';
  const visibleStatusLine = clipped(statusLine, contentWidth);
  output += at(dividerRow + 2, left, `${paint.purple}│${paint.reset}  ${paint.dim}${visibleStatusLine}${paint.reset}${' '.repeat(contentWidth - visibleStatusLine.length)}  ${paint.purple}│${paint.reset}`);

  const position = rows.length ? `${Math.min(rows.length, state.offset + visibleRows)} / ${rows.length}` : 'EMPTY';
  const unread = state.unread ? `\u2193 ${state.unread} NEW` : '';
  const footerBase = state.replySelectionActive
    ? `UP/DOWN SELECT  *  ENTER CONFIRM  *  CTRL+R CANCEL  *  ESC CLOSE  *  ${position}`
    : `CTRL+R REPLY  *  ENTER SEND  *  ESC CLOSE  *  ${position}`;
  const footerLeftWidth = Math.max(0, contentWidth - (unread ? unread.length + 2 : 0));
  const footer = unread
    ? `${clipped(footerBase, footerLeftWidth).padEnd(footerLeftWidth)}  ${unread}`
    : clipped(footerBase, contentWidth);
  output += at(dividerRow + 3, left, `${paint.purple}│${paint.reset}  ${paint.dim}${footer}${' '.repeat(contentWidth - footer.length)}${paint.reset}  ${paint.purple}│${paint.reset}`);
  output += at(dividerRow + 4, left, `${paint.purple}╰${'─'.repeat(inside)}╯${paint.reset}`);

  const caretColumn = left + 3 + inputPrefix.length + visibleInput.length;
  output += at(dividerRow + 1, caretColumn, '\x1b[5 q\x1b[?25h');
  process.stdout.write(output);
  return { maximumOffset, page: visibleRows };
}

async function runChatInterface({ transport, username, hostMode, roomLabel, accessCode }) {
  const state = {
    hostMode,
    roomLabel,
    accessCode,
    history: [],
    input: '',
    connected: !hostMode,
    followBottom: true,
    offset: 0,
    unread: 0,
    replyTo: undefined,
    replySelectionActive: false,
    selectedMessageId: null,
    sending: false,
    remoteTyping: false,
    remoteTypingUsername: '',
    typingActive: false,
    typingTimer: null,
  };
  let layout;
  let closed = false;
  let finish;

  function refresh() {
    if (!closed) layout = renderChat(state);
  }

  function syncTyping(active) {
    if (state.typingActive === active) return;
    state.typingActive = active;
    transport.sendTyping?.(active);
  }

  function scheduleTypingReset() {
    if (state.typingTimer) clearTimeout(state.typingTimer);
    if (!state.input.trim()) {
      syncTyping(false);
      state.typingTimer = null;
      return;
    }
    syncTyping(true);
    state.typingTimer = setTimeout(() => {
      state.typingTimer = null;
      if (!closed && state.input.trim()) syncTyping(false);
    }, 1800);
  }

  function messageEntries() {
    return state.history.filter(entry => entry.kind === 'message');
  }

  function refreshSelection() {
    if (!state.replySelectionActive) {
      state.selectedMessageId = null;
      return;
    }
    const entries = messageEntries();
    if (!entries.length) {
      state.selectedMessageId = null;
      return;
    }
    if (state.selectedMessageId && entries.some(entry => entry.id === state.selectedMessageId)) return;
    state.selectedMessageId = entries[entries.length - 1].id;
  }

  function moveSelection(delta) {
    if (!state.replySelectionActive) return;
    const entries = messageEntries();
    if (!entries.length) return;
    let index = entries.findIndex(entry => entry.id === state.selectedMessageId);
    if (index === -1) index = delta < 0 ? entries.length : -1;
    index = Math.max(0, Math.min(entries.length - 1, index + delta));
    state.selectedMessageId = entries[index].id;
    playSound('navigate');
    state.followBottom = index === entries.length - 1;
    if (state.followBottom) state.unread = 0;
  }

  function appendHistory(entry, countAsUnread = false) {
    state.history.push(entry);
    if (state.history.length > MAX_HISTORY_ITEMS) {
      state.history.splice(0, state.history.length - MAX_HISTORY_ITEMS);
    }
    refreshSelection();
    if (!state.followBottom && countAsUnread) state.unread++;
    refresh();
  }

  function selectedMessage() {
    return state.history.find(entry => entry.kind === 'message' && entry.id === state.selectedMessageId) || null;
  }

  function event(event_) {
    if (event_.type === 'connected') {
      playSound('room_join');
      state.connected = true;
      state.remoteTyping = false;
      appendHistory({ kind: 'event', text: `${event_.username} JOINED  //  SECURE CHANNEL OPEN`, color: paint.green });
    } else if (event_.type === 'disconnected') {
      playSound('room_leave');
      state.connected = false;
      state.remoteTyping = false;
      appendHistory({ kind: 'event', text: `${event_.username || 'PEER'} LEFT  //  CHANNEL CLOSED`, color: paint.yellow });
      if (!hostMode) setTimeout(() => finish?.(), 900);
    } else if (event_.type === 'typing') {
      state.remoteTyping = Boolean(event_.active);
      state.remoteTypingUsername = cleanUsername(event_.username);
      refresh();
    } else if (event_.type === 'error') {
      playSound('error');
      appendHistory({ kind: 'event', text: `NETWORK  //  ${event_.message}`, color: paint.red });
    }
  }

  transport.onUiEvent = event;
  transport.onUiMessage = message => {
    playSound(shouldNotifyForIncomingMessage(state) ? 'notification' : 'chat_receive');
    state.remoteTyping = false;
    appendHistory({
      kind: 'message',
      id: message.id || createMessageId(),
      username: message.username,
      text: message.text,
      replyTo: sanitizeReplyReference(message.replyTo),
      outgoing: false,
      time: timeLabel(),
    }, true);
  };

  if (hostMode) {
    state.history.push({ kind: 'event', text: `${cleanRoomLabel(roomLabel)}  //  WAITING FOR ONE GUEST`, color: paint.yellow });
    state.history.push({ kind: 'event', text: `JOIN CODE ${displayAccessCode(accessCode)}  //  SHARE INSIDE WORDFX`, color: paint.cyan });
  } else {
    state.history.push({ kind: 'event', text: 'END-TO-END ENCRYPTED CONNECTION ESTABLISHED', color: paint.green });
  }

  async function sendCurrentMessage() {
    const text = state.input.trim();
    if (!text || closed || state.sending) return;
    if (text === '/quit' || text === '/exit') return finish();
    if (text === '/help') {
      state.input = '';
      state.replyTo = undefined;
      scheduleTypingReset();
      appendHistory({ kind: 'event', text: `CTRL+R REPLIES  //  UP/DOWN SELECT MESSAGES  //  ${MAX_MESSAGE_LENGTH} CHARACTERS MAX` });
      return;
    }

    const payload = {
      id: createMessageId(),
      text,
      replyTo: sanitizeReplyReference(state.replyTo),
    };
    if (!transport.sendMessage(payload)) {
      playSound('error');
      appendHistory({
        kind: 'event',
        text: hostMode ? 'NO GUEST IS CONNECTED YET' : 'CONNECTION IS UNAVAILABLE',
        color: paint.yellow,
      });
      return;
    }

    state.sending = true;
    playSound('chat_send');
    syncTyping(false);
    if (state.typingTimer) {
      clearTimeout(state.typingTimer);
      state.typingTimer = null;
    }
    state.followBottom = true;
    state.unread = 0;
    for (let frame = 0; frame <= DISSOLVE_FRAME_COUNT && !closed; frame++) {
      state.input = dissolveText(text, frame, DISSOLVE_FRAME_COUNT);
      refresh();
      await wait(DISSOLVE_FRAME_MS);
    }
    if (closed) return;
    state.input = '';
    state.sending = false;
    state.replyTo = undefined;
    appendHistory({
      kind: 'message',
      id: payload.id,
      username,
      text,
      replyTo: payload.replyTo,
      outgoing: true,
      time: timeLabel(),
    });
  }

  return new Promise(resolve => {
    const onResize = () => refresh();
    const onData = data => {
      const key = data.toString('utf8');
      playTypingSound(key);
      if (key === '\x03') return finish();
      const mouseReports = [...key.matchAll(/\x1b\[<(\d+);\d+;\d+[mM]/g)];
      if (mouseReports.length && !key.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, '')) {
        for (const report of mouseReports) {
          if (report[1] === '64') scrollChatState(state, layout, -3);
          else if (report[1] === '65') scrollChatState(state, layout, 3);
        }
        refresh();
        return;
      }
      if (key === '\x1b') {
        return finish();
      }
      if (state.sending) return;
      if (key === '\x12') {
        if (state.replySelectionActive) {
          state.replySelectionActive = false;
          state.selectedMessageId = null;
          playSound('toggle_off');
        } else {
          const entries = messageEntries();
          if (entries.length) {
            state.replySelectionActive = true;
            state.selectedMessageId = entries[entries.length - 1].id;
            state.followBottom = true;
            playSound('toggle_on');
          }
        }
      } else if (key === '\x1b[A') {
        if (state.replySelectionActive) moveSelection(-1);
        else scrollChatState(state, layout, -1);
      } else if (key === '\x1b[B') {
        if (state.replySelectionActive) moveSelection(1);
        else scrollChatState(state, layout, 1);
      } else if (key === '\x1b[5~') {
        scrollChatState(state, layout, -layout.page);
      } else if (key === '\x1b[6~') {
        scrollChatState(state, layout, layout.page);
      } else if (key === '\x1b[H' || key === '\x1b[1~') {
        const entries = messageEntries();
        if (state.replySelectionActive && entries.length) {
          state.selectedMessageId = entries[0].id;
          state.followBottom = false;
        } else scrollChatState(state, layout, -layout.maximumOffset);
      } else if (key === '\x1b[F' || key === '\x1b[4~') {
        const entries = messageEntries();
        if (state.replySelectionActive && entries.length) {
          state.selectedMessageId = entries[entries.length - 1].id;
          jumpChatToLatest(state, layout);
        } else jumpChatToLatest(state, layout);
      } else if (key === '\x7f' || key === '\b') {
        if (state.input.length) state.input = state.input.slice(0, -1);
        else state.replyTo = undefined;
        scheduleTypingReset();
      } else if (key === '\r' || key === '\n') {
        if (state.replySelectionActive) {
          const target = selectedMessage();
          if (target) {
            state.replyTo = {
              id: target.id,
              username: cleanUsername(target.outgoing ? 'You' : target.username),
              text: previewText(target.text),
            };
          }
          state.replySelectionActive = false;
          state.selectedMessageId = null;
          playSound('confirm');
          refresh();
          return;
        }
        void sendCurrentMessage();
        return;
      } else {
        if (state.replySelectionActive) return;
        const printable = key.replace(/[\x00-\x1f\x7f]/g, '').replace(/\r?\n/g, ' ');
        if (printable) {
          jumpChatToLatest(state, layout);
          state.input = (state.input + printable).slice(0, MAX_MESSAGE_LENGTH);
          scheduleTypingReset();
        }
      }
      refresh();
    };

    finish = () => {
      if (closed) return;
      closed = true;
      playSound('closing or quitting');
      if (state.typingTimer) clearTimeout(state.typingTimer);
      syncTyping(false);
      process.stdin.off('data', onData);
      process.stdout.off('resize', onResize);
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (hostMode) transport.shutdown();
      else transport.destroy();
      process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0 q\x1b[0m\x1b[3J\x1b[2J\x1b[H');
      resolve();
    };

    process.stdout.write('\x1b[r\x1b[?1000h\x1b[?1006h\x1b[3J\x1b[2J\x1b[H');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    process.stdout.on('resize', onResize);
    refreshSelection();
    refresh();
  });
}

function formatRoomAge(createdAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function askJoinRoomSelection(initialRooms = []) {
  return new Promise(resolve => {
    let rooms = initialRooms;
    let selectedIndex = 0;
    let loading = false;
    let closed = false;
    let errorMessage = '';
    const prompt = `${paint.dim}Use arrows to choose a room. Enter joins. R refreshes. Esc or Q returns.${paint.reset}`;

    async function refreshRooms() {
      if (closed || loading) return;
      loading = true;
      render();
      try {
        const refreshedRooms = await listPublicRooms();
        if (closed) return;
        rooms = refreshedRooms;
        selectedIndex = Math.min(selectedIndex, Math.max(0, rooms.length - 1));
        errorMessage = '';
      } catch (error) {
        if (closed) return;
        errorMessage = error.message;
      } finally {
        if (closed) return;
        loading = false;
        render();
      }
    }

    function render() {
      if (closed) return;
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(`${paint.cyan}${paint.bold}JOIN A ROOM${paint.reset}`);
      console.log(prompt);
      if (loading) {
        console.log(`\n${paint.dim}Loading rooms...${paint.reset}`);
        return;
      }
      if (errorMessage) console.log(`\n${paint.red}${errorMessage}${paint.reset}`);
      if (!rooms.length) {
        console.log(`\n${paint.yellow}No public rooms are waiting right now.${paint.reset}`);
        console.log(`${paint.dim}Press R to refresh or Esc/Q to return.${paint.reset}`);
        return;
      }
      console.log('');
      rooms.forEach((room, index) => {
        const pointer = index === selectedIndex ? `${paint.green}▶${paint.reset}` : ' ';
        const line = `${pointer} ${paint.bold}${room.label}${paint.reset}  ${paint.dim}// host ${room.hostUsername}  //  open ${formatRoomAge(room.createdAt)}${paint.reset}`;
        console.log(line);
      });
    }

    function finish(result) {
      if (closed) return;
      closed = true;
      playSound('closing or quitting');
      process.stdin.off('data', onData);
      if (process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve(result);
    }

    async function onData(data) {
      const key = data.toString('utf8');
      if (key === '\x03') {
        return finish(null);
      }
      if (key === '\x1b' || key === 'q' || key === 'Q') return finish(null);
      if (loading) return;
      if ((key === 'r' || key === 'R')) return refreshRooms();
      if (!rooms.length && (key === '\r' || key === '\n')) return refreshRooms();
      if (key === '\x1b[A' && rooms.length) {
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
      } else if (key === '\x1b[B' && rooms.length) {
        selectedIndex = Math.min(rooms.length - 1, selectedIndex + 1);
        render();
      } else if ((key === '\r' || key === '\n') && rooms.length) {
        finish(rooms[selectedIndex]);
      }
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    render();
    if (!rooms.length) refreshRooms();
  });
}

async function askHostSetup(username) {
  console.log(`\n${paint.cyan}${paint.bold}HOST A ROOM${paint.reset}`);
  const suggestedLabel = `${cleanUsername(username)}'s room`;
  const label = cleanRoomLabel(
    await ask(`${paint.cyan}Room name${paint.reset} ${paint.dim}[${suggestedLabel}]${paint.reset} `),
    suggestedLabel
  );
  const enteredCode = await ask(`${paint.cyan}Join code${paint.reset} ${paint.dim}[blank = generate one]${paint.reset} `);
  const accessCode = validAccessCode(enteredCode) ? normalizeAccessCode(enteredCode) : normalizeAccessCode(generateAccessCode());
  if (enteredCode && !validAccessCode(enteredCode)) {
    console.log(`${paint.yellow}Code was adjusted to a generated code because it must be ${MIN_ACCESS_CODE_LENGTH}-${MAX_ACCESS_CODE_LENGTH} letters or numbers.${paint.reset}`);
  }
  return {
    roomId: generateRoomId(),
    roomLabel: label,
    accessCode,
  };
}

async function askAccessCodeForRoom(room) {
  while (true) {
    const input = await ask(`\n${paint.cyan}Code for ${room.label}${paint.reset} ${paint.dim}(host ${room.hostUsername})${paint.reset} `);
    if (!input) return null;
    if (validAccessCode(input)) return normalizeAccessCode(input);
    console.log(`${paint.red}✕ That code is invalid.${paint.reset} ${paint.dim}Use ${MIN_ACCESS_CODE_LENGTH}-${MAX_ACCESS_CODE_LENGTH} letters or numbers.${paint.reset}`);
  }
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Messenger needs an interactive terminal.');

  await playChatStartupAnimation();

  const username = cleanUsername(process.env.WORDFX_CHAT_USERNAME || registeredUsername() || os.userInfo().username);
  const arguments_ = process.argv.slice(2);
  let mode = (arguments_.shift() || '').toLowerCase();

  if (!mode) mode = (await ask(`${paint.cyan}Host or join a room?${paint.reset} ${paint.dim}[host/join]${paint.reset} `)).toLowerCase();
  if (!['host', 'join'].includes(mode)) throw new Error('Usage: chat [host|join]');

  if (mode === 'host') {
    const setup = await askHostSetup(username);
    let uiEvent = () => {};
    let uiMessage = () => {};
    const transport = await startHost({
      roomId: setup.roomId,
      accessCode: setup.accessCode,
      roomLabel: setup.roomLabel,
      username,
      onEvent: event => uiEvent(event),
      onMessage: message => uiMessage(message),
    });
    Object.defineProperties(transport, {
      onUiEvent: { set: callback => { uiEvent = callback; } },
      onUiMessage: { set: callback => { uiMessage = callback; } },
    });
    await runChatInterface({
      transport,
      username,
      hostMode: true,
      roomLabel: setup.roomLabel,
      accessCode: setup.accessCode,
    });
    return;
  }

  let roomId = normalizeRoomId(arguments_.shift() || '');
  while (true) {
    let selectedRoom = null;
    if (roomId) {
      const rooms = await listPublicRooms();
      selectedRoom = rooms.find(room => room.roomId === roomId) || { roomId, label: roomId, hostUsername: 'HOST', createdAt: Date.now() };
    } else {
      selectedRoom = await askJoinRoomSelection();
    }
    if (!selectedRoom) return;

    const accessCode = await askAccessCodeForRoom(selectedRoom);
    if (!accessCode) {
      roomId = '';
      continue;
    }

    let uiEvent = () => {};
    let uiMessage = () => {};
    try {
      console.log(`${paint.dim}Connecting to ${selectedRoom.label}...${paint.reset}`);
      const transport = await connectToHost({
        roomId: selectedRoom.roomId,
        accessCode,
        username,
        onEvent: event => uiEvent(event),
        onMessage: message => uiMessage(message),
      });
      Object.defineProperties(transport, {
        onUiEvent: { set: callback => { uiEvent = callback; } },
        onUiMessage: { set: callback => { uiMessage = callback; } },
      });
      await runChatInterface({ transport, username, hostMode: false, roomLabel: selectedRoom.label });
      return;
    } catch (error) {
      console.log(`${paint.red}✕ Could not join ${selectedRoom.label}:${paint.reset} ${error.message}`);
      console.log(`${paint.dim}Choose a room again, or press Esc to return.${paint.reset}`);
      roomId = '';
    }
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(error => {
      playSound('error');
      console.error(`${paint.red}Messenger error:${paint.reset} ${error.message}`);
      process.exit(1);
    });
}

module.exports = {
  connectToHost,
  displayAccessCode,
  dissolveText,
  generateAccessCode,
  generateRoomId,
  historyRows,
  normalizeAccessCode,
  normalizeMessagePayload,
  normalizeRoomId,
  playChatStartupAnimation,
  relayBaseUrl,
  relayRoomUrl,
  renderChat,
  renderChatStartupFrame,
  scrollChatState,
  shouldNotifyForIncomingMessage,
  sanitizeReplyReference,
  jumpChatToLatest,
  startHost,
};
