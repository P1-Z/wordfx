const MAX_FRAME_LENGTH = 16 * 1024;
const IDLE_ROOM_TIMEOUT_MS = 2 * 60 * 1000;
const ROOM_PATTERN = /^[A-Z0-9]{10}$/;
const ROOM_DIRECTORY_KEY = 'global-room-directory';
const GUILD_DIRECTORY_KEY = 'global-guild-directory';
const GUILD_PATTERN = /^[a-z0-9]{10}$/;
const MAX_GUILD_NAME_LENGTH = 32;
const MAX_GUILD_ICON_LENGTH = 4;
const MAX_GUILD_MESSAGE_LENGTH = 1000;
const MAX_GUILD_BOARD_ITEMS = 500;
const MAX_GUILD_DM_ITEMS = 300;
const VALID_PRESENCE = new Set(['online', 'idle', 'brb']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'wordfx-chat-relay' });
    }

    if (url.pathname === '/rooms') {
      const stub = env.ROOM_DIRECTORY.get(env.ROOM_DIRECTORY.idFromName(ROOM_DIRECTORY_KEY));
      return stub.fetch(request);
    }

    if (url.pathname === '/guilds') {
      const stub = env.GUILD_DIRECTORY.get(env.GUILD_DIRECTORY.idFromName(GUILD_DIRECTORY_KEY));
      if (request.method === 'POST') {
        let payload;
        try {
          payload = await readSmallJson(request);
        } catch {
          return new Response('Invalid guild payload', { status: 400 });
        }
        const guildId = generateGuildId();
        const guild = env.GUILDS.get(env.GUILDS.idFromName(guildId));
        return guild.fetch('https://guild/internal/init', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: guildId,
            name: payload?.name,
            icon: payload?.icon,
            owner: payload?.owner,
          }),
        });
      }
      return stub.fetch(request);
    }

    const guildMatch = url.pathname.match(/^\/guild\/([a-z0-9]{10})$/i);
    if (guildMatch) {
      const guildId = guildMatch[1].toLowerCase();
      if (!GUILD_PATTERN.test(guildId)) return new Response('Invalid guild', { status: 400 });
      const id = env.GUILDS.idFromName(guildId);
      return env.GUILDS.get(id).fetch(request);
    }

    const match = url.pathname.match(/^\/room\/([A-Z0-9]{10})$/i);
    if (!match) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const room = match[1].toUpperCase();
    if (!ROOM_PATTERN.test(room)) return new Response('Invalid room', { status: 400 });
    const id = env.CHAT_ROOMS.idFromName(room);
    return env.CHAT_ROOMS.get(id).fetch(request);
  },
};

async function sendDirectoryUpdate(env, action, room) {
  const stub = env.ROOM_DIRECTORY.get(env.ROOM_DIRECTORY.idFromName(ROOM_DIRECTORY_KEY));
  return stub.fetch('https://room-directory/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, room }),
  });
}

function normalizeLabel(value) {
  return String(value || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 32) || 'ROOM';
}

function normalizeUsername(value) {
  return String(value || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, '').slice(0, 24) || 'HOST';
}

function normalizeGuildName(value) {
  return String(value || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, MAX_GUILD_NAME_LENGTH) || 'Guild';
}

function normalizeGuildIcon(value) {
  const icon = Array.from(String(value || '').trim().replace(/[\r\n\x00-\x1f\x7f]/g, '')).slice(0, MAX_GUILD_ICON_LENGTH).join('');
  return icon || '#';
}

function normalizeGuildText(value, limit = MAX_GUILD_MESSAGE_LENGTH) {
  const text = String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return text.slice(0, limit);
}

function generateGuildId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function createGuildMessage(author, text) {
  return {
    id: crypto.randomUUID(),
    author: normalizeUsername(author),
    text: normalizeGuildText(text),
    createdAt: Date.now(),
  };
}

function dmKey(a, b) {
  return [normalizeUsername(a).toLowerCase(), normalizeUsername(b).toLowerCase()].sort().join('\u0000');
}

async function sendGuildDirectoryUpdate(env, action, guild) {
  const stub = env.GUILD_DIRECTORY.get(env.GUILD_DIRECTORY.idFromName(GUILD_DIRECTORY_KEY));
  return stub.fetch('https://guild-directory/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, guild }),
  });
}

async function readSmallJson(request, maxLength = 4096) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > maxLength) throw new Error('Payload too large');
  const text = await request.text();
  if (text.length > maxLength) throw new Error('Payload too large');
  return text ? JSON.parse(text) : {};
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  activeSockets() {
    return this.state.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN);
  }

  roleOf(socket) {
    return socket.deserializeAttachment()?.role;
  }

  hostSocket() {
    return this.activeSockets().find(socket => this.roleOf(socket) === 'host');
  }

  guestSocket() {
    return this.activeSockets().find(socket => this.roleOf(socket) === 'guest');
  }

  hostAttachment() {
    return this.hostSocket()?.deserializeAttachment() || null;
  }

  anyoneTyping() {
    return this.activeSockets().some(socket => Boolean(socket.deserializeAttachment()?.typing));
  }

  async publishRoomAvailability() {
    const host = this.hostAttachment();
    if (!host) return;
    if (this.guestSocket()) {
      await sendDirectoryUpdate(this.env, 'remove', { roomId: host.roomId });
      return;
    }
    await sendDirectoryUpdate(this.env, 'upsert', {
      roomId: host.roomId,
      label: host.label,
      hostUsername: host.hostUsername,
      createdAt: host.createdAt,
      expiresAt: Number.isFinite(host.expiresAt) ? host.expiresAt : null,
    });
  }

  async syncIdleAlarm() {
    const host = this.hostSocket();
    if (!host) {
      await this.state.storage.deleteAlarm();
      return;
    }

    if (this.anyoneTyping()) {
      const attachment = host.deserializeAttachment();
      host.serializeAttachment({ ...attachment, expiresAt: null });
      await this.state.storage.deleteAlarm();
    } else {
      const expiresAt = Date.now() + IDLE_ROOM_TIMEOUT_MS;
      const attachment = host.deserializeAttachment();
      host.serializeAttachment({ ...attachment, expiresAt });
      await this.state.storage.setAlarm(expiresAt);
    }
    await this.publishRoomAvailability();
  }

  async removeRoomAvailability(socket) {
    const attachment = socket?.deserializeAttachment();
    if (!attachment?.roomId) return;
    await sendDirectoryUpdate(this.env, 'remove', { roomId: attachment.roomId });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (!['host', 'guest'].includes(role)) return new Response('Invalid role', { status: 400 });

    const occupied = this.activeSockets().some(socket => this.roleOf(socket) === role);
    if (occupied) return new Response(`${role} slot is already occupied`, { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const roomId = url.pathname.split('/').pop()?.toUpperCase() || '';
    const attachment = role === 'host'
      ? {
          role,
          roomId,
          label: normalizeLabel(url.searchParams.get('label')),
          hostUsername: normalizeUsername(url.searchParams.get('host')),
          createdAt: Date.now(),
          typing: false,
          expiresAt: null,
        }
      : { role, roomId, typing: false };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify({ type: 'relay-ready', role }));

    const host = this.hostSocket();
    const guest = this.guestSocket();
    if (host && guest) {
      const connected = JSON.stringify({ type: 'relay-peer-connected' });
      host.send(connected);
      guest.send(connected);
    }
    await this.syncIdleAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > MAX_FRAME_LENGTH) {
      socket.close(1009, 'Invalid or oversized frame');
      return;
    }
    try {
      const frame = JSON.parse(message);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
        throw new Error('Invalid frame');
      }
      if (frame.type === 'typing') {
        const attachment = socket.deserializeAttachment() || {};
        socket.serializeAttachment({ ...attachment, typing: Boolean(frame.active) });
        await this.syncIdleAlarm();
      }
    } catch {
      socket.close(1007, 'Invalid JSON frame');
      return;
    }
    const peer = this.activeSockets().find(candidate => this.roleOf(candidate) !== this.roleOf(socket));
    if (peer) peer.send(message);
  }

  async webSocketClose(socket, code, reason) {
    const role = this.roleOf(socket);
    if (role === 'host') {
      await this.removeRoomAvailability(socket);
      await this.state.storage.deleteAlarm();
    }
    const peer = this.activeSockets().find(candidate => this.roleOf(candidate) !== role);
    if (!peer) return;
    peer.send(JSON.stringify({ type: 'relay-peer-disconnected' }));
    if (role === 'host') peer.close(1000, 'Host left');
    else await this.syncIdleAlarm();
  }

  async alarm() {
    if (this.anyoneTyping()) {
      await this.syncIdleAlarm();
      return;
    }

    const host = this.hostSocket();
    if (host) await this.removeRoomAvailability(host);
    const frame = JSON.stringify({ type: 'relay-room-idle' });
    for (const socket of this.activeSockets()) {
      socket.send(frame);
      socket.close(1000, 'Room idle timeout');
    }
  }

  async webSocketError(socket) {
    const role = this.roleOf(socket);
    socket.close(1011, 'Relay socket error');
    if (role === 'host') {
      await this.removeRoomAvailability(socket);
      await this.state.storage.deleteAlarm();
    }
    const peer = this.activeSockets().find(candidate => this.roleOf(candidate) !== role);
    if (!peer) return;
    peer.send(JSON.stringify({ type: 'relay-peer-disconnected' }));
    if (role === 'host') peer.close(1011, 'Host connection failed');
    else await this.syncIdleAlarm();
  }
}

export class GuildRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  activeSockets() {
    return this.state.getWebSockets().filter(socket => socket.readyState === WebSocket.OPEN);
  }

  attachmentOf(socket) {
    return socket.deserializeAttachment() || {};
  }

  socketsFor(username) {
    const normalized = normalizeUsername(username).toLowerCase();
    return this.activeSockets().filter(socket => this.attachmentOf(socket).username?.toLowerCase() === normalized);
  }

  send(socket, frame) {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(frame) {
    for (const socket of this.activeSockets()) this.send(socket, frame);
  }

  async meta() {
    return await this.state.storage.get('meta');
  }

  async members() {
    return (await this.state.storage.get('members')) || {};
  }

  async board() {
    return (await this.state.storage.get('board')) || [];
  }

  async dms() {
    return (await this.state.storage.get('dms')) || {};
  }

  memberList(members) {
    const active = new Map();
    for (const socket of this.activeSockets()) {
      const attachment = this.attachmentOf(socket);
      if (!attachment.username) continue;
      active.set(attachment.username.toLowerCase(), {
        username: attachment.username,
        status: VALID_PRESENCE.has(attachment.status) ? attachment.status : 'online',
        lastSeen: attachment.lastSeen || Date.now(),
      });
    }

    const byName = new Map();
    for (const member of Object.values(members)) {
      const key = member.username.toLowerCase();
      const live = active.get(key);
      byName.set(key, {
        username: member.username,
        role: member.role || 'member',
        joinedAt: Number.isFinite(member.joinedAt) ? member.joinedAt : Date.now(),
        status: live ? live.status : 'offline',
        lastSeen: live ? live.lastSeen : member.lastSeen,
      });
    }
    for (const live of active.values()) {
      const key = live.username.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, {
          username: live.username,
          role: 'member',
          joinedAt: Date.now(),
          status: live.status,
          lastSeen: live.lastSeen,
        });
      }
    }
    return [...byName.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  dmsForUser(allDms, username) {
    const normalized = normalizeUsername(username).toLowerCase();
    const visible = {};
    for (const [key, messages] of Object.entries(allDms)) {
      const participants = key.split('\u0000');
      if (!participants.includes(normalized)) continue;
      const peer = participants.find(participant => participant !== normalized);
      visible[peer] = messages;
    }
    return visible;
  }

  async publishDirectory(meta, members = null) {
    if (!meta) return;
    const memberValues = Object.values(members || await this.members());
    await sendGuildDirectoryUpdate(this.env, 'upsert', {
      id: meta.id,
      name: meta.name,
      icon: meta.icon,
      createdBy: meta.createdBy,
      createdAt: meta.createdAt,
      lastActivityAt: meta.lastActivityAt,
      memberCount: memberValues.length,
      onlineCount: this.memberList(Object.fromEntries(memberValues.map(member => [member.username.toLowerCase(), member])))
        .filter(member => member.status !== 'offline').length,
    });
  }

  async sendSnapshot(socket, username) {
    const meta = await this.meta();
    const members = await this.members();
    const board = await this.board();
    const dms = await this.dms();
    this.send(socket, {
      type: 'guild-ready',
      guild: meta,
      board,
      members: this.memberList(members),
      dms: this.dmsForUser(dms, username),
    });
  }

  async updatePresence(socket, status) {
    const attachment = this.attachmentOf(socket);
    const username = normalizeUsername(attachment.username);
    const safeStatus = VALID_PRESENCE.has(status) ? status : 'online';
    const now = Date.now();
    socket.serializeAttachment({ ...attachment, username, status: safeStatus, lastSeen: now });

    const members = await this.members();
    const key = username.toLowerCase();
    const existing = members[key] || { username, role: 'member', joinedAt: now };
    members[key] = { ...existing, username, status: safeStatus, lastSeen: now };
    await this.state.storage.put('members', members);

    const list = this.memberList(members);
    this.broadcast({ type: 'presence', members: list });
    await this.publishDirectory(await this.meta(), members);
  }

  async initialize(request) {
    const payload = await readSmallJson(request);
    const existing = await this.meta();
    if (existing) return Response.json({ guild: existing });
    const now = Date.now();
    const owner = normalizeUsername(payload.owner);
    const meta = {
      id: String(payload.id || '').toLowerCase(),
      name: normalizeGuildName(payload.name),
      icon: normalizeGuildIcon(payload.icon),
      createdBy: owner,
      createdAt: now,
      lastActivityAt: now,
    };
    if (!GUILD_PATTERN.test(meta.id)) return new Response('Invalid guild id', { status: 400 });
    const members = {
      [owner.toLowerCase()]: {
        username: owner,
        role: 'leader',
        joinedAt: now,
        status: 'offline',
        lastSeen: now,
      },
    };
    await this.state.storage.put('meta', meta);
    await this.state.storage.put('members', members);
    await this.state.storage.put('board', []);
    await this.state.storage.put('dms', {});
    await this.publishDirectory(meta, members);
    return Response.json({ guild: { ...meta, memberCount: 1, onlineCount: 0 } }, { status: 201 });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/internal/init') return this.initialize(request);

    const meta = await this.meta();
    if (!meta) return new Response('Guild not found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ guild: meta });
    }

    const username = normalizeUsername(url.searchParams.get('username'));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ username, status: 'online', connectedAt: Date.now(), lastSeen: Date.now() });

    const now = Date.now();
    const members = await this.members();
    const key = username.toLowerCase();
    members[key] = {
      ...(members[key] || { username, role: 'member', joinedAt: now }),
      username,
      status: 'online',
      lastSeen: now,
    };
    await this.state.storage.put('members', members);
    await this.sendSnapshot(server, username);
    this.broadcast({ type: 'presence', members: this.memberList(members) });
    await this.publishDirectory(meta, members);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== 'string' || message.length > MAX_FRAME_LENGTH) {
      socket.close(1009, 'Invalid or oversized frame');
      return;
    }

    let frame;
    try {
      frame = JSON.parse(message);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.type !== 'string') {
        throw new Error('Invalid frame');
      }
    } catch {
      socket.close(1007, 'Invalid JSON frame');
      return;
    }

    const attachment = this.attachmentOf(socket);
    const username = normalizeUsername(attachment.username);

    if (frame.type === 'presence') {
      await this.updatePresence(socket, frame.status);
      return;
    }

    if (frame.type === 'board-message') {
      const text = normalizeGuildText(frame.text);
      if (!text) return;
      const meta = await this.meta();
      const board = await this.board();
      const msg = createGuildMessage(username, text);
      board.push(msg);
      const trimmed = board.slice(-MAX_GUILD_BOARD_ITEMS);
      const updatedMeta = { ...meta, lastActivityAt: msg.createdAt };
      await this.state.storage.put('board', trimmed);
      await this.state.storage.put('meta', updatedMeta);
      this.broadcast({ type: 'board-message', message: msg });
      await this.updatePresence(socket, attachment.status || 'online');
      await this.publishDirectory(updatedMeta);
      return;
    }

    if (frame.type === 'dm-message') {
      const to = normalizeUsername(frame.to);
      const text = normalizeGuildText(frame.text);
      if (!text || to.toLowerCase() === username.toLowerCase()) return;
      const members = await this.members();
      if (!members[to.toLowerCase()]) return;
      const allDms = await this.dms();
      const key = dmKey(username, to);
      const msg = { ...createGuildMessage(username, text), to };
      allDms[key] = [...(allDms[key] || []), msg].slice(-MAX_GUILD_DM_ITEMS);
      await this.state.storage.put('dms', allDms);
      for (const target of this.socketsFor(username)) this.send(target, { type: 'dm-message', with: to, message: msg });
      for (const target of this.socketsFor(to)) this.send(target, { type: 'dm-message', with: username, message: msg });
      await this.updatePresence(socket, attachment.status || 'online');
      return;
    }

    if (frame.type === 'dm-history') {
      const withUser = normalizeUsername(frame.with);
      const allDms = await this.dms();
      this.send(socket, {
        type: 'dm-history',
        with: withUser,
        messages: allDms[dmKey(username, withUser)] || [],
      });
      return;
    }

    if (frame.type === 'refresh') {
      await this.sendSnapshot(socket, username);
    }
  }

  async webSocketClose(socket) {
    const attachment = this.attachmentOf(socket);
    const username = normalizeUsername(attachment.username);
    if (this.socketsFor(username).length > 0) return;

    const members = await this.members();
    const key = username.toLowerCase();
    if (members[key]) {
      members[key] = { ...members[key], status: 'offline', lastSeen: Date.now() };
      await this.state.storage.put('members', members);
      this.broadcast({ type: 'presence', members: this.memberList(members) });
      await this.publishDirectory(await this.meta(), members);
    }
  }

  async webSocketError(socket) {
    socket.close(1011, 'Guild socket error');
    await this.webSocketClose(socket);
  }
}

export class GuildDirectory {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/guilds') {
      const guilds = (await this.state.storage.get('guilds')) || {};
      return Response.json({
        guilds: Object.values(guilds)
          .sort((a, b) => (b.lastActivityAt || b.createdAt) - (a.lastActivityAt || a.createdAt)),
      });
    }

    if (request.method === 'POST' && url.pathname === '/internal') {
      let payload;
      try {
        payload = await readSmallJson(request);
      } catch {
        return new Response('Invalid guild payload', { status: 400 });
      }
      const action = payload?.action;
      const guild = payload?.guild;
      if (!guild || typeof guild !== 'object' || typeof guild.id !== 'string' || !GUILD_PATTERN.test(guild.id)) {
        return new Response('Invalid guild payload', { status: 400 });
      }
      const guilds = (await this.state.storage.get('guilds')) || {};
      if (action === 'remove') {
        delete guilds[guild.id];
      } else if (action === 'upsert') {
        guilds[guild.id] = {
          id: guild.id,
          name: normalizeGuildName(guild.name),
          icon: normalizeGuildIcon(guild.icon),
          createdBy: normalizeUsername(guild.createdBy),
          createdAt: Number.isFinite(guild.createdAt) ? guild.createdAt : Date.now(),
          lastActivityAt: Number.isFinite(guild.lastActivityAt) ? guild.lastActivityAt : Date.now(),
          memberCount: Number.isFinite(guild.memberCount) ? guild.memberCount : 0,
          onlineCount: Number.isFinite(guild.onlineCount) ? guild.onlineCount : 0,
        };
      } else {
        return new Response('Invalid action', { status: 400 });
      }
      await this.state.storage.put('guilds', guilds);
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}

export class RoomDirectory {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/rooms') {
      const rooms = (await this.state.storage.get('rooms')) || {};
      const now = Date.now();
      let changed = false;
      for (const [roomId, room] of Object.entries(rooms)) {
        const expiresAt = room.expiresAt === null
          ? null
          : Number.isFinite(room.expiresAt)
            ? room.expiresAt
            : Number(room.createdAt) + IDLE_ROOM_TIMEOUT_MS;
        if (Number.isFinite(expiresAt) && expiresAt <= now) {
          delete rooms[roomId];
          changed = true;
        }
      }
      if (changed) await this.state.storage.put('rooms', rooms);
      return Response.json({
        rooms: Object.values(rooms)
          .sort((a, b) => a.createdAt - b.createdAt),
      });
    }

    if (request.method === 'POST' && url.pathname === '/internal') {
      const payload = await request.json();
      const action = payload?.action;
      const room = payload?.room;
      if (!room || typeof room !== 'object' || typeof room.roomId !== 'string' || !ROOM_PATTERN.test(room.roomId)) {
        return new Response('Invalid room payload', { status: 400 });
      }
      const rooms = (await this.state.storage.get('rooms')) || {};
      if (action === 'remove') {
        delete rooms[room.roomId];
      } else if (action === 'upsert') {
        rooms[room.roomId] = {
          roomId: room.roomId,
          label: normalizeLabel(room.label),
          hostUsername: normalizeUsername(room.hostUsername),
          createdAt: Number.isFinite(room.createdAt) ? room.createdAt : Date.now(),
          expiresAt: Number.isFinite(room.expiresAt) ? room.expiresAt : null,
        };
      } else {
        return new Response('Invalid action', { status: 400 });
      }
      await this.state.storage.put('rooms', rooms);
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }
}
