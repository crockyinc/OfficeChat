// Optional room-PIN encryption (AES-GCM 256, PBKDF2 key derivation).
//
// When a PIN is set, every DataChannel payload is encrypted with a key
// derived from the PIN. Peers verify each other by decrypting an
// encrypted "hello" after the channel opens — a wrong PIN fails to
// decrypt and the peer is dropped. The signaling server never sees the
// PIN, the key, or any plaintext.
//
// Without a PIN, payloads travel as plain JSON over the DataChannel,
// which WebRTC still encrypts with DTLS (SRTP/DTLS-SRTP transport).

const PBKDF2_ITERATIONS = 100_000;

function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { b64encode, b64decode };

/** Derive an AES-GCM key from a room PIN. Salt is bound to the room id. */
export async function derivePinKey(pin, roomId) {
  const enc = new TextEncoder();
  const salt = await crypto.subtle.digest('SHA-256', enc.encode(`chatbywifi:${roomId}`));
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap a payload for transport. With a key: {enc:1, iv, data} (base64).
 * Without: the payload object itself (sent as JSON).
 */
export async function seal(key, payload) {
  if (!key) return payload;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { enc: 1, iv: b64encode(iv), data: b64encode(new Uint8Array(ciphertext)) };
}

/**
 * Unwrap a received payload. Throws if decryption fails (wrong PIN).
 * Returns the payload object, or null for malformed input.
 */
export async function unseal(key, wire) {
  if (!wire || typeof wire !== 'object') return null;
  if (!wire.enc) { if (key) throw new Error('pin-required'); return wire; }
  if (!key) throw new Error('pin-required');
  const iv = b64decode(wire.iv);
  const data = b64decode(wire.data);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** Generate a random 128-bit private room id (base64url, 22 chars). */
export function generateRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomPeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
