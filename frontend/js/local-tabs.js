// Tabs in the same browser profile can identify one another without a server
// or a WebRTC handshake. Only transient random connection IDs cross this
// same-origin channel; names, PINs, and messages are never broadcast here.
export class LocalTabs {
  constructor(peerId, channel, onDiscover = () => {}) {
    this.peerId = peerId;
    this.channel = channel;
    this.onDiscover = onDiscover;
    this.ids = new Set();
    if (!channel) return;
    channel.addEventListener('message', event => this.receive(event.data));
    channel.postMessage({ type: 'hello', peerId });
  }
  receive(message) {
    if (!message || !['hello', 'reply', 'bye'].includes(message.type) ||
        typeof message.peerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(message.peerId) || message.peerId === this.peerId) return;
    if (message.type === 'bye') { this.ids.delete(message.peerId); return; }
    if (!this.ids.has(message.peerId)) { this.ids.add(message.peerId); this.onDiscover(message.peerId); }
    if (message.type === 'hello') this.channel.postMessage({ type: 'reply', peerId: this.peerId });
  }
  has(peerId) { return this.ids.has(peerId); }
  close() {
    if (!this.channel) return;
    this.channel.postMessage({ type: 'bye', peerId: this.peerId });
    this.channel.close();
  }
}
