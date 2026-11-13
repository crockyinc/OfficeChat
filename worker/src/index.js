// ChatByWiFi signaling Worker.
//
// A Cloudflare Worker + Durable Object that only helps browsers find
// each other and exchange WebRTC offers/answers/ICE candidates.
//
// HARD GUARANTEES:
//   - No D1 / R2 / KV / any storage binding. State is plain in-memory
//     Maps inside the Durable Object. Nothing survives a restart and
//     nothing is written to disk.
//   - The Worker never sees chat text or image bytes: those travel
//     directly between browsers over RTCDataChannels (DTLS-encrypted).
//   - Message payloads are never logged. Logs contain only counts.

import { SignalingCore, deriveNetworkRoomId } from './core.js';
import { DEFAULT_ICE_SERVERS } from '../../frontend/js/ice.js';

export class SignalingRoom {
  constructor() {
    this.core = new SignalingCore();
    /** connId -> WebSocket */
    this.sockets = new Map();
    this.nextConnId = 1;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('ChatByWiFi signaling: WebSocket only.', {
        status: 426,
      });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connId = `c${this.nextConnId++}`;
    this.sockets.set(connId, server);
    this.core.connect(connId);
    server.accept();
    const trustedNetworkRoomId = request.headers.get('X-ChatByWiFi-Network-Room');
    let queue = Promise.resolve();
    server.addEventListener('message', async (event) => {
      queue = queue.then(async () => {
        const actions = await this.core.message(connId, event.data, null, { trustedNetworkRoomId, requireTrustedNetworkRoom: true });
        this.#run(actions);
      }).catch(() => { try { server.close(1011, 'signaling error'); } catch {} });
    });
    server.addEventListener('close', (event) => {
      try { server.close(event.code, event.reason); } catch {}
      this.sockets.delete(connId);
      this.#run(this.core.disconnect(connId));
    });
    server.addEventListener('error', () => {
      this.sockets.delete(connId);
      this.#run(this.core.disconnect(connId));
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  #run(actions) {
    for (const action of actions) {
      if (action.close) {
        try {
          this.sockets.get(action.close)?.close(action.code, action.reason);
        } catch {
          /* already closed */
        }
        continue;
      }
      const ws = this.sockets.get(action.to);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(action.msg));
      }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'chatbywifi-signaling' });
    }

    // Client config: STUN is always public; TURN is optional and only
    // used when direct P2P fails. TURN relays DTLS-encrypted traffic
    // only — it cannot read message contents.
    if (url.pathname === '/config') {
      const config = {
        iceServers: [...DEFAULT_ICE_SERVERS],
      };
      if (env.TURN_URLS) {
        config.iceServers.push({
          urls: env.TURN_URLS,
          username: env.TURN_USERNAME ?? '',
          credential: env.TURN_CREDENTIAL ?? '',
        });
      }
      return Response.json(config, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/signal') {
      // Read the visitor's trusted IP at the edge, before forwarding the
      // request into the Durable Object. Never accept a client-supplied room.
      const headers = new Headers(request.headers);
      headers.delete('X-ChatByWiFi-Network-Room');
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip) {
        try { headers.set('X-ChatByWiFi-Network-Room', await deriveNetworkRoomId(ip)); }
        catch { /* Private rooms still work if the edge IP is unavailable. */ }
      }
      const stub = env.SIGNALING.get(env.SIGNALING.idFromName('chatbywifi'));
      return stub.fetch(new Request(request, { headers }));
    }

    return new Response('ChatByWiFi signaling service.', { status: 404 });
  },
};
