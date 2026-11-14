import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerRecovery } from '../frontend/js/peer-recovery.js';
import { LocalTabs } from '../frontend/js/local-tabs.js';
import { DEFAULT_ICE_SERVERS } from '../frontend/js/ice.js';

function fakeTimers() {
  const pending=new Map();let next=0;
  return { pending, set:(fn,delay)=>{const id=++next;pending.set(id,{fn,delay});return id;}, clear:id=>pending.delete(id), fire:()=>{const [id,item]=pending.entries().next().value;pending.delete(id);item.fn();} };
}
test('failed peers restart ICE, then reconnect only if still unhealthy', () => {
  const timer=fakeTimers();let healthy=false,restarts=0,reconnects=0;
  const r=new PeerRecovery({isCurrent:()=>true,isHealthy:()=>healthy,restartIce:()=>restarts++,reconnect:()=>reconnects++,onRetry:()=>{},delay:()=>8000,setTimer:timer.set,clearTimer:timer.clear});
  r.watch();assert.equal([...timer.pending.values()][0].delay,20000);
  timer.fire();assert.equal(restarts,1);assert.equal([...timer.pending.values()][0].delay,8000);
  r.failed();assert.equal(restarts,1); // No duplicate restarts while waiting.
  timer.fire();assert.equal(reconnects,1);
  r.ready();r.failed();healthy=true;timer.fire();assert.equal(reconnects,1);
});
test('healthy, removed, or closed peers never trigger a reconnect', () => {
  const timer=fakeTimers();let current=true,reconnects=0;
  const r=new PeerRecovery({isCurrent:()=>current,isHealthy:()=>false,restartIce:()=>{},reconnect:()=>reconnects++,onRetry:()=>{},delay:()=>100,setTimer:timer.set,clearTimer:timer.clear});
  r.failed();current=false;timer.fire();assert.equal(reconnects,0);
  current=true;r.ready();r.failed();r.close();assert.equal(timer.pending.size,0);assert.equal(reconnects,0);
});
test('same-origin tabs discover each other and remove closed tab identities', () => {
  const channels=[];
  function channel() {const c={listeners:[],addEventListener(_type,fn){this.listeners.push(fn)},postMessage(data){for(const other of channels)if(other!==this)for(const fn of other.listeners)fn({data})},close(){channels.splice(channels.indexOf(this),1)}};channels.push(c);return c;}
  const found=[];
  const a=new LocalTabs('tabA',channel(),id=>found.push(id));
  const b=new LocalTabs('tabB',channel());
  assert.equal(a.has('tabB'),true);assert.equal(b.has('tabA'),true);assert.deepEqual(found,['tabB']);
  b.close();assert.equal(a.has('tabB'),false);a.close();
});
test('STUN discovery has independent defaults and no embedded TURN credentials', () => {
  assert.ok(DEFAULT_ICE_SERVERS.length >= 2);
  for(const server of DEFAULT_ICE_SERVERS){assert.match(server.urls,/^stun:/);assert.equal('credential' in server,false);}
});

test('worker exposes the shared STUN defaults and optional configured TURN', async () => {
  const { default: worker } = await import('../worker/src/index.js');
  const request = new Request('https://example.com/config');
  const withoutTurn = await (await worker.fetch(request, {})).json();
  assert.deepEqual(withoutTurn.iceServers, DEFAULT_ICE_SERVERS);
  const withTurn = await (await worker.fetch(request, {TURN_URLS:'turns:example.test:443?transport=tcp',TURN_USERNAME:'user',TURN_CREDENTIAL:'temporary'})).json();
  assert.equal(withTurn.iceServers.at(-1).urls, 'turns:example.test:443?transport=tcp');
  assert.equal(withTurn.iceServers.at(-1).credential, 'temporary');
});
