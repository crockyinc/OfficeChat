import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { normalizeNetworkAddress } from '../worker/src/network.js';
import { deriveNetworkRoomId, SignalingCore } from '../worker/src/core.js';

test('network normalization handles IPv4, IPv4-mapped IPv6, and common IPv6 LAN addresses', async () => {
  assert.equal(normalizeNetworkAddress('192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeNetworkAddress('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeNetworkAddress('2001:db8:1:2::1'), '2001:0db8:0001:0002::/64');
  assert.equal(await deriveNetworkRoomId('2001:db8:1:2::1'), await deriveNetworkRoomId('2001:0db8:0001:0002:1234:5678:abcd:ef01'));
  assert.notEqual(await deriveNetworkRoomId('2001:db8:1:2::1'), await deriveNetworkRoomId('2001:db8:1:3::1'));
  for (const invalid of ['unknown', '256.1.2.3', '::1::2', '2001:db8', '', '2001:::1']) assert.equal(normalizeNetworkAddress(invalid), null);
});

test('worker computes trusted network identity before DO forwarding and strips client spoofing', async () => {
  let forwarded;
  const env = { SIGNALING: { idFromName: () => 'id', get: () => ({ fetch: request => { forwarded = request; return new Response('ok'); } }) } };
  await worker.fetch(new Request('https://example.com/signal', { headers: { 'CF-Connecting-IP':'192.0.2.1', 'X-ChatByWiFi-Network-Room':'net-0000000000000000' } }), env);
  assert.equal(forwarded.headers.get('X-ChatByWiFi-Network-Room'), await deriveNetworkRoomId('192.0.2.1'));
  await worker.fetch(new Request('https://example.com/signal', { headers: { 'X-ChatByWiFi-Network-Room':'net-0000000000000000', 'X-Forwarded-For':'192.0.2.1' } }), env);
  assert.equal(forwarded.headers.get('X-ChatByWiFi-Network-Room'), null);
});

test('trusted network identity groups peers and fails closed without edge IP, while private rooms still work', async () => {
  const core = new SignalingCore();
  for (const id of ['a','b','c','d']) core.connect(id);
  const trustedNetworkRoomId = await deriveNetworkRoomId('2001:db8:1:2::1');
  const join = peerId => JSON.stringify({type:'join',mode:'network',peerId});
  await core.message('a', join('a'), null, {trustedNetworkRoomId,requireTrustedNetworkRoom:true});
  const actions = await core.message('b', join('b'), null, {trustedNetworkRoomId,requireTrustedNetworkRoom:true});
  assert.equal(actions.at(-1).msg.list[0].peerId, 'a');
  assert.equal((await core.message('c', join('c'), null, {requireTrustedNetworkRoom:true}))[0].msg.code,'network-ip-unavailable');
  assert.equal((await core.message('d', JSON.stringify({type:'join',mode:'private',peerId:'d',roomId:'abcdefghijklmnopqrstuv'}),null,{requireTrustedNetworkRoom:true}))[0].msg.roomKind,'private');
});
