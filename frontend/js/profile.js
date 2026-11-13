// Tabs in the same browser profile share one local identity and profile.
// The identity sent to peers is scoped to the room, never sent to signaling.
export function browserProfile(local, session, generateName, generateColor, generateId) {
  const name = local.getItem('cbw-name') || session.getItem('cbw-session-name') || generateName();
  const color = local.getItem('cbw-color') || session.getItem('cbw-session-color') || generateColor();
  const id = local.getItem('cbw-browser-id') || generateId();
  local.setItem('cbw-name', name);
  local.setItem('cbw-color', color);
  local.setItem('cbw-browser-id', id);
  session.setItem('cbw-session-name', name);
  session.setItem('cbw-session-color', color);
  return { name, color, id };
}

export async function roomIdentity(browserId, roomId) {
  const bytes = new TextEncoder().encode(`chatbywifi-presence-v1:${roomId}:${browserId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isOwnPeer(peer, identity) {
  return !!identity && peer.identity === identity;
}

// Older clients without a presence identity remain separate peers.
export function distinctPeople(peers, identity) {
  const grouped = new Map();
  for (const peer of peers) {
    if (isOwnPeer(peer, identity)) continue;
    const group = peer.identity ? `identity:${peer.identity}` : `peer:${peer.id}`;
    const previous = grouped.get(group);
    if (!previous || (!previous.open && peer.open)) grouped.set(group, peer);
  }
  return [...grouped.values()];
}
