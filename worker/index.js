const MAX_FRAME_LENGTH = 16 * 1024;
const IDLE_ROOM_TIMEOUT_MS = 2 * 60 * 1000;
const ROOM_PATTERN = /^[A-Z0-9]{10}$/;
const ROOM_DIRECTORY_KEY = 'global-room-directory';

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
