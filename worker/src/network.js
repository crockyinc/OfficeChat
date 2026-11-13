// Normalize addresses as seen at the trusted Cloudflare edge. IPv4 uses the
// exact public address; IPv6 uses the conventional /64 subnet, because devices
// on the same LAN normally have different globally routable IPv6 addresses.
function ipv4Parts(input) {
  const parts = input.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

export function normalizeNetworkAddress(address) {
  if (typeof address !== 'string') return null;
  let ip = address.trim().toLowerCase();
  const v4 = ipv4Parts(ip);
  if (v4) return v4.join('.');
  if (!ip.includes(':') || /[^0-9a-f:.]/.test(ip)) return null;
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    const tail = ipv4Parts(ip.slice(lastColon + 1));
    if (!tail) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  if ((ip.match(/::/g) || []).length > 1) return null;
  const compressed = ip.includes('::');
  const halves = ip.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = compressed && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((compressed && missing < 1) || (!compressed && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map(part => parseInt(part, 16));
  if (groups.length !== 8) return null;
  if (groups.slice(0, 5).every(n => n === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  }
  return `${groups.slice(0, 4).map(n => n.toString(16).padStart(4, '0')).join(':')}::/64`;
}
