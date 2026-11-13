# ChatByWiFi

A small browser chat for people sharing a network, or anyone with a private room link. No accounts, database, or server-side chat history. Messages and images are sent over WebRTC DataChannels, not through the signaling service. Up to eight devices form a mesh.

## Run locally

Requires Node.js 20+ and npm.

```sh
npm install
npm run dev
# Open the address printed by Vite (normally http://localhost:5173)
npm test
npm run build
```

The development command runs Vite and an in-memory Node/WebSocket signaling adapter. Open two tabs or devices, keep both online and send a message. Same-network detection uses the IP supplied by the local proxy. For a production-like Worker, run `npm run worker:dev` separately (Wrangler builds the static assets first); configure the frontend with `VITE_SIGNAL_URL` pointing at that Worker (see below). This Node adapter is for development, not a hardened public deployment.

WebRTC, Web Crypto, clipboard, service workers, and camera-independent QR viewing require a **secure context**: use HTTPS on real devices. `localhost` is normally treated as secure, but plain HTTP on a LAN address usually is not. A proxy/HTTPS tunnel or production deployment is needed to test with a phone. On the same network, both devices must use the same public-facing site and signaling service.

### Using the app

- The network room opens automatically. Its membership is based on the public IP observed by the signaling server, not local Wi-Fi SSID. Everyone behind that public IP can enter. Different IPs, IPv4/IPv6, VPNs, carrier NATs and proxies can split or combine apparent networks.
- Select **Create private room**, then **Invite** to show the link and QR. The link has 128 random bits. A recipient can scan it using their phone's camera. Anyone with the link can join.
- Optionally set a **room PIN** under the three-dot room options in a private room. Tell each participant to enter the same PIN there and reconnect. Share the PIN separately from the link. A wrong or missing PIN cannot negotiate with a PIN-protected peer. The PIN is retained in that tab's session storage until removed or the tab session ends; changing it reloads the page and clears the current chat. PINs are not supported in network rooms.
- Attach, paste or drop a PNG, JPEG, WebP or GIF up to 10 MiB. By default large images are resized/compressed locally; GIF compression can remove animation. Choose **Send images in original quality** in options to preserve the original file. Progress tracks queued bytes, not confirmed receipt; the double tick acknowledges completed receipt. Cancel stops subsequent chunks.
- Text, image bytes, and history live only in the open tab. Reloading or closing it clears the chat. Clear chat removes visible messages locally. No history sync or IndexedDB persistence is implemented. A generated display name and avatar color stay the same during a tab session, including reloads and room changes. Explicitly saved profile choices, theme and image preference are saved in browser local storage. Other participants can copy, download, screenshot, or otherwise retain what you share.

## Deployment

### Deploy the app and signaling together on Cloudflare Workers

The Worker serves the built frontend at its root and handles `/signal`, `/config`, and `/health` on the same origin. Static assets contain only the public app shell, never chat data. From a local checkout:

```sh
npm ci
npx wrangler login
npx wrangler deploy
```

`wrangler.toml` runs `npm run build` automatically before deployment and uploads the generated `dist/` assets. Open the resulting `https://<worker>.<subdomain>.workers.dev/` URL to use the app. Set the Worker name in `wrangler.toml`, or use `npx wrangler deploy --name chat` to update an existing Worker named `chat` rather than creating a different Worker.

For a Git-connected Worker build in the Cloudflare dashboard, use **Build command** `npm ci && npm run build` and **Deploy command** `npx wrangler deploy`. The Wrangler custom build also runs during deploy; the extra build is harmless. Confirm the deployment targets your existing Worker and redeploy the latest commit. If the Worker still displays “ChatByWiFi signaling service,” it is running the old signaling-only deployment.

`wrangler.toml` binds one Durable Object class. The SQLite-class migration is required by Cloudflare to provision the class; the application **never calls Durable Object storage** and has no D1, R2, KV, or other user-data storage bindings. All rooms and sockets are in memory. Room membership is deleted when the room empties; a restart loses all state, and clients reconnect. The single live Durable Object is intentionally simple and may need a different routing design for large deployments.

Optional TURN configuration can be supplied as Worker variables or secrets (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`); for the local Node adapter they are environment variables. `TURN_URLS` is a single URL, e.g. `turn:turn.example.com:3478`. `/config` publishes these values to every client, **including the credential**: do not use privileged long-lived credentials. Use restricted or short-lived credentials and account for TURN bandwidth costs. ICE may select TURN when configured; TURN relays WebRTC's DTLS-encrypted traffic, not plaintext messages. This project does not provide a TURN server.

### Alternative: host frontend separately

Set the Worker origin at **build time**, then build and deploy `dist/` to Cloudflare Pages or another HTTPS static host:

```sh
VITE_SIGNAL_URL=https://YOUR-WORKER.workers.dev npm run build
# deploy dist/ with your preferred static host / Pages
```

The Worker supplies CORS for `/config`; WebSocket connections use its `/signal` endpoint. The configured signaling origin must accept WebSocket upgrades. A same-origin reverse proxy exposing `/config` and `/signal` also works; in that case omit `VITE_SIGNAL_URL`. Configure your static host to serve `index.html` for `/r/<id>`; Cloudflare Workers' single-page-application fallback handles this automatically. Make sure HTTPS and secure WebSockets are enabled. Never put a private PIN in the URL.

The included CSP forbids inline scripts and external scripts. `connect-src` permits HTTPS/WebSocket origins to allow configurable signaling; for a fixed production deployment restrict it to `'self'` and your exact signaling origin. Configure server-side security headers as appropriate. The service worker caches the built app shell for offline launch, but chat and room discovery require network connectivity and other peers.

## How it works

```text
   Browser A                    Signaling Worker + Durable Object             Browser B
   join / encrypted offer  ───►  in-memory room, no storage  ─────────────►  join / answer
   ICE candidates          ◄───  small control frames only  ◄─────────────►  ICE candidates
       │                                                                          │
       └──────────── WebRTC DataChannel (DTLS; optional PIN AES-GCM) ──────────────┘
                        text, acknowledgments, image chunks
```

1. The Worker derives network room IDs from a SHA-256 hash of the client IP; private IDs are generated by `crypto.getRandomValues`. It forwards bounded signaling frames only within a room. It rate-limits connections, rejects oversized frames, and forgets empty rooms. The bundled client does not send messages or image data through signaling. As with any public signaling API, a malicious client could try to encode arbitrary data into an allowed control frame; deploy additional network/abuse controls as needed.
2. One connection per peer forms a mesh. Text and chunked image transfers use ordered DataChannels; image sending waits for the browser's buffered amount to drain. A tick means locally queued, double ticks mean at least one peer acknowledged receipt, not that everyone read it. There is no offline delivery.
3. A private-room PIN derives an AES-256-GCM key using PBKDF2-SHA-256 (100,000 iterations, room-specific salt). SDP/ICE and DataChannel payloads are encrypted by the client when a PIN is set. PINs should be long and unpredictable: a short PIN is vulnerable to offline guessing by someone who can observe encrypted signaling. PINs are shared secrets, not identity verification or a protection against a malicious room member. Without a PIN, WebRTC still encrypts the direct channel with DTLS, but signaling is not end-to-end encrypted and a malicious signaling operator could interfere with peer authentication.

## Privacy and limitations

- The signaling server stores no messages, images, or user profiles and does not log signaling payloads. It necessarily sees room IDs, pseudonymous peer IDs, connection timing, sizes, and the public IP used to route a network room. These metadata are **not** hidden by a PIN. The hosting provider may have its own request/access logs; private room URLs can appear in static-host logs and browser history. The public IP hash is not a secret and is not a robust anonymization method.
- Both peers must be online. New joiners see no previous messages. A message sent with no connected peers stays visible locally but is not delivered later.
- Anyone sharing a network room can see its messages. Private room links are bearer secrets, not accounts or identities. Anyone with the link can join unless all peers use the same PIN.
- Direct connections may fail on restrictive networks without TURN. Browser permissions, network firewalls, VPNs, and device sleep can affect discovery and connection time. A relay may be selected if configured.
- The server validates and limits control messages, but rate limits are per connection and do not prevent all abuse. The app is not independently security-audited and does not provide forward secrecy for the optional PIN layer or guarantee anonymity.

## Project structure

- `frontend/`: static UI, WebRTC mesh, room/QR handling, encryption, image transfer, PWA shell
- `worker/src/`: Worker adapter and runtime-independent signaling core
- `dev/server.mjs`: local Vite + WebSocket development adapter
- `tests/`: Node tests for signaling, chunking, validation and PIN encryption
- `wrangler.toml`: Worker and Durable Object configuration
