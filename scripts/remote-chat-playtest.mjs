import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { QUICK_CHATS } from '../src/shared/chat.ts';

// Optional address supports a local verification run; public servers must use HTTPS.
const serviceUrl = new URL(process.env.ROOM_SERVER || process.argv[2] || 'https://glass-landlord.onrender.com');
if (serviceUrl.username || serviceUrl.password || serviceUrl.search || serviceUrl.hash || !['https:', 'http:'].includes(serviceUrl.protocol) || (serviceUrl.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(serviceUrl.hostname))) throw new Error('Use an HTTPS service URL, or HTTP on loopback for a local test.');
const service = serviceUrl.origin;
const endpoint = service.replace(/^http/, 'ws') + '/ws';
const report = { service, startedAt: new Date().toISOString(), result: 'running', checks: [], errors: [], cleanup: false };
const clients = [], suffix = randomBytes(3).toString('hex'), password = randomBytes(16).toString('hex');
const sentAt = new Map();
let ownCode;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const stateWhere = predicate => message => message.type === 'state' && predicate(message.state);
const progress = state => ({ phase: state.phase, turnId: state.turnId, landlordId: state.landlordId, hand: state.hand, skills: state.skills, currentPlay: state.currentPlay, passCount: state.passCount, direction: state.direction, deadline: state.deadline, paused: state.paused });

class Client {
  constructor(origin) {
    this.socket = new WebSocket(endpoint, { origin, handshakeTimeout: 75_000 });
    this.messages = []; this.listeners = new Set();
    this.socket.on('error', () => {});
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); this.messages.push(message);
      if (message.type === 'joined') this.joined = message;
      for (const listener of this.listeners) listener();
    });
    clients.push(this);
  }
  async opened() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WSS handshake timed out')), 80_000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }
  send(message) { this.socket.send(JSON.stringify(message)); }
  get state() { return this.messages.slice().reverse().find(message => message.type === 'state')?.state; }
  wait(predicate, after = 0, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.listeners.delete(check); reject(new Error('Timed out waiting for a room response')); }, timeout);
      const check = () => {
        const message = this.messages.slice(after).find(predicate);
        if (message) { clearTimeout(timer); this.listeners.delete(check); resolve(message); }
      };
      this.listeners.add(check); check();
    });
  }
  async act(action) {
    const after = this.messages.length, version = this.state?.version ?? -1;
    this.send({ type: 'action', action });
    const message = await this.wait(item => item.type === 'error' || (item.type === 'state' && item.state.version > version), after);
    if (message.type === 'error') throw new Error(message.message);
    return message.state;
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.socket.terminate(); resolve(); }, 3000);
      this.socket.once('close', () => { clearTimeout(timer); resolve(); });
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate(); else this.socket.close();
    });
  }
}

async function allAtLeast(seats, version) {
  await Promise.all(seats.map(client => client.wait(stateWhere(state => state.version >= version))));
}
async function say(sender, phraseId, receivers) {
  const before = receivers.map(client => progress(client.state));
  const offsets = receivers.map(client => client.messages.length);
  const state = await sender.act({ type: 'chat', phraseId });
  const event = state.events.at(-1);
  assert.equal(event.type, 'chat'); assert.equal(event.actorId, sender.joined.playerId); assert.equal(event.phraseId, phraseId);
  assert.deepEqual(Object.keys(event).sort(), ['actorId', 'at', 'id', 'phraseId', 'type']);
  for (const [index, client] of receivers.entries()) {
    const message = await client.wait(stateWhere(view => view.events.some(item => item.id === event.id)), offsets[index]);
    assert.deepEqual(progress(message.state), before[index], 'chat changed gameplay progress');
    assert.deepEqual(message.state.events.find(item => item.id === event.id), event);
  }
  sentAt.set(sender, Date.now());
  report.checks.push({ check: 'fixed phrase broadcast without changing gameplay', phraseId, phrase: QUICK_CHATS[phraseId] });
}

try {
  const response = await fetch(service + '/health', { signal: AbortSignal.timeout(90_000) });
  assert.equal(response.status, 200);
  const health = await response.json();
  report.deployment = { version: health.version, protocol: health.protocol, capabilities: health.capabilities || [] };
  if (!health.capabilities?.includes('quick-chat')) {
    report.result = 'not-ready'; process.exitCode = 2;
    report.errors.push('The service has not deployed quick-chat capability yet; no test room was created.');
  } else {
    assert.equal(health.protocol, 'turn-skills-v2');
    const host = new Client('http://127.0.0.1:4318'); await host.opened();
    host.send({ type: 'create', name: `聊天验收甲${suffix}`, password });
    await host.wait(message => message.type === 'joined'); await host.wait(stateWhere(state => state.phase === 'lobby'));
    ownCode = host.joined.code;
    const second = new Client('https://yss907732349.github.io'); await second.opened();
    second.send({ type: 'join', code: ownCode, name: `聊天验收乙${suffix}`, password });
    await second.wait(message => message.type === 'joined'); await second.wait(stateWhere(() => true));
    const third = new Client('http://127.0.0.1:4318'); await third.opened();
    third.send({ type: 'join', code: ownCode, name: `聊天验收丙${suffix}`, password });
    await third.wait(message => message.type === 'joined'); await third.wait(stateWhere(state => state.players.length === 3));
    const seats = [host, second, third];
    await allAtLeast(seats, third.state.version);
    assert.ok(seats.every(client => client.state.capabilities?.includes('quick-chat')));
    report.checks.push({ check: 'desktop and GitHub Pages origins joined an isolated password room' });
    await say(host, 0, seats);
    const baseline = host.state.version;
    let after = host.messages.length;
    host.send({ type: 'action', action: { type: 'chat', phraseId: 1 } });
    assert.match((await host.wait(message => message.type === 'error', after)).message, /3秒|稍等/);
    assert.equal(host.state.version, baseline);
    for (const action of [{ type: 'chat', phraseId: 5 }, { type: 'chat', phraseId: 0, actorId: second.joined.playerId }, { type: 'chat', phraseId: 0, text: 'not a permitted phrase' }]) {
      after = host.messages.length; host.send({ type: 'action', action });
      assert.match((await host.wait(message => message.type === 'error', after)).message, /快捷聊天/);
      assert.equal(host.state.version, baseline);
    }
    report.checks.push({ check: 'cooldown, invalid phrase, arbitrary text and forged actor are rejected without state changes' });

    for (const client of seats) {
      const ready = await client.act({ type: 'ready', ready: true }); await allAtLeast(seats, ready.version);
    }
    let state = await host.act({ type: 'start' }); await allAtLeast(seats, state.version);
    const bidder = seats.find(client => client.joined.playerId === state.turnId);
    state = await bidder.act({ type: 'bid', value: 3 }); await allAtLeast(seats, state.version);
    const leader = seats.find(client => client.joined.playerId === state.turnId);
    state = await leader.act({ type: 'play', cardIds: [leader.state.hand[0].id] }); await allAtLeast(seats, state.version);
    for (let i = 0; i < 2; i++) {
      const actor = seats.find(client => client.joined.playerId === state.turnId);
      state = await actor.act({ type: 'pass' }); await allAtLeast(seats, state.version);
    }
    assert.equal(state.phase, 'playing'); assert.ok(seats.every(client => client.state.skills.length >= 1));
    await say(second, 1, seats); await say(third, 2, seats);
    const readyAt = Math.max(sentAt.get(host), sentAt.get(second)) + 3100;
    await sleep(Math.max(0, readyAt - Date.now()));
    await say(host, 3, seats); await say(second, 4, seats);
    report.checks.push({ check: 'all five phrases worked with stored skills during ordinary play, including off-turn senders' });
    const offsets = [host.messages.length, second.messages.length];
    await third.close();
    await Promise.all([host, second].map((client, index) => client.wait(stateWhere(view => view.paused), offsets[index])));
    await sleep(Math.max(0, sentAt.get(host) + 3100 - Date.now()));
    await say(host, 0, [host, second]);
    assert.equal(host.state.paused, true); assert.equal(host.state.deadline, null);
    report.checks.push({ check: 'connected players can chat while another seat is disconnected and the game remains paused' });
    report.result = 'passed';
  }
} catch (error) {
  report.result = 'failed'; report.errors.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally {
  for (const client of clients) {
    if (!ownCode || client.joined?.code !== ownCode || client.socket.readyState !== WebSocket.OPEN) continue;
    try {
      const after = client.messages.length; client.send({ type: 'leave' });
      await client.wait(message => message.type === 'closed', after, 4000); report.cleanup = true;
    } catch { /* The first leave closes this test's active room for all its seats. */ }
  }
  await Promise.all(clients.map(client => client.close()));
  report.finishedAt = new Date().toISOString();
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/remote-chat-playtest-report.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
