# WordFX Cloudflare relay

The messenger uses a Cloudflare Worker, one Durable Object per room, and a second Durable Object that keeps the live public room directory. The Worker only pairs one host and one guest and forwards validated JSON frames; it does not persist message history. Each room uses a Durable Object alarm to close both sockets and remove the room after neither participant has typed for two minutes. Message payloads are encrypted on each client with AES-256-GCM using a session key derived from the host-set room code, room id, and both authentication nonces, so the relay only sees ciphertext.

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

The current messenger client also expects `GET /rooms` to return the live waiting-room list. If `/rooms` returns `404`, the local app is newer than the deployed Worker and `wrangler deploy` needs to be run again.

Run `npm.cmd run test:relay` to test the configured deployment. To test a local `wrangler dev` instance instead, temporarily set `WORDFX_CHAT_RELAY=ws://127.0.0.1:8787` in that terminal.
