import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import type { Socket } from 'node:net';
import { createGameServer, sendRoomMessage } from '../server/index.ts';
import { readyBots, runBotTurn } from '../server/bots.ts';
import { Game } from '../src/shared/game.ts';
import { classify } from '../src/shared/rules.ts';
import { getSkill } from '../src/shared/skills.ts';
import type { Card, ClientMessage, GameAction, GameView, ServerMessage } from '../src/shared/types.ts';

class Client {
  socket: WebSocket;
  messages: ServerMessage[] = [];
  listeners = new Set<() => void>();
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', data => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const listener of this.listeners) listener();
    });
  }
  async opened() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
  }
  send(message: ClientMessage) { this.socket.send(JSON.stringify(message)); }
  async receive<T extends ServerMessage>(predicate: (message: ServerMessage) => message is T, after = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => { this.listeners.delete(check); reject(new Error('Timed out waiting for message: ' + JSON.stringify(this.messages.slice(-2)))); }, 6000);
      const check = () => {
        const message = this.messages.slice(after).find(predicate);
        if (message) { clearTimeout(timeout); this.listeners.delete(check); resolve(message); }
      };
      this.listeners.add(check); check();
    });
  }
  get state(): GameView {
    const message = this.messages.slice().reverse().find(message => message.type === 'state');
    if (!message || message.type !== 'state') throw new Error('State not received');
    return message.state;
  }
  async act(action: GameAction) {
    const before = this.messages.length;
    this.send({ type: 'action', action });
    const message = await this.receive((item): item is Extract<ServerMessage, { type: 'state' | 'error' }> => item.type === 'state' || item.type === 'error', before);
    if (message.type === 'error') throw new Error(message.message);
    return message.state;
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { this.socket.once('close', () => resolve()); this.socket.close(); });
  }
}

const isJoined = (item: ServerMessage): item is Extract<ServerMessage, { type: 'joined' }> => item.type === 'joined';
const isState = (item: ServerMessage): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state';
const isError = (item: ServerMessage): item is Extract<ServerMessage, { type: 'error' }> => item.type === 'error';

test('real websocket room: password, capacity, private hands, turns, skills and resume', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${app.port}/ws`;
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await app.close(); });
  const connect = async () => { const client = new Client(url); clients.push(client); await client.opened(); return client; };
  const a = await connect();
  a.send({ type: 'create', name: '房主', password: 'test-room' });
  const host = await a.receive(isJoined);
  await a.receive(isState);
  assert.match(host.code, /^\d{6}$/);
  assert.equal(host.token.length, 64);
  const b = await connect();
  b.send({ type: 'join', name: '朋友甲', code: host.code, password: 'wrong' });
  assert.match((await b.receive(isError)).message, /密码/);
  b.send({ type: 'join', name: '朋友甲', code: host.code, password: 'test-room' });
  const friend = await b.receive(isJoined);
  await b.receive(isState);
  const c = await connect();
  c.send({ type: 'join', name: '朋友乙', code: host.code, password: 'test-room' });
  await c.receive(isJoined); await c.receive(isState);
  const extra = await connect();
  extra.send({ type: 'join', name: '第四人', code: host.code, password: 'test-room' });
  assert.match((await extra.receive(isError)).message, /满/);

  for (const client of [a, b, c]) await client.act({ type: 'ready', ready: true });
  await a.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.players.length === 3 && item.state.players.every(player => player.ready));
  const started = await a.act({ type: 'start' });
  assert.equal(started.phase, 'bidding');
  assert.equal(started.hand.length, 17);
  const startCountB = b.messages.length;
  let bidding = started;
  while (bidding.phase === 'bidding') {
    const bidder = [a, b, c].find(client => client.state.selfId === bidding.turnId)!;
    await bidder.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= bidding.version && item.state.turnId === bidding.turnId);
    bidding = await bidder.act({ type: 'bid', value: bidder === a ? 3 : 0 });
  }
  const bPlaying = await b.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.phase === 'playing', startCountB);
  assert.equal(a.state.hand.length, 20);
  assert.equal(bPlaying.state.hand.length, 17);
  assert.equal(a.state.bottom.length, 3);
  assert.ok(a.state.players.every(player => !('hand' in player) && !('skills' in player)));
  assert.ok(!bPlaying.state.hand.some(card => a.state.hand.some(own => own.id === card.id)));

  const beforeInvalid = a.state.version;
  const beforeMessages = a.messages.length;
  a.send({ type: 'action', action: { type: 'play', cardIds: [b.state.hand[0].id] } });
  assert.match((await a.receive(isError, beforeMessages)).message, /牌|选/);
  assert.equal(a.state.version, beforeInvalid);
  await a.act({ type: 'play', cardIds: [a.state.hand[0].id] });
  await b.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.turnId === friend.playerId);
  await b.act({ type: 'pass' });
  const seatC = c.state.selfId;
  await c.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.turnId === seatC && item.state.passCount === 1);
  const afterPass = await c.act({ type: 'pass' });
  assert.equal(afterPass.currentPlay, null);
  assert.equal(afterPass.phase, 'playing');
  assert.equal(afterPass.turnId, host.playerId);
  assert.equal(afterPass.players.find(player => player.id === host.playerId)?.skillCount, 2);
  assert.equal(afterPass.players.find(player => player.id === friend.playerId)?.skillCount, 1);
  assert.equal(afterPass.skills.length, 1);
  for (const client of [a, b, c]) await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= afterPass.version);
  const beforeWrongTurn = b.messages.length;
  b.send({ type: 'action', action: { type: 'skill', skillId: b.state.skills[0].id, targetId: host.playerId } });
  assert.match((await b.receive(isError, beforeWrongTurn)).message, /回合|轮到|技能/);
  const drawnSkill = a.state.skills[0];
  const definition = getSkill(drawnSkill.kind);
  const used = await a.act({ type: 'skill', skillId: drawnSkill.id, ...(definition.target ? { targetId: friend.playerId } : {}), ...(definition.select ? { cardIds: a.state.hand.slice(0, definition.select).map(card => card.id) } : {}) });
  assert.equal(used.phase, 'playing');
  assert.equal(used.turnId, host.playerId);
  assert.ok(!used.skills.some(skill => skill.id === drawnSkill.id));
  assert.equal(used.skillActorId, null);
  assert.equal(used.skillBudget, 1); assert.equal(used.skillUsed, 1);
  const remainingSkill = used.skills[0]; assert.ok(remainingSkill);
  const beforeSecond = a.messages.length;
  a.send({ type: 'action', action: { type: 'skill', skillId: remainingSkill.id, targetId: friend.playerId } });
  assert.match((await a.receive(isError, beforeSecond)).message, /最多使用一张/);
  assert.equal(a.state.version, used.version); assert.deepEqual(a.state.skills, used.skills);
  const continued = await a.act({ type: 'play', cardIds: [a.state.hand.find(card => !card.wild)!.id] });
  assert.equal(continued.currentPlay?.playerId, host.playerId);
  assert.notEqual(continued.turnId, host.playerId);
  await b.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= continued.version);

  const beforeDisconnect = a.messages.length;
  await b.close();
  await a.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.paused, beforeDisconnect);
  const resumed = await connect();
  resumed.send({ type: 'resume', code: host.code, token: friend.token });
  const restored = await resumed.receive(isJoined);
  const state = (await resumed.receive(isState)).state;
  assert.equal(restored.playerId, friend.playerId);
  assert.equal(state.paused, false);
  assert.deepEqual(state.hand, b.state.hand);
  assert.deepEqual(state.skills, b.state.skills);

  const replacement = await connect();
  replacement.send({ type: 'resume', code: host.code, token: friend.token });
  await replacement.receive(isJoined); await replacement.receive(isState);
  await resumed.receive((item): item is Extract<ServerMessage, { type: 'closed' }> => item.type === 'closed');
  assert.equal(replacement.state.paused, false);
  assert.equal(replacement.state.players.find(player => player.id === friend.playerId)?.connected, true);
});

test('host can fill two bot seats, and bots take turns without seeing other hands', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  const client = new Client(`ws://127.0.0.1:${app.port}/ws`);
  t.after(async () => { await client.close(); await app.close(); });
  await client.opened();
  client.send({ type: 'create', name: '陪练玩家', password: 'practice' });
  await client.receive(isJoined); await client.receive(isState);
  const withBots = await client.act({ type: 'fillBots' });
  assert.equal(withBots.players.length, 3);
  assert.equal(withBots.players.filter(player => player.id.startsWith('bot-') && player.ready).length, 2);
  await client.act({ type: 'ready', ready: true });
  await client.act({ type: 'start' });
  const beforeBots = client.messages.length;
  await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.phase === 'bidding' && item.state.turnId === item.state.selfId);
  await client.act({ type: 'bid', value: 0 });
  const playing = (await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.phase === 'playing', beforeBots)).state;
  assert.ok(playing.landlordId?.startsWith('bot-'));
  const botPlayed = (await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.phase === 'playing' && !!item.state.currentPlay, beforeBots)).state;
  assert.ok(botPlayed.currentPlay?.playerId.startsWith('bot-'));
  assert.equal(botPlayed.hand.length, 17);
});

test('three real websocket clients receive fixed chat in lobby, off-turn and while paused', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  const clients = ['房主', '朋友甲', '朋友乙'].map(() => new Client(`ws://127.0.0.1:${app.port}/ws`));
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await app.close(); });
  const [a, b, c] = clients;
  await Promise.all(clients.map(client => client.opened()));
  a.send({ type: 'create', name: '房主', password: 'chat-room' });
  const host = await a.receive(isJoined); await a.receive(isState);
  b.send({ type: 'join', code: host.code, name: '朋友甲', password: 'chat-room' }); await b.receive(isJoined); await b.receive(isState);
  c.send({ type: 'join', code: host.code, name: '朋友乙', password: 'chat-room' }); await c.receive(isJoined); await c.receive(isState);
  for (const client of clients) await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.players.length === 3);
  const offsets = clients.map(client => client.messages.length);
  const lobby = await b.act({ type: 'chat', phraseId: 1 });
  const event = lobby.events.at(-1)!;
  assert.equal(event.type, 'chat'); assert.equal(event.actorId, b.state.selfId); assert.equal(event.phraseId, 1);
  for (const [index, client] of clients.entries()) {
    const broadcast = await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.events.some(chat => chat.id === event.id), offsets[index]);
    assert.equal(broadcast.state.phase, 'lobby'); assert.equal(broadcast.state.turnId, null);
    assert.deepEqual(broadcast.state.events.at(-1), event);
    assert.ok(broadcast.state.capabilities?.includes('quick-chat'));
  }
  let before = b.messages.length;
  b.send({ type: 'action', action: { type: 'chat', phraseId: 2 } });
  assert.match((await b.receive(isError, before)).message, /3秒/);
  before = b.messages.length;
  b.send({ type: 'action', action: { type: 'chat', phraseId: 0, actorId: host.playerId, text: 'forged text' } as unknown as GameAction });
  assert.match((await b.receive(isError, before)).message, /快捷聊天/);

  for (const client of clients) await client.act({ type: 'ready', ready: true });
  await a.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.players.every(player => player.ready));
  const started = await a.act({ type: 'start' });
  for (const client of clients) await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= started.version);
  const offTurn = c.state.selfId !== started.turnId ? c : a;
  const chatted = await offTurn.act({ type: 'chat', phraseId: 3 });
  assert.equal(chatted.phase, 'bidding'); assert.equal(chatted.turnId, started.turnId); assert.equal(chatted.deadline, started.deadline); assert.equal(chatted.hand.length, 17);
  assert.equal(chatted.events.at(-1)?.actorId, offTurn.state.selfId);
  const pauseOffsets = clients.map(client => client.messages.length);
  await b.close();
  const speaker = offTurn === a ? c : a;
  await speaker.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.paused, pauseOffsets[clients.indexOf(speaker)]);
  const pausedChat = await speaker.act({ type: 'chat', phraseId: 4 });
  assert.equal(pausedChat.paused, true); assert.equal(pausedChat.deadline, null); assert.equal(pausedChat.turnId, started.turnId);
  assert.equal(pausedChat.events.at(-1)?.phraseId, 4);
  assert.deepEqual(Object.keys(pausedChat.events.at(-1)!).sort(), ['actorId', 'at', 'id', 'phraseId', 'type']);
});

test('a real non-reading websocket is disconnected before outbound snapshots queue beyond one MiB', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = new Promise<WebSocket>(resolve => server.once('connection', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  client.on('error', () => {});
  t.after(async () => { client.terminate(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const peer = await connected;
  (client as unknown as { _socket: Socket })._socket.pause();
  const message = { type: 'error' as const, message: 'x'.repeat(32 * 1024) };
  let maximumPending = 0, sent = 0;
  while (peer.readyState === WebSocket.OPEN && sent < 1000) {
    sendRoomMessage(peer, message); sent++;
    maximumPending = Math.max(maximumPending, peer.bufferedAmount);
  }
  assert.notEqual(peer.readyState, WebSocket.OPEN, 'slow clients must not keep accumulating server messages');
  assert.ok(sent < 1000); assert.ok(maximumPending <= 1024 * 1024, `queued ${maximumPending} bytes`);
});

test('idle room ticks read public progress without cloning private views', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  const client = new Client(`ws://127.0.0.1:${app.port}/ws`);
  const original = Game.prototype.view;
  let code = '', reads = 0;
  Game.prototype.view = function (id) { if (this.code === code) reads++; return original.call(this, id); };
  t.after(async () => { Game.prototype.view = original; await client.close(); await app.close(); });
  await client.opened(); client.send({ type: 'create', name: '空闲内存验收', password: 'idle-room' });
  const joined = await client.receive(isJoined); await client.receive(isState); code = joined.code; reads = 0;
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(reads, 0, 'unchanged rooms need no private hand/event deep clones during background ticks');
});

test('health endpoint and websocket origin checks', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.port}/health`);
  assert.equal(response.status, 200);
  const health = await response.json() as { ok: boolean; version: string; protocol: string; capabilities: string[] };
  assert.equal(health.ok, true);
  assert.match(health.version, /^\d+\.\d+\.\d+/);
  assert.equal(health.protocol, 'turn-skills-v2');
  assert.deepEqual(health.capabilities, ['quick-chat', 'soft-bomb', 'turn-skill-limit']);
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/src/shared/game.ts`)).status, 404);
  const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: 'https://untrusted.example' });
  const status = await new Promise<number>((resolve, reject) => {
    socket.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); });
    socket.on('open', () => reject(new Error('Untrusted origin was accepted')));
    socket.on('error', () => {});
  });
  assert.equal(status, 403);
  const desktop = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: 'http://127.0.0.1:53219' });
  await new Promise<void>((resolve, reject) => { desktop.once('open', resolve); desktop.once('error', reject); });
  await new Promise<void>(resolve => { desktop.once('close', () => resolve()); desktop.close(); });
});

function botGame() {
  const game = new Game('765432', { random: () => 0.4 });
  for (const id of ['human', 'bot-a', 'bot-b']) { game.addPlayer(id, id); game.act(id, { type: 'ready', ready: true }); }
  game.act('human', { type: 'start' });
  game.act(game.turnId!, { type: 'bid', value: 3 });
  game.landlordId = 'human';
  game.phase = 'playing';
  game.turnId = 'bot-a';
  return game;
}

test('bot uses disruption against an opponent, skips illegal skills and handles identity', () => {
  const game = botGame();
  const bot = game.players.find(player => player.id === 'bot-a')!;
  const enemy = game.players.find(player => player.id === 'human')!;
  const teammate = game.players.find(player => player.id === 'bot-b')!;
  bot.skills = [{ id: 'add', kind: 'addTwo' }];
  const enemyBefore = enemy.hand.length, friendBefore = teammate.hand.length;
  runBotTurn(game, bot.id);
  assert.equal(enemy.hand.length, enemyBefore + 2);
  assert.equal(teammate.hand.length, friendBefore);
  assert.equal(bot.skills.length, 0);
  assert.equal(game.turnId, bot.id);
  const beforePlay = bot.hand.length;
  runBotTurn(game, bot.id);
  assert.ok(bot.hand.length < beforePlay);
  assert.notEqual(game.turnId, bot.id);

  const fallback = botGame();
  const fallbackBot = fallback.players.find(player => player.id === 'bot-a')!;
  fallbackBot.hand.push({ id: 'already-wild', rank: 3, suit: 'W', wild: true });
  fallbackBot.skills = [{ id: 'wild', kind: 'wild' }, { id: 'reverse', kind: 'reverse' }];
  runBotTurn(fallback, fallbackBot.id);
  assert.deepEqual(fallbackBot.skills.map(skill => skill.kind), ['wild']);
  assert.equal(fallback.direction, -1);
  assert.equal(fallback.turnId, fallbackBot.id);

  const identity = botGame();
  identity.players.find(player => player.id === 'bot-a')!.skills = [{ id: 'swap', kind: 'identity' }];
  runBotTurn(identity, 'bot-a');
  assert.equal(identity.landlordId, 'bot-a');
  assert.equal(identity.identityUses, 1);
});

test('farmer bot yields to a teammate close to winning and bots ready after restart', () => {
  const game = botGame();
  const bot = game.players.find(player => player.id === 'bot-a')!;
  const friend = game.players.find(player => player.id === 'bot-b')!;
  game.phase = 'playing'; game.turnId = bot.id;
  bot.hand = [{ id: 'b4', rank: 4, suit: 'S' }, { id: 'b9', rank: 9, suit: 'H' }];
  friend.hand = [{ id: 'friend-final', rank: 5, suit: 'C' }];
  const card = { id: 'played', rank: 3, suit: 'D' as const };
  game.currentPlay = { playerId: friend.id, cards: [card], combination: classify([card])! };
  game.passCount = 0;
  runBotTurn(game, bot.id);
  assert.equal(bot.hand.length, 2);
  assert.equal(game.passCount, 1);
  game.phase = 'finished';
  game.act('human', { type: 'restart' });
  readyBots(game);
  assert.equal(game.players.filter(player => player.id.startsWith('bot-')).every(player => player.ready), true);
  assert.equal(game.players.find(player => player.id === 'human')!.ready, false);
  game.act('human', { type: 'ready', ready: true });
  game.act('human', { type: 'start' });
  assert.equal(game.phase, 'bidding');
});

test('bot uses one skill before playing, then can use one skill again on its next turn', () => {
  const game = botGame();
  const bot = game.players.find(player => player.id === 'bot-a')!;
  game.landlordId = bot.id;
  bot.skills = [{ id: 'three-a', kind: 'three' }, { id: 'three-b', kind: 'three' }, { id: 'three-c', kind: 'three' }];
  const cards = bot.hand.length;
  runBotTurn(game, bot.id);
  assert.equal(game.turnId, bot.id); assert.equal(game.skillUsed, 1); assert.equal(bot.skills.length, 2);
  runBotTurn(game, bot.id);
  assert.notEqual(game.turnId, bot.id);
  assert.equal(bot.skills.length, 2);
  assert.ok(bot.hand.length < cards);
  game.turnId = bot.id;
  game.currentPlay = null;
  const remaining = bot.skills.length;
  runBotTurn(game, bot.id);
  assert.equal(bot.skills.length, remaining - 1);
  assert.equal(game.turnId, bot.id);
});

test('three websocket clients receive a wildcard soft bomb and enforce hard-bomb priority on the server', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  const clients = Array.from({ length: 3 }, () => new Client(`ws://127.0.0.1:${app.port}/ws`));
  const originalAddPlayer = Game.prototype.addPlayer;
  let fixture: Game | undefined;
  Game.prototype.addPlayer = function (id, name) {
    originalAddPlayer.call(this, id, name);
    if (name === '软炸联机房主') fixture = this;
  };
  t.after(async () => {
    Game.prototype.addPlayer = originalAddPlayer;
    await Promise.all(clients.map(client => client.close()));
    await app.close();
  });
  const [a, b, c] = clients;
  await Promise.all(clients.map(client => client.opened()));
  a.send({ type: 'create', name: '软炸联机房主', password: 'soft-bomb-room' });
  const host = await a.receive(isJoined); await a.receive(isState);
  b.send({ type: 'join', name: '硬炸玩家', code: host.code, password: 'soft-bomb-room' });
  const friend = await b.receive(isJoined); await b.receive(isState);
  c.send({ type: 'join', name: '大软炸玩家', code: host.code, password: 'soft-bomb-room' });
  const third = await c.receive(isJoined); await c.receive(isState);
  for (const client of clients) await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.players.length === 3);
  assert.ok(fixture);
  const game = fixture;
  const natural = (id: string, rank: number): Card => ({ id, rank, suit: 'S' });
  const wildcard = (id: string): Card => ({ id, rank: 3, suit: 'W', wild: true, generated: true });
  const aWild = wildcard('wire-soft-wild'), cWild = wildcard('wire-high-soft-wild');
  const aCards = [natural('wire-five-1', 5), natural('wire-five-2', 5), natural('wire-five-3', 5), aWild];
  const bCards = Array.from({ length: 4 }, (_, index) => natural(`wire-three-${index}`, 3));
  const cCards = [natural('wire-ace-1', 14), natural('wire-ace-2', 14), natural('wire-ace-3', 14), cWild];
  game.phase = 'playing'; game.turnId = host.playerId; game.landlordId = host.playerId;
  game.deadline = Date.now() + 45_000;
  game.players.find(player => player.id === host.playerId)!.hand = [...aCards, natural('wire-a-left', 9)];
  game.players.find(player => player.id === friend.playerId)!.hand = [...bCards, natural('wire-b-left', 8)];
  game.players.find(player => player.id === third.playerId)!.hand = [...cCards, natural('wire-c-left', 10)];
  const initialized = await a.act({ type: 'chat', phraseId: 0 });
  for (const client of clients) await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= initialized.version);
  const soft = await a.act({ type: 'play', cardIds: aCards.map(card => card.id), wildAs: { [aWild.id]: 5 } });
  assert.equal(soft.currentPlay?.combination.type, 'bomb');
  assert.equal(soft.currentPlay?.combination.bombKind, 'soft');
  assert.equal(soft.currentPlay?.combination.label, '软炸弹');
  assert.equal(soft.multiplier, 2);
  for (const client of clients) {
    const broadcast = await client.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= soft.version);
    assert.deepEqual(broadcast.state.currentPlay, soft.currentPlay);
    assert.ok(broadcast.state.capabilities?.includes('soft-bomb'));
    assert.ok(broadcast.state.players.every(player => !('hand' in player)));
  }
  const hard = await b.act({ type: 'play', cardIds: bCards.map(card => card.id) });
  assert.equal(hard.currentPlay?.combination.rank, 3);
  assert.equal(hard.currentPlay?.combination.type, 'bomb');
  assert.notEqual(hard.currentPlay?.combination.bombKind, 'soft');
  assert.equal(hard.multiplier, 4);
  await c.receive((item): item is Extract<ServerMessage, { type: 'state' }> => item.type === 'state' && item.state.version >= hard.version);
  const before = c.state;
  await assert.rejects(c.act({ type: 'play', cardIds: cCards.map(card => card.id), wildAs: { [cWild.id]: 14 } }), /牌|压不过/);
  assert.deepEqual(c.state, before);
  assert.equal(game.version, hard.version);
  assert.equal(game.multiplier, 4);
  assert.equal(game.players.find(player => player.id === third.playerId)!.hand.length, 5);
});
