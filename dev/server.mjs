import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createServer } from 'vite';
import { SignalingCore } from '../worker/src/core.js';
import { DEFAULT_ICE_SERVERS } from '../frontend/js/ice.js';

const core = new SignalingCore();
const sockets = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/config') {
    const iceServers = [...DEFAULT_ICE_SERVERS];
    if (process.env.TURN_URLS) iceServers.push({ urls: process.env.TURN_URLS, username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ iceServers }));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server, path: '/signal', maxPayload: 8192 });
function run(actions) { for (const a of actions) { const ws = sockets.get(a.close || a.to); if (!ws) continue; if (a.close) ws.close(a.code, a.reason); else if (ws.readyState === 1) ws.send(JSON.stringify(a.msg)); } }
wss.on('connection', (ws, req) => {
  const id = crypto.randomUUID(); sockets.set(id, ws); core.connect(id);
  // Local dev is behind Vite. Do not use this proxy setup as a public production server.
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'local';
  let queue = Promise.resolve();
  ws.on('message', (data, binary) => { queue = queue.then(async () => run(await core.message(id, binary ? null : data.toString(), ip))).catch(() => ws.close(1011)); });
  ws.on('close', () => { sockets.delete(id); run(core.disconnect(id)); });
  ws.on('error', () => {});
});
server.listen(8787, '127.0.0.1');
const vite = await createServer(); await vite.listen(); vite.printUrls();
