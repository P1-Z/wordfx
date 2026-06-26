# WordFX Cloudflare relay

The messenger uses a Cloudflare Worker, one Durable Object per private room, and a second Durable Object that keeps the live public room directory. Private rooms pair one host and one guest and forward validated JSON frames; they do not persist message history. Each private room uses a Durable Object alarm to close both sockets and remove the room after neither participant has typed for two minutes. Message payloads are encrypted on each client with AES-256-GCM using a session key derived from the host-set room code, room id, and both authentication nonces, so the relay only sees ciphertext.

Guilds use the same Worker with one Durable Object per guild and a guild directory Durable Object. A guild object persists its main board, member list, presence state, and direct-message history for members of that guild. The public guild list is available at `GET /guilds`, guild creation uses `POST /guilds`, and clients connect to `wss://.../guild/<guild-id>`.

Deploy from the project directory:

```powershell
npx.cmd --yes wrangler@latest login
npx.cmd --yes wrangler@latest deploy
```

Copy the deployed `https://...workers.dev` URL into `relay-config.json`. WordFX converts it to secure WebSockets automatically. For a temporary override, set `WORDFX_CHAT_RELAY` to the Worker URL before starting WordFX.

Check the deployment with `https://...workers.dev/health`. A successful response is:

```json
{"ok":true,"service":"wordfx-chat-relay"}
```

The current clients expect `GET /rooms` for private waiting rooms and `GET /guilds` for shared guilds. If either returns `404`, the local app is newer than the deployed Worker and `wrangler deploy` needs to be run again.

Run `npm.cmd run test:relay` to test the configured deployment. To test a local `wrangler dev` instance instead, temporarily set `WORDFX_CHAT_RELAY=ws://127.0.0.1:8787` in that terminal.
