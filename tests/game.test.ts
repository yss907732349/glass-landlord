import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/shared/game.ts';
import { SKILLS } from '../src/shared/skills.ts';
import { QUICK_CHATS } from '../src/shared/chat.ts';
import { findHint } from '../src/shared/rules.ts';
import type { Card, GameAction, SkillKind } from '../src/shared/types.ts';

let sequence = 0;
const card = (rank: number, wild = false): Card => ({ id: `test-${++sequence}`, rank, suit: wild ? 'W' : 'S', ...(wild ? { wild: true } : {}) });
function room(): Game {
  const game = new Game('123456', { random: () => 0.25 });
  for (const id of ['a', 'b', 'c']) game.addPlayer(id, `玩家${id}`);
  return game;
}
function playing(): Game {
  const game = room(); game.phase = 'playing'; game.landlordId = 'a'; game.turnId = 'a';
  game.deadline = Date.now() + 45_000;
  for (const player of game.players) player.hand = [card(3), card(4), card(5), card(6), card(7), card(8)];
  return game;
}
function stage(kind: SkillKind, actor = 'a'): Game {
  const game = playing(); game.turnId = actor;
  game.players.find(p => p.id === actor)!.skills = [{ id: 'chosen', kind }];
  return game;
}

test('skill weights total 100 and exactly ten active effects exclude the removed mutual penalty', () => {
  assert.equal(SKILLS.length, 10); assert.equal(SKILLS.reduce((sum, skill) => sum + skill.weight, 0), 100);
  assert.ok(!SKILLS.some(skill => String(skill.kind) === 'mutual'));
});

test('quick chat preserves the five exact fixed phrases and never accepts arbitrary text or a forged actor', () => {
  assert.deepEqual(QUICK_CHATS, ['快点吧我等到花儿也谢了', '共三小你打的几把牌', '给阿姨倒一杯卡布基诺', '你好机车啊', '你还能13张牌把我秒了？']);
  const game = playing();
  const before = game.view('a');
  for (const phraseId of [-1, 5, 1.5, NaN]) assert.throws(() => game.act('a', { type: 'chat', phraseId }), /有效的快捷聊天/);
  assert.throws(() => game.act('a', { type: 'chat', phraseId: 0, text: 'arbitrary text' } as unknown as GameAction), /有效的快捷聊天/);
  assert.throws(() => game.act('a', { type: 'chat', phraseId: 0, actorId: 'b' } as unknown as GameAction), /有效的快捷聊天/);
  assert.deepEqual(game.view('a'), before);
  game.act('a', { type: 'chat', phraseId: 4 });
  assert.equal(game.events.at(-1)?.actorId, 'a'); assert.equal(game.events.at(-1)?.phraseId, 4);
  assert.deepEqual(Object.keys(game.events.at(-1)!).sort(), ['actorId', 'at', 'id', 'phraseId', 'type']);
});

test('quick chat is allowed in every room phase and off-turn without changing game progress or logs', () => {
  for (const phase of ['lobby', 'bidding', 'playing', 'skill_discard', 'finished'] as const) {
    const game = playing(); game.phase = phase;
    const { events: _events, version: _version, ...before } = game.view('b');
    game.act('b', { type: 'chat', phraseId: 0 });
    const { events, version, ...after } = game.view('b');
    assert.deepEqual(after, before, `chat changed the ${phase} state`);
    assert.equal(version, _version + 1); assert.equal(events.at(-1)?.type, 'chat');
    assert.equal(events.at(-1)?.actorId, 'b'); assert.equal(game.turnId, 'a');
    assert.deepEqual(game.view('a').events, game.view('c').events);
    assert.deepEqual(game.view('a').capabilities, ['quick-chat', 'soft-bomb', 'turn-skill-limit']);
  }
});

test('quick chat cooldown is three seconds per player, including a first message at timestamp zero', () => {
  let now = 0; const game = new Game('chat-clock', { now: () => now });
  for (const id of ['a', 'b', 'c']) game.addPlayer(id, id);
  game.act('a', { type: 'chat', phraseId: 0 }); game.act('b', { type: 'chat', phraseId: 1 });
  const before = game.view('a');
  now = 2999; assert.throws(() => game.act('a', { type: 'chat', phraseId: 2 }), /3秒/); assert.deepEqual(game.view('a'), before);
  now = 3000; game.act('a', { type: 'chat', phraseId: 2 }); assert.equal(game.events.at(-1)?.phraseId, 2);
});

test('connected players can chat during disconnect pause while a disconnected actor cannot', () => {
  const game = playing(); game.setConnected('c', false);
  assert.equal(game.paused, true); const beforeTurn = game.turnId; const beforeDeadline = game.deadline;
  game.act('b', { type: 'chat', phraseId: 3 });
  assert.equal(game.paused, true); assert.equal(game.turnId, beforeTurn); assert.equal(game.deadline, beforeDeadline);
  const before = game.view('a'); assert.throws(() => game.act('c', { type: 'chat', phraseId: 0 }), /重新连接/); assert.deepEqual(game.view('a'), before);
});

test('three ready players start with private 17-card hands and hidden bottom; winning bid gets 20', () => {
  const game = room();
  assert.throws(() => game.act('a', { type: 'start' }), /全部准备/);
  for (const p of game.players) game.act(p.id, { type: 'ready', ready: true });
  game.act('a', { type: 'start' });
  assert.equal(game.phase, 'bidding'); assert.equal(game.view('a').hand.length, 17); assert.equal(game.view('a').bottom.length, 0);
  assert.equal('hand' in game.view('a').players[1], false);
  assert.equal(new Set(game.players.flatMap(p => p.hand).concat(game.bottom).map(c => c.id)).size, 54);
  const bidder = game.turnId!; game.act(bidder, { type: 'bid', value: 3 });
  assert.equal(game.landlordId, bidder); assert.equal(game.view(bidder).hand.length, 20); assert.equal(game.view('a').bottom.length, 3);
  assert.equal(game.phase, 'playing');
});

test('all three passing bids redeal, invalid/out-of-turn bid preserves state', () => {
  const game = room(); for (const p of game.players) game.act(p.id, { type: 'ready', ready: true }); game.act('a', { type: 'start' });
  const before = game.view('a'); const wrong = game.players.find(p => p.id !== game.turnId)!.id;
  assert.throws(() => game.act(wrong, { type: 'bid', value: 3 }), /还没轮到/); assert.deepEqual(game.view('a'), before);
  for (let i = 0; i < 3; i++) game.act(game.turnId!, { type: 'bid', value: 0 });
  assert.equal(game.phase, 'bidding'); assert.equal(game.bidCount, 0); assert.equal(game.landlordId, null);
});

test('three natural cards plus a wildcard play as a soft bomb, broadcast substitutions and double the multiplier', () => {
  const game = playing();
  const actor = game.players[0];
  const wild = card(3, true);
  actor.hand = [card(7), card(7), card(7), wild, card(9)];
  const ids = actor.hand.slice(0, 4).map(item => item.id);
  game.act('a', { type: 'play', cardIds: ids, wildAs: { [wild.id]: 7 } });
  assert.equal(game.currentPlay?.combination.type, 'bomb');
  assert.equal(game.currentPlay?.combination.bombKind, 'soft');
  assert.equal(game.currentPlay?.combination.label, '软炸弹');
  assert.equal(game.currentPlay?.combination.rank, 7);
  assert.equal(game.multiplier, 2);
  assert.equal(game.phase, 'playing');
  assert.equal(game.turnId, 'b');
  assert.equal(actor.hand.length, 1);
  for (const id of ['a', 'b', 'c']) {
    const view = game.view(id);
    assert.deepEqual(view.currentPlay?.cards.map(item => item.id), ids);
    assert.deepEqual(view.currentPlay?.wildAs, { [wild.id]: 7 });
    assert.equal(view.currentPlay?.combination.bombKind, 'soft');
    assert.equal(view.multiplier, 2);
  }
  assert.equal(game.events.at(-1)?.type, 'play');
  assert.equal(game.events.at(-1)?.count, 4);
});

test('a lower hard bomb beats a soft bomb while a higher soft bomb cannot beat it or consume cards', () => {
  const game = playing();
  const [a, b, c] = game.players;
  const wildA = card(3, true), wildC = card(3, true);
  a.hand = [card(10), card(10), card(10), wildA, card(6)];
  b.hand = [card(3), card(3), card(3), card(3), card(8)];
  c.hand = [card(14), card(14), card(14), wildC, card(9)];
  game.act('a', { type: 'play', cardIds: a.hand.slice(0, 4).map(item => item.id), wildAs: { [wildA.id]: 10 } });
  game.act('b', { type: 'play', cardIds: b.hand.slice(0, 4).map(item => item.id) });
  assert.equal(game.currentPlay?.playerId, 'b');
  assert.equal(game.currentPlay?.combination.type, 'bomb');
  assert.equal(game.currentPlay?.combination.rank, 3);
  assert.notEqual(game.currentPlay?.combination.bombKind, 'soft');
  assert.equal(game.multiplier, 4);
  const before = game.view('c');
  assert.throws(() => game.act('c', { type: 'play', cardIds: c.hand.slice(0, 4).map(item => item.id), wildAs: { [wildC.id]: 14 } }), /压不过/);
  assert.deepEqual(game.view('c'), before);
  assert.equal(game.turnId, 'c');
});

test('a soft bomb can finish the hand immediately with bomb and spring multipliers but no skill draw', () => {
  const game = playing();
  const actor = game.players[0];
  const wild = card(3, true);
  actor.hand = [card(8), card(8), card(8), wild];
  game.act('a', { type: 'play', cardIds: actor.hand.map(item => item.id), wildAs: { [wild.id]: 8 } });
  assert.equal(game.phase, 'finished');
  assert.equal(game.winner, 'landlord');
  assert.equal(game.winnerId, 'a');
  assert.equal(game.currentPlay?.combination.bombKind, 'soft');
  assert.equal(game.multiplier, 4);
  assert.equal(game.turnId, null);
  assert.equal(game.events.some(event => event.type === 'drawSkills'), false);
});

test('two passes clear the table, draw two landlord skills and one per farmer; inventories carry across tricks', () => {
  const game = playing(); game.players[0].skills = [{ id: 'stored-a', kind: 'peek' }]; game.players[1].skills = [{ id: 'stored-b', kind: 'peek' }];
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  assert.equal(game.currentPlay?.cards.length, 1);
  game.act('b', { type: 'pass' }); game.act('c', { type: 'pass' });
  assert.equal(game.currentPlay, null); assert.equal(game.turnId, 'a'); assert.equal(game.trick, 2);
  assert.equal(game.players[0].skills.length, 3); assert.equal(game.players[1].skills.length, 2); assert.equal(game.players[2].skills.length, 1);
  assert.equal(game.phase, 'playing'); assert.equal(game.players[0].skills[0].id, 'stored-a');
  assert.equal(game.turnId, 'a'); assert.equal(game.view('a').skillActorId, null);
});

test('overflow is mandatory before anyone can cast; landlord keeps three, farmer two', () => {
  const game = playing();
  game.players[0].skills = ['x', 'y', 'z'].map(id => ({ id, kind: 'peek' as const }));
  game.players[1].skills = ['u', 'v'].map(id => ({ id, kind: 'peek' as const }));
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] }); game.act('b', { type: 'pass' }); game.act('c', { type: 'pass' });
  assert.equal(game.phase, 'skill_discard'); assert.equal(game.view('a').mustDiscard, 2); assert.equal(game.view('b').mustDiscard, 1);
  assert.throws(() => game.act('a', { type: 'skill', skillId: 'x', targetId: 'b' }), /自己的出牌回合/);
  assert.throws(() => game.act('a', { type: 'discard', skillIds: ['x'] }), /2张/);
  game.act('a', { type: 'discard', skillIds: ['x', 'y'] }); assert.equal(game.phase, 'skill_discard');
  game.act('b', { type: 'discard', skillIds: ['u'] }); assert.equal(game.phase, 'playing'); assert.equal(game.turnId, 'a');
  assert.equal(game.players[0].skills.length, 3); assert.equal(game.players[1].skills.length, 2);
});

test('steal and gift cannot empty anyone, and rejected skills are not consumed', () => {
  const game = stage('steal'); game.players[1].hand = [card(3)];
  const before = game.view('a'); assert.throws(() => game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' }), /最后一张/); assert.deepEqual(game.view('a'), before);
  game.players[1].hand.push(card(4)); game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' });
  assert.equal(game.players[1].hand.length, 1); assert.equal(game.players[0].hand.length, 7);
  const gift = stage('gift'); gift.players[0].hand = [card(4)];
  assert.throws(() => gift.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b', cardIds: [gift.players[0].hand[0].id] }), /至少保留/);
});

test('trade exchanges two for one atomically, including own two-card endgame', () => {
  const game = stage('trade'); game.players[0].hand = [card(3), card(4)]; game.players[1].hand = [card(14)];
  game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b', cardIds: game.players[0].hand.map(c => c.id) });
  assert.equal(game.players[0].hand.length, 1); assert.equal(game.players[0].hand[0].rank, 14); assert.equal(game.players[1].hand.length, 2); assert.notEqual(game.phase, 'finished');
});

test('peek is private and any transfer invalidates stale observations', () => {
  const game = stage('peek'); game.players[0].skills.push({ id: 'second', kind: 'steal' });
  game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' });
  assert.equal(game.view('a').privatePeek.length, 3); assert.equal(game.view('b').privatePeek.length, 0); assert.equal(game.view('c').privatePeek.length, 0);
  const snapshot = game.view('a'); snapshot.hand.length = 0; assert.equal(game.players[0].hand.length, 6);
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  game.act('b', { type: 'pass' }); game.act('c', { type: 'pass' });
  game.act('a', { type: 'skill', skillId: 'second', targetId: 'c' }); assert.equal(game.view('a').privatePeek.length, 0);
});

test('generated cards have fresh identities and add-two and extra-three preserve declared ranks', () => {
  const two = stage('addTwo'); two.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' });
  const extras = two.players[1].hand.filter(c => c.generated); assert.equal(extras.length, 2); assert.ok(extras.every(c => c.rank >= 3 && c.rank <= 15)); assert.notEqual(extras[0].id, extras[1].id);
  const three = stage('three'); three.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' });
  assert.equal(three.players[0].hand.length, 6); assert.equal(three.players[1].hand.length, 7); assert.equal(three.players[2].hand.length, 6);
  const extraThree = three.players[1].hand.filter(c => c.generated); assert.equal(extraThree.length, 1); assert.equal(extraThree[0].rank, 3);
  assert.ok(!two.players.flatMap(p => p.hand).some(c => c.id === extraThree[0].id));
});

test('wild generation respects already-held and per-game limits', () => {
  const game = stage('wild'); game.act('a', { type: 'skill', skillId: 'chosen' });
  assert.equal(game.players[0].hand.filter(c => c.wild).length, 1); assert.equal(game.wildCreated, 1);
  const held = stage('wild'); held.players[0].hand.push(card(3, true));
  assert.throws(() => held.act('a', { type: 'skill', skillId: 'chosen' }), /已有赖子/); assert.equal(held.players[0].skills.length, 1);
  const exhausted = stage('wild'); exhausted.wildCreated = 3; assert.throws(() => exhausted.act('a', { type: 'skill', skillId: 'chosen' }), /本局三张/);
});

test('shuffle preserves each hand count and all physical card identities, clearing peeks', () => {
  const game = stage('shuffle'); game.players[1].hand = [card(16)]; game.players[2].hand.push(card(3, true), card(3, true)); game.players[0].peek = [card(7)];
  const counts = game.players.map(p => p.hand.length); const ids = game.players.flatMap(p => p.hand).map(c => c.id).sort();
  game.act('a', { type: 'skill', skillId: 'chosen' });
  assert.deepEqual(game.players.map(p => p.hand.length), counts); assert.deepEqual(game.players.flatMap(p => p.hand).map(c => c.id).sort(), ids); assert.equal(game.view('a').privatePeek.length, 0); assert.equal(game.shuffleUses, 1);
});

test('direction reversal is immediate without spending the turn, and later-turn reversal restores direction', () => {
  const game = stage('reverse'); const deadline = game.deadline;
  game.act('a', { type: 'skill', skillId: 'chosen' }); assert.equal(game.direction, -1); assert.equal(game.turnId, 'a'); assert.equal(game.deadline, deadline);
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] }); assert.equal(game.turnId, 'c');
  const double = stage('reverse'); double.players[0].skills.push({ id: 'again', kind: 'reverse' });
  double.act('a', { type: 'skill', skillId: 'chosen' });
  assert.throws(() => double.act('a', { type: 'skill', skillId: 'again' }), /最多使用一张/);
  double.act('a', { type: 'play', cardIds: [double.players[0].hand[0].id] });
  double.act('c', { type: 'pass' }); double.act('b', { type: 'pass' });
  double.act('a', { type: 'skill', skillId: 'again' });
  assert.equal(double.direction, 1); assert.equal(double.turnId, 'a'); assert.equal(double.phase, 'playing');
});

test('one skill per playing turn preserves the play deadline and resets after play, pass and trick clearance', () => {
  const game = stage('peek');
  game.players[0].skills.push({ id: 'two', kind: 'three' }, { id: 'three', kind: 'reverse' });
  game.players[1].skills = [{ id: 'opponent', kind: 'three' }];
  const before = JSON.stringify(game.players.map(p => game.view(p.id)));
  assert.throws(() => game.act('b', { type: 'skill', skillId: 'opponent', targetId: 'a' }), /自己的出牌回合/);
  assert.equal(JSON.stringify(game.players.map(p => game.view(p.id))), before);
  const deadline = game.deadline;
  game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' });
  assert.equal(game.view('a').skillUsed, 1); assert.equal(game.view('a').skillBudget, 1);
  const after = JSON.stringify(game.players.map(p => game.view(p.id)));
  assert.throws(() => game.act('a', { type: 'skill', skillId: 'two', targetId: 'b' }), /最多使用一张/);
  assert.equal(JSON.stringify(game.players.map(p => game.view(p.id))), after);
  assert.equal(game.players[0].skills.length, 2); assert.equal(game.turnId, 'a'); assert.equal(game.deadline, deadline);
  assert.throws(() => game.act('a', { type: 'skillEnd' }), /无需结束技能阶段/);
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  assert.equal(game.turnId, 'b'); assert.equal(game.view('b').skillUsed, 0);
  game.act('b', { type: 'skill', skillId: 'opponent', targetId: 'a' }); assert.equal(game.view('b').skillUsed, 1);
  game.act('b', { type: 'pass' }); assert.equal(game.view('c').skillUsed, 0);
  game.act('c', { type: 'pass' }); assert.equal(game.turnId, 'a'); assert.equal(game.view('a').skillUsed, 0);
  if (game.phase === 'skill_discard') {
    for (const p of game.players) { const excess = game.view(p.id).mustDiscard; if (excess) game.act(p.id, { type: 'discard', skillIds: p.skills.slice(0, excess).map(s => s.id) }); }
  }
  assert.equal(JSON.stringify(game.players.map(p => game.view(p.id))) === after, false);
  game.players[0].skills = [{ id: 'next-turn', kind: 'three' }];
  game.act('a', { type: 'skill', skillId: 'next-turn', targetId: 'b' }); assert.equal(game.view('a').skillUsed, 1);
});

test('reversed follow order skips the current high-hand owner until both opponents respond', () => {
  const game = playing(); game.players[1].skills = [{ id: 'reverse-b', kind: 'reverse' }];
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  game.act('b', { type: 'skill', skillId: 'reverse-b' }); game.act('b', { type: 'pass' });
  assert.equal(game.turnId, 'c'); assert.equal(game.passCount, 1); assert.equal(game.currentPlay?.playerId, 'a');
  game.act('c', { type: 'pass' });
  assert.equal(game.turnId, 'a'); assert.equal(game.currentPlay, null); assert.equal(game.passCount, 0);

  const overtaking = playing(); overtaking.players[1].skills = [{ id: 'reverse-b', kind: 'reverse' }];
  overtaking.act('a', { type: 'play', cardIds: [overtaking.players[0].hand[0].id] });
  overtaking.act('b', { type: 'skill', skillId: 'reverse-b' });
  overtaking.act('b', { type: 'play', cardIds: [overtaking.players[1].hand[1].id] });
  assert.equal(overtaking.currentPlay?.playerId, 'b'); assert.equal(overtaking.turnId, 'a');
});

test('identity exchange forces old landlord discard and resumes the exact following turn and table', () => {
  const game = stage('identity', 'c'); game.players[0].skills = ['x', 'y', 'z'].map(id => ({ id, kind: 'peek' as const }));
  game.turnId = 'a';
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  game.act('b', { type: 'pass' });
  const previousPlay = structuredClone(game.currentPlay);
  const counts = game.players.map(p => p.hand.length);
  game.act('c', { type: 'skill', skillId: 'chosen', targetId: 'a' });
  assert.equal(game.landlordId, 'c'); assert.equal(game.identityUses, 1); assert.equal(game.phase, 'skill_discard'); assert.equal(game.view('a').mustDiscard, 1);
  assert.deepEqual(game.players.map(p => p.hand.length), counts);
  game.act('a', { type: 'discard', skillIds: ['x'] });
  assert.equal(game.phase, 'playing'); assert.equal(game.turnId, 'c'); assert.equal(game.passCount, 1); assert.deepEqual(game.currentPlay, previousPlay);
  assert.equal(game.view('c').skills.length, 0);
  game.act('c', { type: 'play', cardIds: [game.players[2].hand[1].id] });
  assert.equal(game.turnId, 'a'); assert.equal(game.passCount, 0);
});

test('mid-turn identity overflow pauses the original play deadline until discarding completes', () => {
  let now = 1000;
  const game = new Game('discard-clock', { now: () => now, random: () => 0.25 });
  for (const id of ['a', 'b', 'c']) game.addPlayer(id, id);
  game.phase = 'playing'; game.landlordId = 'a'; game.turnId = 'b'; game.deadline = 46_000;
  for (const p of game.players) p.hand = [card(3), card(4), card(5)];
  game.players[0].skills = ['x', 'y', 'z'].map(id => ({ id, kind: 'peek' as const }));
  game.players[1].skills = [{ id: 'exchange', kind: 'identity' }, { id: 'extra-peek', kind: 'peek' }];
  now = 2000; game.act('b', { type: 'skill', skillId: 'exchange', targetId: 'a' });
  assert.equal(game.phase, 'skill_discard'); assert.equal(game.deadline, 32_000);
  now = 12_000; game.act('a', { type: 'discard', skillIds: ['x'] });
  assert.equal(game.phase, 'playing'); assert.equal(game.turnId, 'b'); assert.equal(game.deadline, 56_000);
  assert.equal(game.view('b').skillUsed, 1);
  const resumed = game.view('b');
  assert.throws(() => game.act('b', { type: 'skill', skillId: 'extra-peek', targetId: 'a' }), /最多使用一张/);
  assert.deepEqual(game.view('b'), resumed);
  assert.equal(game.view('b').skillUsed, 1);
  game.players[1].skills = [{ id: 'after-exchange', kind: 'reverse' }];
  const afterDiscard = game.view('b');
  assert.throws(() => game.act('b', { type: 'skill', skillId: 'after-exchange' }), /最多使用一张/);
  assert.deepEqual(game.view('b'), afterDiscard);
});

test('public events describe draws, discards, skills and plays without exposing private card data', () => {
  const game = playing(); game.players[0].skills = ['x', 'y', 'z'].map(id => ({ id, kind: 'peek' as const }));
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  game.act('b', { type: 'pass' }); game.act('c', { type: 'pass' });
  assert.deepEqual(game.events.filter(event => event.type === 'drawSkills').map(event => [event.actorId, event.count]), [['a', 2], ['b', 1], ['c', 1]]);
  game.act('a', { type: 'discard', skillIds: ['x', 'y'] });
  assert.equal(game.events.at(-1)?.type, 'discardSkills'); assert.equal(game.events.at(-1)?.count, 2);
  game.act('a', { type: 'skill', skillId: 'z', targetId: 'b' });
  assert.equal(game.events.at(-1)?.type, 'skill'); assert.equal(game.events.at(-1)?.targetId, 'b'); assert.equal(game.events.at(-1)?.skillKind, 'peek');
  const allowed = new Set(['id', 'type', 'actorId', 'targetId', 'skillKind', 'count', 'at']);
  assert.ok(game.events.every(event => Object.keys(event).every(key => allowed.has(key))));
  const view = game.view('b'); view.events[0].actorId = 'tampered'; assert.notEqual(game.events[0].actorId, 'tampered');
  for (let i = 0; i < 25; i++) {
    for (const p of game.players) p.skills = [];
    const next = card(3); game.players[0].hand.push(next);
    game.act('a', { type: 'play', cardIds: [next.id] });
    game.act('b', { type: 'pass' }); game.act('c', { type: 'pass' });
    game.players[0].skills = [{ id: `peek-${i}`, kind: 'peek' }];
    const deadline = game.deadline;
    game.act('a', { type: 'skill', skillId: `peek-${i}`, targetId: 'b' });
    assert.equal(game.deadline, deadline);
  }
  assert.equal(game.events.length, 20); assert.equal(new Set(game.events.map(event => event.id)).size, 20);
  game.players[0].hand = [card(3)]; game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] }); game.act('a', { type: 'restart' });
  assert.deepEqual(game.events, []);
});

test('malformed and unauthorized actions are atomic and do not consume cards, skills or turn budgets', () => {
  const game = playing();
  const snapshot = () => JSON.stringify(game.players.map(p => game.view(p.id)));
  const invalid: [string, GameAction][] = [
    ['b', { type: 'play', cardIds: [game.players[1].hand[0].id] }],
    ['a', { type: 'play', cardIds: [game.players[0].hand[0].id, game.players[0].hand[0].id] }],
    ['a', { type: 'play', cardIds: [game.players[1].hand[0].id] }],
    ['a', { type: 'play', cardIds: [game.players[0].hand[0].id], wildAs: { unrelated: 14 } }],
    ['a', { type: 'pass' }],
    ['b', { type: 'restart' }],
  ];
  for (const [actor, action] of invalid) { const before = snapshot(); assert.throws(() => game.act(actor, action)); assert.equal(snapshot(), before); }
  const skill = stage('identity', 'b');
  const before = JSON.stringify(skill.players.map(p => skill.view(p.id)));
  assert.throws(() => skill.act('b', { type: 'skill', skillId: 'chosen', targetId: 'c' }), /相反身份/);
  assert.equal(JSON.stringify(skill.players.map(p => skill.view(p.id))), before);
});

test('final legal play wins immediately, before any further skill draw', () => {
  const game = playing(); game.players[0].hand = [card(3)];
  game.act('a', { type: 'play', cardIds: [game.players[0].hand[0].id] });
  assert.equal(game.phase, 'finished'); assert.equal(game.winner, 'landlord'); assert.equal(game.players[0].skills.length, 0); assert.equal(game.deadline, null); assert.equal(game.multiplier, 2);
  game.act('a', { type: 'restart' }); assert.equal(game.phase, 'lobby'); assert.ok(game.players.every(p => !p.ready && !p.hand.length));
});

test('disconnect freezes deadline; reconnect restores remaining time and ticking takes legal default action', () => {
  let now = 1000; const game = new Game('clock', { now: () => now, random: () => 0.1 });
  for (const id of ['a', 'b', 'c']) { game.addPlayer(id, id); game.act(id, { type: 'ready', ready: true }); }
  game.act('a', { type: 'start' }); const originalDeadline = game.deadline!; now += 2000;
  game.setConnected('b', false); assert.equal(game.paused, true); assert.equal(game.deadline, null);
  now += 100_000; game.tick(now); assert.equal(game.bidCount, 0);
  game.setConnected('b', true); assert.equal(game.deadline, now + originalDeadline - 3000);
  now = game.deadline! + 1; game.tick(now); assert.equal(game.bidCount, 1);
});

test('seeded long games with chaotic, cooperative and stockpiling strategies terminate without duplicating or losing cards', () => {
  const exercised = new Set<SkillKind>();
  for (let seed = 1; seed <= 24; seed++) {
    let randomState = seed;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; };
    const game = new Game(`simulation-${seed}`, { random });
    for (const id of ['a', 'b', 'c']) { game.addPlayer(id, id); game.act(id, { type: 'ready', ready: true }); }
    game.act('a', { type: 'start' }); game.act(game.turnId!, { type: 'bid', value: 3 });
    const minted = new Set(game.players.flatMap(p => p.hand).map(c => c.id));
    const played = new Set<string>();
    let steps = 0;
    while (game.phase !== 'finished' && steps++ < 3000) {
      const beforeIds = new Set(game.players.flatMap(p => p.hand).map(c => c.id));
      const snapshot = () => JSON.stringify(game.players.map(p => game.view(p.id)));
      if (game.phase === 'playing') {
        const actor = game.players.find(p => p.id === game.turnId)!;
        let used = false;
        if (!(seed % 3 === 2 && random() < 0.35)) {
          const skills = [...actor.skills].sort(() => random() - 0.5);
          const targets = game.players.filter(p => p.id !== actor.id).sort(() => random() - 0.5);
          for (const skill of skills) {
            const def = SKILLS.find(s => s.kind === skill.kind)!;
            for (const target of def.target ? targets : [null]) {
              const action: GameAction = { type: 'skill', skillId: skill.id, ...(target ? { targetId: target.id } : {}), ...(def.select ? { cardIds: [...actor.hand].sort(() => random() - 0.5).slice(0, def.select).map(c => c.id) } : {}) };
              const before = snapshot();
              try { game.act(actor.id, action); exercised.add(skill.kind); used = true; break; }
              catch { assert.equal(snapshot(), before, `seed ${seed}: rejected ${skill.kind} mutated state`); }
            }
            if (used) break;
          }
        }
        if (!used) {
          const hint = findHint(actor.hand, game.currentPlay?.combination ?? null);
          const canPass = game.currentPlay !== null;
          const passForTeammate = seed % 3 === 1 && game.currentPlay?.playerId !== game.landlordId && actor.id !== game.landlordId;
          if (canPass && (!hint || passForTeammate || random() < 0.15)) game.act(actor.id, { type: 'pass' });
          else {
            assert.ok(hint, `seed ${seed}: free leader must have a legal hint`);
            game.act(actor.id, { type: 'play', ...hint });
            for (const id of hint.cardIds) { assert.equal(played.has(id), false, `seed ${seed}: card played twice`); played.add(id); }
          }
        }
      } else if (game.phase === 'skill_discard') {
        const actor = game.players.find(p => game.view(p.id).mustDiscard > 0)!;
        assert.ok(actor, `seed ${seed}: discard phase must have an overflowing player`);
        const amount = game.view(actor.id).mustDiscard;
        const selected = [...actor.skills].sort(() => random() - 0.5).slice(0, amount).map(s => s.id);
        game.act(actor.id, { type: 'discard', skillIds: selected });
      } else assert.fail(`seed ${seed}: unexpected phase ${game.phase}`);

      const held = game.players.flatMap(p => p.hand).map(c => c.id);
      assert.equal(new Set(held).size, held.length, `seed ${seed}: duplicate physical card in hands`);
      for (const id of held) {
        if (!beforeIds.has(id) && !minted.has(id)) minted.add(id);
        assert.equal(played.has(id), false, `seed ${seed}: a played card returned to a hand`);
      }
      assert.equal(held.length + played.size, minted.size, `seed ${seed}: cards created or lost outside a declared generation`);
      assert.equal(game.players.filter(p => p.id === game.landlordId).length, 1);
      assert.ok(game.players.every(p => p.hand.length > 0) || game.view('a').phase === 'finished');
      if (game.phase !== 'skill_discard') assert.ok(game.players.every(p => p.skills.length <= (p.id === game.landlordId ? 3 : 2)));
    }
    assert.equal(game.phase, 'finished', `seed ${seed}: stalled after ${steps} actions`);
  }
  assert.equal(exercised.size, SKILLS.length, 'simulations must exercise every active skill effect');
});

test('a rejected skill preserves the allowance, chat and reconnect cannot replenish a spent allowance', () => {
  const game = stage('steal');
  game.players[0].skills.push({ id: 'other', kind: 'three' });
  game.players[1].hand = [card(3)];
  assert.throws(() => game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' }), /最后一张/);
  assert.equal(game.view('a').skillUsed, 0);
  game.act('a', { type: 'skill', skillId: 'other', targetId: 'b' });
  assert.equal(game.view('a').skillUsed, 1);
  game.act('a', { type: 'chat', phraseId: 0 });
  game.setConnected('c', false); game.setConnected('c', true);
  const before = game.view('a');
  assert.throws(() => game.act('a', { type: 'skill', skillId: 'chosen', targetId: 'b' }), /最多使用一张/);
  assert.deepEqual(game.view('a'), before);
});

test('timeout advancement clears the used allowance and restart begins with a fresh allowance', () => {
  const game = stage('reverse');
  game.act('a', { type: 'skill', skillId: 'chosen' });
  assert.equal(game.view('a').skillUsed, 1);
  game.tick(game.deadline! + 1);
  assert.equal(game.turnId, 'c'); assert.equal(game.view('c').skillUsed, 0);
  game.players[2].skills = [{ id: 'next', kind: 'three' }];
  game.act('c', { type: 'skill', skillId: 'next', targetId: 'b' });
  assert.equal(game.view('c').skillUsed, 1);
  game.tick(game.deadline! + 1);
  assert.equal(game.turnId, 'b'); assert.equal(game.view('b').skillUsed, 0);
  game.phase = 'finished'; game.act('a', { type: 'restart' });
  assert.equal(game.skillUsed, 0);
  for (const p of game.players) game.act(p.id, { type: 'ready', ready: true });
  game.act('a', { type: 'start' }); game.act(game.turnId!, { type: 'bid', value: 3 });
  assert.equal(game.view(game.turnId!).skillUsed, 0); assert.equal(game.view(game.turnId!).skillBudget, 1);
});
