#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registeredUsername } = require('./credentials');
const { playSound, playTypingSound, warmSoundSystem } = require('./sound');
const { ansi: paint, renderThemeRail, themeSpinner } = require('./theme');

const RELAY_CONFIG_PATH = path.join(__dirname, 'relay-config.json');
const MAX_MESSAGE_LENGTH = 1000;
const MAX_GUILD_NAME_LENGTH = 32;
const IDLE_AFTER_MS = 60 * 1000;
const PRESENCE_INTERVAL_MS = 5000;
const CONNECTION_TIMEOUT_MS = 15000;
const RELAY_HTTP_TIMEOUT_MS = 8000;
const GUILD_ICONS = ['#', '*', '+', '@', '%', '&', '~', '^', '$', '='];
const STATUS_ORDER = { online: 0, brb: 1, idle: 2, offline: 3 };

function cleanUsername(value) {
  const username = String(value || 'USER').trim().replace(/[\r\n\x00-\x1f\x7f]/g, '');
  return (username || 'USER').slice(0, 24);
}

function cleanGuildName(value) {
  const name = String(value || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
  return (name || 'Guild').slice(0, MAX_GUILD_NAME_LENGTH);
}

function cleanGuildIcon(value) {
  const icon = Array.from(String(value || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, '')).slice(0, 4).join('');
  return icon || '#';
}

function cleanMessage(value) {
  const text = String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

function normalizeGuildList(payload) {
  if (!payload || !Array.isArray(payload.guilds)) return [];
  return payload.guilds
    .filter(guild => guild && typeof guild === 'object')
    .map(guild => ({
      id: String(guild.id || '').toLowerCase(),
      name: cleanGuildName(guild.name),
      icon: cleanGuildIcon(guild.icon),
      createdBy: cleanUsername(guild.createdBy),
      createdAt: Number.isFinite(guild.createdAt) ? guild.createdAt : Date.now(),
      lastActivityAt: Number.isFinite(guild.lastActivityAt) ? guild.lastActivityAt : Date.now(),
      memberCount: Number.isFinite(guild.memberCount) ? guild.memberCount : 0,
      onlineCount: Number.isFinite(guild.onlineCount) ? guild.onlineCount : 0,
    }))
    .filter(guild => /^[a-z0-9]{10}$/.test(guild.id));
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
    throw new Error('Cloudflare relay is not deployed yet. Set WORDFX_CHAT_RELAY or update relay-config.json.');
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

function relayHttpUrl(pathname) {
  const url = relayHttpBaseUrl();
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${pathname}`;
  url.search = '';
  return url.toString();
}

function guildSocketUrl(guildId, username) {
  const url = relayBaseUrl();
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/guild/${String(guildId).toLowerCase()}`;
  url.search = new URLSearchParams({ username: cleanUsername(username) }).toString();
  return url.toString();
}

async function relayJson(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_HTTP_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(relayHttpUrl(pathname), { ...options, signal: controller.signal });
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const reason = aborted ? 'timed out' : 'failed';
    throw new Error(`Guild relay request ${reason}. Check the relay URL, internet access, and whether Node is allowed through the firewall.`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 404 && pathname.startsWith('/guild')) {
      throw new Error('The deployed Cloudflare relay does not have guild support yet. Run: npx.cmd --yes wrangler@latest deploy');
    }
    throw new Error(message || `Relay request failed with ${response.status}.`);
  }
  return response.json();
}

async function listGuilds() {
  return normalizeGuildList(await relayJson('/guilds'));
}

async function createGuildOnRelay({ name, icon, owner }) {
  const payload = await relayJson('/guilds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: cleanGuildName(name), icon: cleanGuildIcon(icon), owner: cleanUsername(owner) }),
  });
  const [guild] = normalizeGuildList({ guilds: [payload.guild] });
  if (!guild) throw new Error('The relay created a guild but returned invalid guild data.');
  return guild;
}

function ensureWebSocketSupport() {
  if (typeof WebSocket !== 'function' || typeof fetch !== 'function') {
    throw new Error('Guilds require Node.js 22 or newer.');
  }
}

function parseFrame(event) {
  if (typeof event.data !== 'string' || event.data.length > 16 * 1024) throw new Error('Invalid relay frame.');
  const frame = JSON.parse(event.data);
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
    throw new Error('Invalid relay frame.');
  }
  return frame;
}

function sendFrame(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

function connectGuild({ guildId, username, onSnapshot = () => {}, onBoardMessage = () => {}, onDmMessage = () => {}, onDmHistory = () => {}, onPresence = () => {}, onEvent = () => {} }) {
  ensureWebSocketSupport();
  const user = cleanUsername(username);
  const socket = new WebSocket(guildSocketUrl(guildId, user));
  let closed = false;

  const transport = {
    sendBoard(text) {
      return sendFrame(socket, { type: 'board-message', text: cleanMessage(text) });
    },
    sendDm(to, text) {
      return sendFrame(socket, { type: 'dm-message', to: cleanUsername(to), text: cleanMessage(text) });
    },
    sendPresence(status) {
      return sendFrame(socket, { type: 'presence', status });
    },
    requestDmHistory(withUser) {
      return sendFrame(socket, { type: 'dm-history', with: cleanUsername(withUser) });
    },
    refresh() {
      return sendFrame(socket, { type: 'refresh' });
    },
    close() {
      closed = true;
      socket.close(1000, 'Leaving guild');
    },
    destroy() {
      this.close();
    },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        closed = true;
        socket.close(4000, 'Connection timed out');
        reject(new Error('Guild connection timed out.'));
      }
    }, CONNECTION_TIMEOUT_MS);

    socket.addEventListener('message', event => {
      try {
        const frame = parseFrame(event);
        if (frame.type === 'guild-ready') {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(transport);
          }
          onSnapshot(frame);
        } else if (frame.type === 'presence') {
          onPresence(Array.isArray(frame.members) ? frame.members : []);
        } else if (frame.type === 'board-message') {
          onBoardMessage(frame.message);
        } else if (frame.type === 'dm-message') {
          onDmMessage(frame.with, frame.message);
        } else if (frame.type === 'dm-history') {
          onDmHistory(frame.with, Array.isArray(frame.messages) ? frame.messages : []);
        }
      } catch (error) {
        onEvent({ type: 'error', message: error.message });
      }
    });

    socket.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Could not connect to the Cloudflare relay.'));
      } else {
        onEvent({ type: 'error', message: 'Guild relay connection failed.' });
      }
    });

    socket.addEventListener('close', () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('The relay rejected the guild connection.'));
      } else if (!closed) {
        onEvent({ type: 'closed', message: 'Guild relay connection closed.' });
      }
    });
  });
}

function size() {
  return {
    width: Math.max(48, (process.stdout.columns || 80) - 1),
    height: Math.max(16, process.stdout.rows || 24),
  };
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function at(row, column, content) {
  return `\x1b[${Math.max(1, row)};${Math.max(1, column)}H${content}`;
}

function clearFrame(height) {
  let output = '\x1b[?25l\x1b[H';
  for (let row = 1; row <= height; row++) output += at(row, 1, '\x1b[2K');
  return output;
}

function clip(value, width) {
  const text = String(value);
  if (width <= 0) return '';
  if (stripAnsi(text).length <= width) return text;
  return width < 2 ? stripAnsi(text).slice(0, width) : `${stripAnsi(text).slice(0, width - 1)}...`;
}

function formatTime(value) {
  const date = new Date(Number.isFinite(value) ? value : Date.now());
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeSince(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function statusLabel(status) {
  if (status === 'brb') return 'brb';
  if (status === 'idle') return 'idle';
  if (status === 'online') return 'online';
  return 'offline';
}

function statusPaint(status) {
  if (status === 'online') return paint.green;
  if (status === 'brb') return paint.pink;
  if (status === 'idle') return paint.yellow;
  return paint.dim;
}

function normalizeMembers(values) {
  return [...values].sort((a, b) => {
    const status = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    return status || a.username.localeCompare(b.username);
  });
}

function readKeyTokens(buffer, forceEscape = false) {
  const tokens = [];
  let rest = String(buffer || '');
  const escapeSequences = new Map([
    ['\x1b[A', 'up'],
    ['\x1b[B', 'down'],
    ['\x1b[C', 'right'],
    ['\x1b[D', 'left'],
    ['\x1bOA', 'up'],
    ['\x1bOB', 'down'],
    ['\x1bOC', 'right'],
    ['\x1bOD', 'left'],
    ['\x1b[H', 'home'],
    ['\x1b[F', 'end'],
    ['\x1b[1~', 'home'],
    ['\x1b[4~', 'end'],
    ['\x1b[5~', 'pageup'],
    ['\x1b[6~', 'pagedown'],
    ['\x1b[Z', 'shift-tab'],
  ]);

  while (rest.length) {
    if (rest[0] === '\x1b') {
      const match = [...escapeSequences.entries()].find(([sequence]) => rest.startsWith(sequence));
      if (match) {
        tokens.push(match[1]);
        rest = rest.slice(match[0].length);
        continue;
      }
      const modifiedArrow = rest.match(/^\x1b\[1;[0-9]([ABCD])/);
      if (modifiedArrow) {
        tokens.push({ A: 'up', B: 'down', C: 'right', D: 'left' }[modifiedArrow[1]]);
        rest = rest.slice(modifiedArrow[0].length);
        continue;
      }
      const possibleEscape = [...escapeSequences.keys()].some(sequence => sequence.startsWith(rest))
        || /^\x1b\[(?:1(?:;[0-9]?)?)?$/.test(rest);
      if (possibleEscape && !forceEscape) break;
      if (rest.length === 1 && !forceEscape) break;
      tokens.push('escape');
      rest = rest.slice(1);
      continue;
    }
    if (rest.startsWith('\r\n')) {
      tokens.push('enter');
      rest = rest.slice(2);
      continue;
    }
    const ch = rest[0];
    if (ch === '\r' || ch === '\n') tokens.push('enter');
    else if (ch === '\t') tokens.push('tab');
    else if (ch === '\x03' || ch === '\x11') tokens.push('quit');
    else if (ch === '\x02') tokens.push('brb');
    else if (ch === '\x7f' || ch === '\b') tokens.push('backspace');
    else tokens.push(ch);
    rest = rest.slice(1);
  }

  return { tokens, rest };
}

function renderMemberRows(members, selected, focused, width) {
  const rows = [];
  for (let index = 0; index < members.length; index++) {
    const member = members[index];
    const selectedMarker = index === selected
      ? focused ? `${paint.bold}${paint.white}>${paint.reset}` : `${paint.dim}-${paint.reset}`
      : ' ';
    const color = statusPaint(member.status);
    const label = statusLabel(member.status).padEnd(7);
    const lastSeen = member.status === 'offline' && member.lastSeen ? ` ${timeSince(member.lastSeen)}` : '';
    const name = index === selected ? `${paint.bold}${paint.white}${clip(member.username, Math.max(4, width - 16))}${paint.reset}` : clip(member.username, Math.max(4, width - 16));
    rows.push(`${selectedMarker} ${color}o ${label}${paint.reset} ${name}${paint.dim}${lastSeen}${paint.reset}`);
  }
  return rows;
}

function renderGuildListOutput(state) {
  const { width, height } = size();
  const listWidth = Math.min(76, width - 4);
  const left = Math.max(1, Math.floor((width - listWidth) / 2) + 1);
  const inside = listWidth - 2;
  const rows = Math.max(3, height - 9);
  const scroll = Math.max(0, Math.min(state.selectedGuild - rows + 1, Math.max(0, state.guilds.length - rows)));
  let output = clearFrame(height);

  output += at(1, 1, `${paint.bold}${paint.white}:// GUILDS${paint.reset}`);
  output += at(2, 1, renderThemeRail(width, state.frame / 4.8));
  output += at(4, left, `${paint.purple}+${'-'.repeat(inside)}+${paint.reset}`);
  output += at(5, left, `${paint.purple}|${paint.reset} ${paint.bold}${paint.white}PUBLIC GUILDS${paint.reset}${' '.repeat(Math.max(0, inside - 14))}${paint.purple}|${paint.reset}`);
  output += at(6, left, `${paint.purple}+${'-'.repeat(inside)}+${paint.reset}`);

  if (state.loading) {
    output += at(7, left, `${paint.purple}|${paint.reset} ${paint.dim}${clip(state.loading, inside - 2)}${paint.reset}${' '.repeat(Math.max(0, inside - stripAnsi(state.loading).length - 1))}${paint.purple}|${paint.reset}`);
  } else if (!state.guilds.length) {
    const empty = 'No guilds yet. Press N to make the first one.';
    output += at(7, left, `${paint.purple}|${paint.reset} ${paint.dim}${empty}${paint.reset}${' '.repeat(Math.max(0, inside - empty.length - 1))}${paint.purple}|${paint.reset}`);
  } else {
    for (let row = 0; row < Math.min(rows, state.guilds.length); row++) {
      const guild = state.guilds[scroll + row];
      const selected = scroll + row === state.selectedGuild;
      const marker = selected ? `${paint.green}>${paint.reset}` : ' ';
      const counts = `${guild.onlineCount}/${guild.memberCount}`;
      const text = `${marker} ${paint.cyan}${guild.icon}${paint.reset} ${selected ? paint.bold + paint.white : paint.white}${clip(guild.name, inside - 22)}${paint.reset}`;
      const right = `${paint.dim}${counts} online${paint.reset}`;
      output += at(7 + row, left, `${paint.purple}|${paint.reset} ${text}${' '.repeat(Math.max(1, inside - stripAnsi(text).length - stripAnsi(right).length - 2))}${right} ${paint.purple}|${paint.reset}`);
    }
  }

  const bottom = Math.min(height - 3, 7 + Math.max(1, Math.min(rows, state.guilds.length || 1)));
  output += at(bottom, left, `${paint.purple}+${'-'.repeat(inside)}+${paint.reset}`);
  if (state.notice) output += at(height - 2, 1, `${paint.yellow}${clip(state.notice, width - 1)}${paint.reset}`);
  output += at(height - 1, 1, `${paint.dim}Enter join  N new  R refresh  Esc close${paint.reset}`);
  return output;
}

function renderCreateOutput(state) {
  const { width, height } = size();
  const boxWidth = Math.min(62, width - 4);
  const inside = boxWidth - 2;
  const left = Math.max(1, Math.floor((width - boxWidth) / 2) + 1);
  const top = Math.max(3, Math.floor(height / 2) - 4);
  let output = clearFrame(height);
  output += at(1, 1, `${paint.bold}${paint.white}:// CREATE GUILD${paint.reset}`);
  output += at(2, 1, renderThemeRail(width, state.frame / 4.8));
  output += at(top, left, `${paint.green}+${'-'.repeat(inside)}+${paint.reset}`);
  output += at(top + 1, left, `${paint.green}|${paint.reset} ${paint.bold}${paint.white}NEW GUILD${paint.reset}${' '.repeat(inside - 10)}${paint.green}|${paint.reset}`);
  output += at(top + 2, left, `${paint.green}+${'-'.repeat(inside)}+${paint.reset}`);
  output += at(top + 3, left, `${paint.green}|${paint.reset} Logo ${paint.cyan}${state.createIcon}${paint.reset}   ${paint.dim}Left/Right changes it${paint.reset}${' '.repeat(Math.max(0, inside - 31))}${paint.green}|${paint.reset}`);
  const name = state.input || '_';
  output += at(top + 4, left, `${paint.green}|${paint.reset} Name ${paint.white}${clip(name, inside - 8)}${paint.reset}${' '.repeat(Math.max(0, inside - stripAnsi(name).length - 7))}${paint.green}|${paint.reset}`);
  output += at(top + 5, left, `${paint.green}+${'-'.repeat(inside)}+${paint.reset}`);
  if (state.notice) output += at(height - 2, 1, `${paint.yellow}${clip(state.notice, width - 1)}${paint.reset}`);
  output += at(height - 1, 1, `${paint.dim}Enter create  Esc cancel${paint.reset}`);
  output += at(top + 4, left + 7 + Math.min(state.inputCursor, inside - 8), '\x1b[?25h');
  return output;
}

function renderBoardOutput(state) {
  const { width, height } = size();
  const memberWidth = Math.max(22, Math.min(34, Math.floor(width * 0.28)));
  const gutter = 2;
  const postColumn = memberWidth + gutter + 1;
  const postWidth = Math.max(22, width - memberWidth - gutter);
  const contentTop = 4;
  const inputRow = height - 2;
  const messageRows = Math.max(4, inputRow - contentTop - 1);
  const visibleMessages = state.board.slice(-messageRows);
  const guild = state.currentGuild || { name: 'Guild', icon: '#' };
  let output = clearFrame(height);

  output += at(1, 1, `${paint.bold}${paint.cyan}[${cleanGuildIcon(guild.icon)}]${paint.reset} ${paint.bold}${paint.white}${clip(guild.name, width - 28)}${paint.reset} ${paint.dim}SERVER BOARD${paint.reset}`);
  output += at(2, 1, renderThemeRail(width, state.frame / 4.8));
  output += at(3, 1, `${state.memberFocus ? paint.bold + paint.white : paint.dim}USERS${paint.reset}`);
  output += at(3, postColumn, `${!state.memberFocus ? paint.bold + paint.white : paint.dim}POSTS${paint.reset} ${paint.dim}${state.board.length} total${paint.reset}`);

  const memberRows = renderMemberRows(state.members, state.selectedMember, state.memberFocus, memberWidth - 1);
  for (let row = 0; row < Math.min(memberRows.length, messageRows); row++) {
    output += at(contentTop + row, 1, clip(memberRows[row], memberWidth - 1));
  }
  for (let row = memberRows.length; row < messageRows; row++) {
    output += at(contentTop + row, 1, `${paint.dim}${'.'.repeat(Math.min(3, memberWidth - 1))}${paint.reset}`);
  }

  for (let row = 0; row < messageRows; row++) {
    const message = visibleMessages[row];
    if (!message) continue;
    const mine = message.author?.toLowerCase() === state.username.toLowerCase();
    const author = mine ? paint.green : paint.cyan;
    const prefix = `${paint.dim}${formatTime(message.createdAt)}${paint.reset} ${author}${clip(message.author, 14)}${paint.reset} `;
    output += at(contentTop + row, postColumn, `${prefix}${paint.white}${clip(message.text, postWidth - stripAnsi(prefix).length - 1)}${paint.reset}`);
  }

  const prompt = `${paint.cyan}#${paint.reset} `;
  const inputWidth = Math.max(8, postWidth - 4);
  const visibleInput = state.input.slice(Math.max(0, state.input.length - inputWidth));
  output += at(height - 3, 1, renderThemeRail(width, state.frame / 4.8));
  output += at(inputRow, postColumn, `${prompt}${paint.white}${visibleInput}${paint.reset}\x1b[K`);
  const presence = `${statusPaint(state.presence)}${statusLabel(state.presence)}${paint.reset}`;
  const hint = state.memberFocus
    ? 'Users: Up/Down select  Enter DM  Tab posts'
    : 'Type post  Enter send  Tab users  Ctrl+B brb  Esc guilds';
  const footer = state.notice ? `${paint.yellow}${clip(state.notice, width - 1)}${paint.reset}` : `${paint.dim}${hint}${paint.reset}  ${paint.dim}status:${paint.reset} ${presence}`;
  output += at(height - 1, 1, footer);
  output += at(inputRow, postColumn + 2 + Math.min(visibleInput.length, inputWidth), '\x1b[?25h');
  return output;
}

function renderDmOutput(state) {
  const { width, height } = size();
  const messages = state.dms.get(state.dmKey) || [];
  const rows = Math.max(4, height - 6);
  const visibleMessages = messages.slice(-rows);
  let output = clearFrame(height);

  output += at(1, 1, `${paint.bold}${paint.white}DM${paint.reset} ${paint.dim}with${paint.reset} ${paint.pink}${state.dmTarget}${paint.reset}`);
  output += at(2, 1, renderThemeRail(width, state.frame / 4.8));
  for (let row = 0; row < rows; row++) {
    const message = visibleMessages[row];
    if (!message) continue;
    const mine = message.author?.toLowerCase() === state.username.toLowerCase();
    const color = mine ? paint.green : paint.pink;
    const prefix = `${paint.dim}${formatTime(message.createdAt)}${paint.reset} ${color}${clip(message.author, 14)}${paint.reset} `;
    output += at(3 + row, 1, `${prefix}${paint.white}${clip(message.text, width - stripAnsi(prefix).length - 1)}${paint.reset}`);
  }

  const prompt = `${paint.pink}>${paint.reset} `;
  const inputWidth = width - 4;
  const visibleInput = state.input.slice(Math.max(0, state.input.length - inputWidth));
  output += at(height - 3, 1, renderThemeRail(width, state.frame / 4.8));
  output += at(height - 2, 1, `${prompt}${paint.white}${visibleInput}${paint.reset}\x1b[K`);
  output += at(height - 1, 1, state.notice ? `${paint.yellow}${clip(state.notice, width - 1)}${paint.reset}` : `${paint.dim}Enter send DM  Ctrl+B brb  Esc main board${paint.reset}`);
  output += at(height - 2, 3 + Math.min(visibleInput.length, inputWidth), '\x1b[?25h');
  return output;
}

const USERNAME = cleanUsername(process.env.WORDFX_CHAT_USERNAME || registeredUsername() || os.userInfo().username);

const ui = {
  username: USERNAME,
  view: 'guilds',
  guilds: [],
  selectedGuild: 0,
  selectedMember: 0,
  memberFocus: false,
  currentGuild: null,
  board: [],
  members: [],
  dms: new Map(),
  dmTarget: '',
  dmKey: '',
  input: '',
  inputCursor: 0,
  createIconIndex: 0,
  createIcon: GUILD_ICONS[0],
  frame: 0,
  loading: 'Loading guilds...',
  notice: '',
  noticeUntil: 0,
  presence: 'online',
};

let transport = null;
let renderTimer = null;
let presenceTimer = null;
let lastActivityAt = Date.now();
let manualBrb = false;
let keyBuffer = '';
let escapeTimer = null;

function setNotice(message, milliseconds = 2500) {
  ui.notice = message;
  ui.noticeUntil = Date.now() + milliseconds;
}

function setInput(value = '') {
  ui.input = value;
  ui.inputCursor = ui.input.length;
}

function render() {
  if (ui.notice && Date.now() > ui.noticeUntil) ui.notice = '';
  let output;
  if (ui.view === 'create') output = renderCreateOutput(ui);
  else if (ui.view === 'board') output = renderBoardOutput(ui);
  else if (ui.view === 'dm') output = renderDmOutput(ui);
  else output = renderGuildListOutput(ui);
  process.stdout.write(output);
}

async function refreshGuilds() {
  ui.loading = 'Refreshing guilds...';
  render();
  try {
    ui.guilds = await listGuilds();
    ui.selectedGuild = Math.max(0, Math.min(ui.selectedGuild, ui.guilds.length - 1));
    ui.loading = '';
  } catch (error) {
    ui.loading = '';
    setNotice(error.message, 5000);
  }
  render();
}

function applySnapshot(frame) {
  ui.currentGuild = frame.guild;
  ui.board = Array.isArray(frame.board) ? frame.board : [];
  ui.members = normalizeMembers(Array.isArray(frame.members) ? frame.members : []);
  ui.dms = new Map(Object.entries(frame.dms || {}).map(([key, messages]) => [key.toLowerCase(), Array.isArray(messages) ? messages : []]));
  const selectedMember = ui.members[ui.selectedMember];
  if (!selectedMember || selectedMember.username.toLowerCase() === ui.username.toLowerCase()) {
    const firstPeer = ui.members.findIndex(member => member.username.toLowerCase() !== ui.username.toLowerCase());
    ui.selectedMember = firstPeer >= 0 ? firstPeer : Math.max(0, Math.min(ui.selectedMember, ui.members.length - 1));
  } else {
    ui.selectedMember = Math.max(0, Math.min(ui.selectedMember, ui.members.length - 1));
  }
  ui.view = 'board';
  ui.loading = '';
  render();
}

function updateMembers(members) {
  ui.members = normalizeMembers(Array.isArray(members) ? members : []);
  ui.selectedMember = Math.max(0, Math.min(ui.selectedMember, ui.members.length - 1));
  render();
}

function dmKeyFor(name) {
  return cleanUsername(name).toLowerCase();
}

async function joinGuild(guild) {
  if (!guild) return;
  if (transport) transport.close();
  ui.loading = `Joining ${guild.name}...`;
  render();
  try {
    transport = await connectGuild({
      guildId: guild.id,
      username: USERNAME,
      onSnapshot: applySnapshot,
      onPresence: updateMembers,
      onBoardMessage: message => {
        if (!message) return;
        ui.board.push(message);
        if (message.author?.toLowerCase() !== USERNAME.toLowerCase()) playSound('chat_receive');
        render();
      },
      onDmMessage: (withUser, message) => {
        const key = dmKeyFor(withUser);
        ui.dms.set(key, [...(ui.dms.get(key) || []), message]);
        if (message.author?.toLowerCase() !== USERNAME.toLowerCase()) playSound('notification');
        render();
      },
      onDmHistory: (withUser, messages) => {
        ui.dms.set(dmKeyFor(withUser), messages);
        render();
      },
      onEvent: event => {
        setNotice(event.message || 'Guild connection changed.');
        render();
      },
    });
    ui.presence = 'online';
    manualBrb = false;
    transport.sendPresence(ui.presence);
  } catch (error) {
    ui.loading = '';
    setNotice(error.message, 5000);
  }
  render();
}

async function createAndJoinGuild() {
  if (!ui.input.trim()) {
    setNotice('Type a guild name first.');
    return;
  }
  const name = cleanGuildName(ui.input);
  ui.loading = `Creating ${name}...`;
  ui.view = 'guilds';
  render();
  try {
    const guild = await createGuildOnRelay({ name, icon: ui.createIcon, owner: USERNAME });
    await joinGuild(guild);
    void refreshGuilds();
    playSound('success');
  } catch (error) {
    ui.loading = '';
    setNotice(error.message, 5000);
  }
  render();
}

function setPresence(status, force = false) {
  if (!['online', 'idle', 'brb'].includes(status)) status = 'online';
  if (!force && ui.presence === status) return;
  ui.presence = status;
  if (transport) transport.sendPresence(status);
}

function markActivity() {
  lastActivityAt = Date.now();
  if (manualBrb) {
    manualBrb = false;
    setPresence('online');
  } else if (ui.presence === 'idle') {
    setPresence('online');
  }
}

function toggleBrb() {
  manualBrb = ui.presence !== 'brb';
  lastActivityAt = Date.now();
  setPresence(manualBrb ? 'brb' : 'online', true);
  playSound(manualBrb ? 'toggle_on' : 'toggle_off');
}

function leaveGuild() {
  if (transport) transport.close();
  transport = null;
  ui.currentGuild = null;
  ui.board = [];
  ui.members = [];
  ui.dms = new Map();
  ui.memberFocus = false;
  ui.view = 'guilds';
  setInput('');
  void refreshGuilds();
}

function openDm(member) {
  if (!member || member.username.toLowerCase() === USERNAME.toLowerCase()) return;
  ui.dmTarget = member.username;
  ui.dmKey = dmKeyFor(member.username);
  ui.view = 'dm';
  setInput('');
  transport?.requestDmHistory(member.username);
  playSound('confirm');
}

function insertInput(key) {
  if (ui.input.length >= MAX_MESSAGE_LENGTH) return;
  ui.input = ui.input.slice(0, ui.inputCursor) + key + ui.input.slice(ui.inputCursor);
  ui.inputCursor += key.length;
}

function backspaceInput() {
  if (ui.inputCursor <= 0) return;
  ui.input = ui.input.slice(0, ui.inputCursor - 1) + ui.input.slice(ui.inputCursor);
  ui.inputCursor--;
}

function handleTextInput(key) {
  if (key === 'backspace') {
    backspaceInput();
  } else if (key === 'left') {
    ui.inputCursor = Math.max(0, ui.inputCursor - 1);
  } else if (key === 'right') {
    ui.inputCursor = Math.min(ui.input.length, ui.inputCursor + 1);
  } else if (typeof key === 'string' && key.length === 1 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(key)) {
    for (const character of Array.from(key)) insertInput(character);
  }
}

function handleGuildListInput(key) {
  if (key === 'escape') return shutdown(0);
  if (key === 'r' || key === 'R') return void refreshGuilds();
  if (key === 'n' || key === 'N') {
    ui.view = 'create';
    ui.createIconIndex = 0;
    ui.createIcon = GUILD_ICONS[0];
    setInput('');
    playSound('select');
    return;
  }
  if (key === 'up') {
    ui.selectedGuild = Math.max(0, ui.selectedGuild - 1);
    playSound('navigate');
  } else if (key === 'down') {
    ui.selectedGuild = Math.min(ui.guilds.length - 1, ui.selectedGuild + 1);
    playSound('navigate');
  } else if (key === 'enter' && ui.guilds.length) {
    playSound('confirm');
    void joinGuild(ui.guilds[ui.selectedGuild]);
  }
}

function handleCreateInput(key) {
  if (key === 'escape') {
    ui.view = 'guilds';
    setInput('');
    return;
  }
  if (key === 'left') {
    ui.createIconIndex = (ui.createIconIndex - 1 + GUILD_ICONS.length) % GUILD_ICONS.length;
    ui.createIcon = GUILD_ICONS[ui.createIconIndex];
    playSound('navigate');
    return;
  }
  if (key === 'right') {
    ui.createIconIndex = (ui.createIconIndex + 1) % GUILD_ICONS.length;
    ui.createIcon = GUILD_ICONS[ui.createIconIndex];
    playSound('navigate');
    return;
  }
  if (key === 'enter') return void createAndJoinGuild();
  if (ui.input.length < MAX_GUILD_NAME_LENGTH || key === 'backspace') handleTextInput(key);
}

function handleBoardInput(key) {
  if (key === 'escape') return leaveGuild();
  if (key === 'tab') {
    ui.memberFocus = !ui.memberFocus;
    playSound('navigate');
    return;
  }
  if (key === 'up') {
    ui.memberFocus = true;
    ui.selectedMember = Math.max(0, ui.selectedMember - 1);
    playSound('navigate');
    return;
  }
  if (key === 'down') {
    ui.memberFocus = true;
    ui.selectedMember = Math.min(ui.members.length - 1, ui.selectedMember + 1);
    playSound('navigate');
    return;
  }
  if (ui.memberFocus) {
    if (key === 'enter') {
      openDm(ui.members[ui.selectedMember]);
    }
    return;
  }
  if (key === 'enter') {
    const text = cleanMessage(ui.input);
    if (text && transport?.sendBoard(text)) {
      playSound('chat_send');
      setInput('');
    }
    return;
  }
  handleTextInput(key);
}

function handleDmInput(key) {
  if (key === 'escape') {
    ui.view = 'board';
    setInput('');
    return;
  }
  if (key === 'enter') {
    const text = cleanMessage(ui.input);
    if (text && transport?.sendDm(ui.dmTarget, text)) {
      playSound('chat_send');
      setInput('');
    }
    return;
  }
  handleTextInput(key);
}

function processKey(key) {
  playTypingSound(key);
  if (key === 'quit') return shutdown(0);
  if (key === 'brb' && transport) {
    toggleBrb();
    return;
  }
  markActivity();

  if (ui.view === 'create') handleCreateInput(key);
  else if (ui.view === 'board') handleBoardInput(key);
  else if (ui.view === 'dm') handleDmInput(key);
  else handleGuildListInput(key);
}

function drainKeyBuffer(forceEscape = false) {
  const decoded = readKeyTokens(keyBuffer, forceEscape);
  keyBuffer = decoded.rest;
  if (!decoded.tokens.length) return false;
  for (const token of decoded.tokens) processKey(token);
  render();
  return true;
}

function handleInput(data) {
  keyBuffer += data.toString('utf8');
  if (escapeTimer) {
    clearTimeout(escapeTimer);
    escapeTimer = null;
  }
  drainKeyBuffer(false);
  if (keyBuffer === '\x1b') {
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      drainKeyBuffer(true);
    }, 35);
    escapeTimer.unref?.();
  }
}

function cleanup() {
  if (renderTimer) clearInterval(renderTimer);
  if (presenceTimer) clearInterval(presenceTimer);
  if (escapeTimer) clearTimeout(escapeTimer);
  if (transport) transport.close();
  process.stdin.off('data', handleInput);
  if (process.stdin.isRaw) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m');
}

function shutdown(code = 0) {
  playSound('closing or quitting');
  cleanup();
  process.exit(code);
}

async function start() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Guild mode needs an interactive terminal.');
    process.exit(1);
  }
  void warmSoundSystem(0);
  playSound('opening or loading');
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  process.stdout.on('resize', render);

  renderTimer = setInterval(() => {
    ui.frame++;
    render();
  }, 250);
  presenceTimer = setInterval(() => {
    if (!transport) return;
    if (!manualBrb && ui.presence === 'online' && Date.now() - lastActivityAt > IDLE_AFTER_MS) {
      setPresence('idle', true);
    } else {
      transport.sendPresence(ui.presence);
    }
  }, PRESENCE_INTERVAL_MS);

  render();
  await refreshGuilds();
}

process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0));

if (require.main === module) {
  start().catch(error => {
    playSound('error');
    cleanup();
    console.error(`Guild mode failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  cleanGuildIcon,
  cleanGuildName,
  cleanMessage,
  cleanUsername,
  connectGuild,
  createGuildOnRelay,
  guildSocketUrl,
  listGuilds,
  normalizeGuildList,
  readKeyTokens,
  renderBoardOutput,
  renderDmOutput,
  renderGuildListOutput,
  statusLabel,
};
