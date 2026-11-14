import { normalizeNetworkAddress } from './network.js';

// Pure, runtime-agnostic signaling core for ChatByWiFi.
//
// This module contains ALL signaling logic but knows nothing about
// Cloudflare Workers, WebSockets, or storage. The Worker (index.js) and
// the local dev server (dev/server.mjs) are thin adapters that feed it
// raw messages and execute the actions it returns.
//
// Privacy guarantees enforced here:
//   - The server only ever sees small control messages (join / signal /
//     leave). Chat text and image bytes travel peer-to-peer over WebRTC
//     DataChannels and never reach this code.
//   - State lives in plain Maps in memory. Nothing is persisted; when a
//     room empties it is deleted, and when the process restarts all
//     rooms are gone.
//   - Message payloads are never logged. Only counts (room size) are
//     observable, and only via the caller's own metrics.

export const MAX_PEERS_PER_ROOM = 8;
export const MAX_SIGNAL_BYTES = 8192; // max size of one signaling message
export const MAX_NAME_LEN = 40;
export const MAX_PEER_ID_LEN = 64;
export const RATE_LIMIT_PER_SEC = 30; // sustained per connection
export const RATE_LIMIT_BURST = 60; // token bucket capacity

const PEER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Private rooms: 128 bits of randomness, base64url-encoded (22 chars).
const PRIVATE_ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
// Network rooms: derived server-side from a hash of the public IP.
const NETWORK_ROOM_RE = /^net-[0-9a-f]{16}$/;

export function isValidPeerId(id) {
  return typeof id === 'string' && PEER_ID_RE.test(id);
}

export function isValidRoomId(id) {
  return (
    typeof id === 'string' && (PRIVATE_ROOM_RE.test(id) || NETWORK_ROOM_RE.test(id))
  );
}

export function isValidName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= MAX_NAME_LEN;
}

/**
 * Derive the Network Room id from a client's public IP.
 * Same IPv4 address or IPv6 /64 -> same room. The IP is never stored or logged;
 * only the first 16 hex chars of SHA-256(ip + salt) are used.
 */
export async function deriveNetworkRoomId(ip, salt = 'chatbywifi-v1') {
  const address = normalizeNetworkAddress(ip);
  if (!address) throw new Error('Invalid client IP');
  const data = new TextEncoder().encode(`${salt}:${address}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `net-${hex.slice(0, 16)}`;
}


export class SignalingCore {
  constructor() {
    /** roomId -> Map<peerId, connId> */
    this.rooms = new Map();
    /** connId -> { roomId, peerId, name, tokens, windowStart } */
    this.conns = new Map();
  }

  /** Register a new connection. Returns actions (usually none). */
  connect(connId) {
    this.conns.set(connId, {
      roomId: null,
      peerId: null,
      name: null,
      tokens: RATE_LIMIT_BURST,
      windowStart: Date.now(),
    });
    return [];
  }

  /**
   * Handle one raw message from a connection.
   * @param {string} connId
   * @param {string} raw raw text frame
   * @param {string} ip client IP (used only for network-room derivation)
   * @returns {Array<{to: string, msg: object} | {close: string, code?: number, reason?: string}>}
   */
  async message(connId, raw, ip, options = {}) {
    const conn = this.conns.get(connId);
    if (!conn) return [];

    // Size limit: signaling messages are tiny by design (SDP/ICE only).
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > MAX_SIGNAL_BYTES) {
      return [{ close: connId, code: 1009, reason: 'message too large' }];
    }

    // Rate limit: token bucket, refilled continuously.
    if (!this.#consumeToken(conn)) {
      return [{ close: connId, code: 1008, reason: 'rate limited' }];
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return [{ to: connId, msg: { type: 'error', code: 'bad-json' } }];
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return [{ to: connId, msg: { type: 'error', code: 'bad-message' } }];
    }

    switch (msg.type) {
      case 'join':
        return this.#join(connId, conn, msg, ip, options);
      case 'signal':
        return this.#signal(connId, conn, msg);
      case 'leave':
        return this.#leave(connId, conn);
      default:
        return [{ to: connId, msg: { type: 'error', code: 'unknown-type' } }];
    }
  }

  /** Handle a socket close. Returns peer-left actions for roommates. */
  disconnect(connId) {
    const conn = this.conns.get(connId);
    if (!conn) return [];
    const actions = this.#leave(connId, conn);
    this.conns.delete(connId);
    return actions;
  }

  #consumeToken(conn) {
    const now = Date.now();
    const elapsed = (now - conn.windowStart) / 1000;
    conn.tokens = Math.min(
      RATE_LIMIT_BURST,
      conn.tokens + elapsed * RATE_LIMIT_PER_SEC,
    );
    conn.windowStart = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  async #join(connId, conn, msg, ip, options) {
    if (conn.roomId) {
      return [{ to: connId, msg: { type: 'error', code: 'already-joined' } }];
    }
    if (!isValidPeerId(msg.peerId)) {
      return [{ to: connId, msg: { type: 'error', code: 'bad-peer-id' } }];
    }
    // Name is optional: with a room PIN, clients send a random pseudonym
    // over signaling and exchange their real name over the encrypted
    // DataChannel, so the server never sees it.
    const name =
      typeof msg.name === 'string' && msg.name.length > 0
        ? msg.name.slice(0, MAX_NAME_LEN)
        : `Guest-${msg.peerId.slice(0, 4)}`;

    let roomId;
    let roomKind;
    if (msg.mode === 'network' || !msg.roomId) {
      if (options.trustedNetworkRoomId && NETWORK_ROOM_RE.test(options.trustedNetworkRoomId)) {
        roomId = options.trustedNetworkRoomId;
      } else if (options.requireTrustedNetworkRoom) {
        return [{ to: connId, msg: { type: 'error', code: 'network-ip-unavailable' } }];
      } else {
        try { roomId = await deriveNetworkRoomId(ip); }
        catch { return [{ to: connId, msg: { type: 'error', code: 'network-ip-unavailable' } }]; }
        if (this.conns.get(connId) !== conn) return [];
      }
      roomKind = 'network';
    } else {
      if (!PRIVATE_ROOM_RE.test(msg.roomId)) {
        return [{ to: connId, msg: { type: 'error', code: 'bad-room-id' } }];
      }
      roomId = msg.roomId;
      roomKind = roomId.startsWith('net-') ? 'network' : 'private';
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    if (room.size >= MAX_PEERS_PER_ROOM) {
      return [{ to: connId, msg: { type: 'error', code: 'room-full' } }];
    }
    if (room.has(msg.peerId)) {
      return [{ to: connId, msg: { type: 'error', code: 'duplicate-peer' } }];
    }

    const actions = [];
    // Tell existing members about the newcomer.
    for (const [, otherConnId] of room) {
      actions.push({
        to: otherConnId,
        msg: { type: 'peer-joined', peer: { peerId: msg.peerId, name } },
      });
    }
    room.set(msg.peerId, connId);
    conn.roomId = roomId;
    conn.peerId = msg.peerId;
    conn.name = name;

    const peers = [...room.entries()]
      .filter(([pid]) => pid !== msg.peerId)
      .map(([pid, cid]) => ({ peerId: pid, name: this.conns.get(cid)?.name ?? 'Guest' }));

    actions.push({
      to: connId,
      msg: { type: 'peers', list: peers, roomId, roomKind },
    });
    return actions;
  }

  #signal(connId, conn, msg) {
    if (!conn.roomId) {
      return [{ to: connId, msg: { type: 'error', code: 'not-joined' } }];
    }
    if (!isValidPeerId(msg.to) || msg.to === conn.peerId) {
      return [{ to: connId, msg: { type: 'error', code: 'bad-target' } }];
    }
    // Only forward WebRTC signaling payloads (offer/answer/ice).
    const data = msg.data;
    if (
      !data ||
      typeof data !== 'object' ||
      !['offer', 'answer', 'ice', 'encrypted'].includes(data.type) ||
      (data.type === 'encrypted' && (typeof data.iv !== 'string' || typeof data.data !== 'string' || Object.keys(data).sort().join(',') !== 'data,iv,type')) ||
      (data.type !== 'encrypted' && (typeof data.value !== 'object' || data.value === null || Object.keys(data).sort().join(',') !== 'type,value')) ||
      (['offer', 'answer'].includes(data.type) && (data.value.type !== data.type || typeof data.value.sdp !== 'string' || Object.keys(data.value).some(k => !['type','sdp'].includes(k)))) ||
      (data.type === 'ice' && (typeof data.value.candidate !== 'string' || Object.keys(data.value).some(k => !['candidate','sdpMid','sdpMLineIndex','usernameFragment'].includes(k))))
    ) {
      return [{ to: connId, msg: { type: 'error', code: 'bad-signal' } }];
    }
    const room = this.rooms.get(conn.roomId);
    const targetConnId = room?.get(msg.to);
    if (!targetConnId) {
      return [{ to: connId, msg: { type: 'error', code: 'peer-gone' } }];
    }
    // Forward verbatim. The server never inspects SDP/ICE contents.
    return [{ to: targetConnId, msg: { type: 'signal', from: conn.peerId, data } }];
  }

  #leave(connId, conn) {
    if (!conn.roomId) return [];
    const room = this.rooms.get(conn.roomId);
    const actions = [];
    if (room) {
      room.delete(conn.peerId);
      for (const [, otherConnId] of room) {
        actions.push({
          to: otherConnId,
          msg: { type: 'peer-left', peerId: conn.peerId },
        });
      }
      // Forget the room entirely once it empties.
      if (room.size === 0) this.rooms.delete(conn.roomId);
    }
    conn.roomId = null;
    conn.peerId = null;
    conn.name = null;
    return actions;
  }
}
