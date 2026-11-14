// Multiple independent STUN endpoints improve discovery if one is blocked.
// TURN is deliberately not included: it must be configured by the operator.
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
