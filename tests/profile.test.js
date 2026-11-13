import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionProfile } from '../frontend/js/profile.js';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

test('generated profile remains stable across reloads and room navigation in a tab', () => {
  const local = storage(), session = storage();
  let generated = 0;
  const name = () => `Panda ${++generated}`;
  const color = () => `color ${++generated}`;
  const first = sessionProfile(local, session, name, color);
  assert.deepEqual(sessionProfile(local, session, name, color), first);
  assert.equal(generated, 2);
  assert.notDeepEqual(sessionProfile(local, storage(), name, color), first);
});

test('saved profile choices override session defaults and persist on a new session', () => {
  const local = storage(), session = storage();
  sessionProfile(local, session, () => 'Blue Panda', () => '#aaa');
  local.setItem('cbw-name', 'Alex');
  local.setItem('cbw-color', '#123456');
  const expected = { name: 'Alex', color: '#123456' };
  assert.deepEqual(sessionProfile(local, session, () => 'unused', () => 'unused'), expected);
  assert.deepEqual(sessionProfile(local, storage(), () => 'unused', () => 'unused'), expected);
});
