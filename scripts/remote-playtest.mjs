import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { getSkill } from '../src/shared/skills.ts';

const service = 'https://glass-landlord.onrender.com';
const endpoint = service.replace('https:', 'wss:') + '/ws';
const output = new URL('../artifacts/remote-playtest-report.json', import.meta.url);
const suffix = randomBytes(3).toString('hex');
const password = randomBytes(16).toString('hex');
const report = { service, startedAt: new Date().toISOString(), result: 'running', checks: [], errors: [], cleanup: false };
const clients = [];
let ownCode;

class Client {
  constructor(origin) {
    this.origin = origin;
    this.messages = [];
    this.listeners = new Set();
    this.socket = new WebSocket(endpoint, { origin, handshakeTimeout: 75000 });
    this.socket.on('error', () => {});
    this.socket.on('message', data => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      if (message.type === 'joined') this.joined = message;
      for (const listener of this.listeners) listener();
    });
    clients.push(this);
  }
  async opened() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Public WebSocket handshake timed out')), 80000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  get state() { return this.messages.slice().reverse().find(message => message.type === 'state')?.state; }
  async wait(predicate, after = 0, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error('Timed out waiting for a public room response')); }, timeout);
      const check = () => {
        const found = this.messages.slice(after).find(predicate);
        if (found) { clearTimeout(timer); this.listeners.delete(check); resolve(found); }
      };
      this.listeners.add(check); check();
    });
  }
  async act(action, statePredicate = () => true) {
    const after = this.messages.length;
    const version = this.state?.version ?? -1;
    this.send({ type: 'action', action });
    const reply = await this.wait(message => message.type === 'error' || (message.type === 'state' && message.state.version > version && statePredicate(message.state)), after);
    if (reply.type === 'error') throw new Error(reply.message);
    return reply.state;
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => { this.socket.once('close', resolve); this.socket.close(); });
  }
}

const stateWhere = predicate => message => message.type === 'state' && predicate(message.state);
function passed(check, detail) { report.checks.push({ check, passed: true, ...(detail ? { detail } : {}) }); }

try {
  const health = await fetch(service + '/health', { signal: AbortSignal.timeout(90000) });
  assert.equal(health.status, 200);
  const deployment = await health.json();
  assert.equal(deployment.ok, true);
  assert.equal(deployment.protocol, 'turn-skills-v2', 'Public deployment has not upgraded to normal-turn skills yet');
  report.deployment = { version: deployment.version, protocol: deployment.protocol };
  passed('public HTTPS health check identifies the new normal-turn skill protocol');

  const host = new Client('http://127.0.0.1:4318'); await host.opened();
  host.send({ type: 'create', name: `验收甲${suffix}`, password });
  await host.wait(message => message.type === 'joined');
  await host.wait(stateWhere(state => state.phase === 'lobby'));
  ownCode = host.joined.code;
  assert.match(ownCode, /^\d{6}$/);
  passed('desktop-origin WSS connection creates its own password room');

  const second = new Client('https://yss907732349.github.io'); await second.opened();
  second.send({ type: 'join', name: `验收乙${suffix}`, code: ownCode, password: 'intentionally-wrong-password' });
  const error = await second.wait(message => message.type === 'error');
  assert.match(error.message, /密码/);
  passed('incorrect password is rejected');
  second.send({ type: 'join', name: `验收乙${suffix}`, code: ownCode, password });
  await second.wait(message => message.type === 'joined'); await second.wait(stateWhere(() => true));
  const third = new Client('http://127.0.0.1:4318'); await third.opened();
  third.send({ type: 'join', name: `验收丙${suffix}`, code: ownCode, password });
  await third.wait(message => message.type === 'joined'); await third.wait(stateWhere(state => state.players.length === 3));
  passed('desktop and GitHub Pages origins join the same three-player room');

  const seats = [host, second, third];
  for (const client of seats) await client.act({ type: 'ready', ready: true }, state => state.players.find(player => player.id === client.joined.playerId)?.ready);
  await host.wait(stateWhere(state => state.players.length === 3 && state.players.every(player => player.ready)));
  let state = await host.act({ type: 'start' }, state => state.phase === 'bidding');
  assert.equal(state.hand.length, 17);
  assert.equal(state.bottom.length, 0);
  passed('all three ready and server deals seventeen private cards per player');
  while (state.phase === 'bidding') {
    const bidder = seats.find(client => client.joined.playerId === state.turnId);
    const current = state;
    await bidder.wait(stateWhere(view => view.version >= current.version && view.turnId === current.turnId));
    state = await bidder.act({ type: 'bid', value: bidder === host ? 3 : 0 });
  }
  for (const client of seats) await client.wait(stateWhere(view => view.phase === 'playing' && view.landlordId === host.joined.playerId));
  assert.equal(host.state.hand.length, 20);
  assert.equal(second.state.hand.length, 17);
  assert.equal(third.state.hand.length, 17);
  assert.equal(host.state.bottom.length, 3);
  passed('three-point bidding assigns the landlord and publishes three bottom cards');

  const cardSets = seats.map(client => new Set(client.state.hand.map(card => card.id)));
  for (let a = 0; a < seats.length; a++) {
    assert.equal(seats[a].state.selfId, seats[a].joined.playerId);
    assert.ok(seats[a].state.players.every(player => !('hand' in player) && !('skills' in player)));
    for (let b = a + 1; b < seats.length; b++) assert.ok([...cardSets[a]].every(id => !cardSets[b].has(id)));
  }
  assert.ok(!JSON.stringify(second.state).includes(host.state.hand.find(card => !host.state.bottom.some(bottom => bottom.id === card.id)).id));
  passed('private hands are distinct and opponent player records contain only public counts');

  const beforeBad = host.messages.length;
  host.send({ type: 'action', action: { type: 'play', cardIds: [second.state.hand[0].id] } });
  assert.match((await host.wait(message => message.type === 'error', beforeBad)).message, /牌|选/);
  passed('server rejects playing another player’s card');

  state = await host.act({ type: 'play', cardIds: [host.state.hand[0].id] }, view => !!view.currentPlay);
  for (let i = 0; i < 2; i++) {
    const current = state;
    const actor = seats.find(client => client.joined.playerId === current.turnId);
    await actor.wait(stateWhere(view => view.version >= current.version && view.turnId === current.turnId));
    state = await actor.act({ type: 'pass' });
  }
  assert.equal(state.currentPlay, null);
  assert.equal(state.phase, 'playing');
  assert.equal(state.turnId, host.joined.playerId);
  assert.equal(state.players.find(player => player.id === host.joined.playerId).skillCount, 2);
  assert.ok(state.players.filter(player => player.id !== host.joined.playerId).every(player => player.skillCount === 1));
  passed('two passes clear the table and draw two landlord skills and one per farmer');

  for (const client of seats) await client.wait(stateWhere(view => view.version >= state.version));
  const beforeWrongTurn = second.messages.length;
  second.send({ type: 'action', action: { type: 'skill', skillId: second.state.skills[0].id, targetId: host.joined.playerId } });
  assert.match((await second.wait(message => message.type === 'error', beforeWrongTurn)).message, /回合|轮到|技能/);
  passed('skills cannot be used outside the player’s normal turn');
  const drawn = host.state.skills[0];
  const definition = getSkill(drawn.kind);
  const skillState = await host.act({ type: 'skill', skillId: drawn.id, ...(definition.target ? { targetId: second.joined.playerId } : {}), ...(definition.select ? { cardIds: host.state.hand.slice(0, definition.select).map(card => card.id) } : {}) });
  assert.ok(!skillState.skills.some(skill => skill.id === drawn.id));
  assert.equal(skillState.phase, 'playing');
  assert.equal(skillState.turnId, host.joined.playerId);
  for (const client of seats) await client.wait(stateWhere(view => view.version >= skillState.version));
  passed('a drawn skill executes during the normal turn without consuming the play opportunity', { kind: drawn.kind });
  const continued = await host.act({ type: 'play', cardIds: [host.state.hand.find(card => !card.wild).id] }, view => view.currentPlay?.playerId === host.joined.playerId && view.turnId !== host.joined.playerId);
  for (const client of seats) await client.wait(stateWhere(view => view.version >= continued.version));
  passed('the skill user continues by playing a card in the same turn');
  const oldHand = second.state.hand.map(card => card.id);
  const oldSkills = second.state.skills.map(card => card.id);
  const beforeDisconnect = host.messages.length;
  await second.close();
  await host.wait(stateWhere(view => view.paused), beforeDisconnect);
  passed('public room pauses when a player disconnects');
  const resumed = new Client('https://yss907732349.github.io'); await resumed.opened();
  resumed.send({ type: 'resume', code: ownCode, token: second.joined.token });
  await resumed.wait(message => message.type === 'joined');
  await resumed.wait(stateWhere(view => !view.paused));
  assert.equal(resumed.joined.playerId, second.joined.playerId);
  assert.deepEqual(resumed.state.hand.map(card => card.id), oldHand);
  assert.deepEqual(resumed.state.skills.map(card => card.id), oldSkills);
  passed('seat token restores the same private hand and skills after reconnect');

  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.errors.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const client of clients) {
    if (!client.joined || client.joined.code !== ownCode || client.socket.readyState !== WebSocket.OPEN) continue;
    const after = client.messages.length;
    try {
      client.send({ type: 'leave' });
      await client.wait(message => message.type === 'closed', after, 4000);
      report.cleanup = true;
    } catch { /* Another test member leaving may already have closed this own test room. */ }
  }
  await Promise.all(clients.map(client => client.close()));
  report.finishedAt = new Date().toISOString();
  await mkdir(fileURLToPath(new URL('../artifacts/', import.meta.url)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
