// Invitation payloads contain only an opaque room ID, never the PIN.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const INVITATION_ID = /^[A-Za-z0-9-]{1,64}$/;

export function createInvitation(id, roomId) {
  const message = { t: 'private-invite', id, roomId };
  if (!isPrivateInvitation(message)) throw new Error('Invalid invitation');
  return message;
}

export function isPrivateInvitation(message) {
  return !!message && typeof message === 'object' && !Array.isArray(message) &&
    Object.keys(message).sort().join(',') === 'id,roomId,t' &&
    message.t === 'private-invite' && typeof message.id === 'string' && INVITATION_ID.test(message.id) &&
    typeof message.roomId === 'string' && ROOM_ID.test(message.roomId);
}

export function isValidInvitePin(pin) {
  return typeof pin === 'string' && pin.trim().length >= 6 && pin.length <= 128;
}
