import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserProfile, roomIdentity, distinctPeople, isOwnPeer } from '../frontend/js/profile.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

test('browser tabs share a generated profile and browser identity', () => {
  const local = storage();
  let generated = 0;
  const name = () => `Panda ${++generated}`;
  const color = () => `color ${++generated}`;
  const id = () => `id ${++generated}`;
  const first = browserProfile(local, storage(), name, color, id);
  assert.deepEqual(browserProfile(local, storage(), name, color, id), first);
  assert.equal(generated, 3);
  assert.notDeepEqual(browserProfile(storage(), storage(), name, color, id), first);
});

test('saved profile choices override session defaults', () => {
  const local = storage(), session = storage();
  session.setItem('cbw-session-name', 'Blue Panda');
  local.setItem('cbw-name', 'Alex'); local.setItem('cbw-color', '#123456'); local.setItem('cbw-browser-id', 'stable');
  assert.deepEqual(browserProfile(local, session, () => 'unused', () => 'unused', () => 'unused'), { name: 'Alex', color: '#123456', id: 'stable' });
});

test('room-scoped identity hides own tabs and groups a remote user with multiple tabs', async () => {
  const own = await roomIdentity('my browser', 'network-room');
  const remote = await roomIdentity('other browser', 'network-room');
  assert.notEqual(own, await roomIdentity('my browser', 'private-room'));
  const peers = [
    {id:'own-tab',identity:own,open:true},
    {id:'a',identity:remote,open:false},
    {id:'b',identity:remote,open:true},
    {id:'legacy',identity:null,open:true},
  ];
  assert.equal(isOwnPeer(peers[0], own), true);
  assert.deepEqual(distinctPeople(peers, own).map(p=>p.id), ['b','legacy']);
  assert.equal(distinctPeople(peers, own).filter(p=>p.open).length, 2);
});
