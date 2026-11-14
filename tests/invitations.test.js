import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvitation, isPrivateInvitation, isValidInvitePin } from '../frontend/js/invitations.js';
import { generateRoomId, derivePinKey, seal, unseal } from '../frontend/js/crypto.js';

test('private invitations contain only an opaque room and an identifier, never the PIN', () => {
  const roomId = generateRoomId();
  const invite = createInvitation(crypto.randomUUID(), roomId);
  assert.deepEqual(Object.keys(invite).sort(), ['id', 'roomId', 't']);
  assert.equal(isPrivateInvitation(invite), true);
  assert.equal(isPrivateInvitation({ ...invite, pin: 'secret-pin' }), false);
  assert.equal(isPrivateInvitation({ ...invite, roomId: '/r/malicious' }), false);
  assert.equal(isPrivateInvitation({ ...invite, id: '' }), false);
  assert.throws(() => createInvitation('id', '../other-room'));
});

test('inviter and recipient require the same valid PIN for private messages', async () => {
  const roomId = generateRoomId();
  const invite = createInvitation(crypto.randomUUID(), roomId);
  assert.equal(isValidInvitePin('  '), false);
  assert.equal(isValidInvitePin('12345'), false);
  assert.equal(isValidInvitePin('correct horse battery staple'), true);
  assert.equal(isValidInvitePin('x'.repeat(129)), false);
  const sender = await derivePinKey('correct horse battery staple', roomId);
  const receiver = await derivePinKey('correct horse battery staple', invite.roomId);
  const wrong = await derivePinKey('wrong PIN', invite.roomId);
  const wire = await seal(sender, { t: 'hello', name: 'Alice' });
  assert.deepEqual(await unseal(receiver, wire), { t: 'hello', name: 'Alice' });
  await assert.rejects(unseal(wrong, wire));
});
