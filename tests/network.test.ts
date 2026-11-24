import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createGameServer } from '../server/index.ts';
import { readyBots, runBotTurn } from '../server/bots.ts';
import { Game } from '../src/shared/game.ts';
import { classify } from '../src/shared/rules.ts';
import { getSkill } from '../src/shared/skills.ts';
import type { ClientMessage, GameAction, GameView, ServerMessage } from '../src/shared/types.ts';

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
  assert.equal(used.skillBudget, 0);
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

test('health endpoint and websocket origin checks', async t => {
  const app = await createGameServer({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.port}/health`);
  assert.equal(response.status, 200);
  const health = await response.json() as { ok: boolean; version: string; protocol: string };
  assert.equal(health.ok, true);
  assert.match(health.version, /^\d+\.\d+\.\d+/);
  assert.equal(health.protocol, 'turn-skills-v2');
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

test('bot uses at most two skills before playing, then can use skills again next turn', () => {
  const game = botGame();
  const bot = game.players.find(player => player.id === 'bot-a')!;
  game.landlordId = bot.id;
  bot.skills = [{ id: 'three-a', kind: 'three' }, { id: 'three-b', kind: 'three' }, { id: 'three-c', kind: 'three' }];
  const cards = bot.hand.length;
  for (let i = 0; i < 3 && game.turnId === bot.id; i++) runBotTurn(game, bot.id);
  assert.notEqual(game.turnId, bot.id);
  assert.ok(bot.skills.length >= 1);
  assert.ok(bot.hand.length < cards);
  game.turnId = bot.id;
  game.currentPlay = null;
  const remaining = bot.skills.length;
  runBotTurn(game, bot.id);
  assert.equal(bot.skills.length, remaining - 1);
  assert.equal(game.turnId, bot.id);
});
