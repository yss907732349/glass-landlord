import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createGameServer } from '../server/index.ts';
import { Game } from '../src/shared/game.ts';
import { classify } from '../src/shared/rules.ts';

const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const checks = [], errors = [], plays = [];
let fixture, fixtureName = '', sequence = 0;
const transport = createServer((_request, response) => response.writeHead(404).end());
const sockets = new WebSocketServer({ server: transport, path: '/ws' });
const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function publish() { for (const socket of sockets.clients) send(socket, { type: 'state', state: fixture.view('self') }); }
function loadFixture(name, ranks, previousRanks = null) {
  fixtureName = name;
  const game = new Game('654321', { random: () => .1 });
  for (const [id, playerName] of [['self', '赖子验收'], ['other-a', '小满'], ['other-b', '阿七']]) { game.addPlayer(id, playerName); game.act(id, { type: 'ready', ready: true }); }
  game.act('self', { type: 'start' }); game.act(game.turnId, { type: 'bid', value: 3 });
  const ownCards = ranks.map((rank, i) => rank === 'W' ? { id: `${name}-wild-${i}`, rank: 3, suit: 'W', wild: true, generated: true } : { id: `${name}-card-${i}`, rank, suit: 'S' });
  game.players.find(player => player.id === 'self').hand = [...ownCards, { id: `${name}-reserve`, rank: 15, suit: 'H' }];
  game.turnId = 'self'; game.phase = 'playing'; game.passCount = 0;
  if (previousRanks) {
    const cards = previousRanks.map((rank, i) => ({ id: `${name}-previous-${i}`, rank, suit: 'D' }));
    game.currentPlay = { playerId: 'other-a', cards, combination: classify(cards) };
    game.lastActorId = 'other-a';
  } else { game.currentPlay = null; game.lastActorId = null; }
  game.version = ++sequence * 100;
  fixture = game; publish();
  return ownCards;
}
sockets.on('connection', socket => {
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'create') {
      send(socket, { type: 'joined', code: fixture.code, token: 'test-only-token', playerId: 'self' }); publish();
    } else if (message.type === 'ping') send(socket, { type: 'pong', at: message.at });
    else if (message.type === 'action') {
      const record = { fixture: fixtureName, action: message.action, accepted: false };
      if (message.action.type === 'play') plays.push(record);
      try { fixture.act('self', message.action); record.accepted = true; publish(); }
      catch (error) { record.error = error.message; send(socket, { type: 'error', message: error.message }); }
    } else if (message.type === 'leave') send(socket, { type: 'closed', message: '测试结束。' });
  });
});
await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${transport.address().port}`;
const staticServer = await createGameServer({ port: 0, host: '127.0.0.1' });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await context.addInitScript(address => {
  try { localStorage.setItem('glass-server', address); } catch {}
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'state') window.__wildView = message.state; });
    }
  };
}, endpoint);
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text()); });
const count = () => plays.length;
const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true, omitBackground: true });
async function readyFixture(name, ranks, previous = null) {
  const cards = loadFixture(name, ranks, previous);
  await page.waitForFunction(ids => ids.every(id => window.__wildView?.hand.some(card => card.id === id)), cards.map(card => card.id));
  await page.waitForFunction(() => document.querySelectorAll('.own-hand .selected').length === 0);
  assert.equal(await page.locator('.play-controls select,.wild-picker').count(), 0, 'manual wildcard selectors must not exist');
  for (const card of cards) await page.locator(`[data-card-id="${card.id}"]`).click({ position: { x: 5, y: 45 } });
  assert.equal(await page.locator('.own-hand .playing-card.selected').count(), cards.length);
  return cards;
}
async function clickPlay() { await page.getByRole('button', { name: /^出牌/ }).click(); }
async function acceptedSince(before) {
  await page.waitForFunction(() => window.__wildView?.currentPlay?.playerId === 'self');
  assert.equal(plays.length, before + 1);
  assert.equal(plays.at(-1).accepted, true, plays.at(-1).error);
  return plays.at(-1).action;
}
async function ambiguous(name, chosenRank, rightClick = false) {
  const cards = await readyFixture(name, [4, 5, 6, 7, 'W']);
  const before = count();
  if (rightClick) await page.locator('.own-hand').click({ button: 'right', position: { x: 15, y: 50 } }); else await clickPlay();
  await page.locator('.wild-options').waitFor({ state: 'visible' });
  assert.equal(count(), before, 'ambiguity must not send a guessed declaration');
  assert.equal(await page.locator('.wild-option').count(), 2);
  assert.equal(await page.locator('.wild-option[data-wild-ranks="3"]').count(), 1);
  assert.equal(await page.locator('.wild-option[data-wild-ranks="8"]').count(), 1);
  assert.equal(await page.locator('.modal-backdrop').count(), 0);
  if (name === 'choose-eight') {
    const previousVersion = fixture.version;
    fixture.act('other-a', { type: 'chat', phraseId: 0 }); publish();
    await page.waitForFunction(version => window.__wildView?.version > version, previousVersion);
    await page.locator('.chat-bubble[data-actor-id="other-a"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.wild-option').count(), 2, 'chat must not dismiss legal wildcard choices');
    assert.equal(await page.locator('.own-hand .playing-card.selected').count(), cards.length, 'chat must preserve selected physical cards');
    assert.equal(count(), before, 'chat must not submit a wildcard choice');
    checks.push('an opponent chat updates the view while keeping both wildcard choices and the selected hand intact');
  }
  if (chosenRank === 8 && !rightClick) await screenshot('wildcard-ambiguous-options.png');
  await page.locator(`.wild-option[data-wild-ranks="${chosenRank}"]`).click();
  const action = await acceptedSince(before);
  assert.equal(action.wildAs[cards.find(card => card.wild).id], chosenRank);
  assert.equal(await page.locator('.wild-options').count(), 0);
}

try {
  loadFixture('initial', [4, 5, 6, 8, 'W']);
  await page.goto(`http://127.0.0.1:${staticServer.port}`);
  await page.locator('input[name=nickname]').fill('赖子验收');
  await page.locator('input[name=password]').fill('test-only');
  await page.getByRole('button', { name: '开一桌', exact: true }).click();
  await page.waitForFunction(() => window.__wildView?.phase === 'playing');

  const unique = await readyFixture('unique-seven', [4, 5, 6, 8, 'W']);
  let before = count(); await clickPlay();
  let action = await acceptedSince(before);
  assert.equal(action.wildAs[unique.find(card => card.wild).id], 7);
  assert.equal(await page.locator('.wild-options').count(), 0);
  await screenshot('wildcard-unique-seven.png');
  checks.push('4,5,6,8 plus wildcard automatically submits wildcard=7 and the real Game accepts it');

  await ambiguous('choose-three', 3);
  await ambiguous('choose-eight', 8);
  checks.push('4,5,6,7 plus wildcard offers exactly 3 or 8; each click submits the selected declaration and real Game accepts both');

  const following = await readyFixture('follow-eight', [4, 5, 6, 7, 'W'], [3, 4, 5, 6, 7]);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.equal(action.wildAs[following.find(card => card.wild).id], 8);
  assert.equal(await page.locator('.wild-options').count(), 0);
  await screenshot('wildcard-follow-eight.png');
  checks.push('following 3,4,5,6,7 filters out wildcard=3 and directly plays wildcard=8');

  await readyFixture('impossible', [3, 5, 8, 11, 'W']);
  before = count(); await clickPlay();
  await page.getByRole('status').filter({ hasText: '这些牌无法组成能出的牌型' }).waitFor();
  assert.equal(count(), before);
  assert.equal(await page.locator('.wild-options').count(), 0);
  checks.push('an impossible wildcard group sends no play request and explains the invalid selection');

  const pairTwo = await readyFixture('pair-two', [15, 'W']);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.equal(action.wildAs[pairTwo.find(card => card.wild).id], 15);
  assert.equal(fixture.currentPlay.combination.type, 'pair');
  assert.equal(fixture.currentPlay.combination.rank, 15);
  assert.equal(await page.locator('.wild-options').count(), 0);
  checks.push('two plus wildcard automatically forms a pair of twos accepted by the real game');

  const tripleTwo = await readyFixture('triple-two', [15, 15, 'W']);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.equal(action.wildAs[tripleTwo.find(card => card.wild).id], 15);
  assert.equal(fixture.currentPlay.combination.type, 'triple');
  checks.push('two twos plus wildcard automatically form a triple of twos');

  const softTwo = await readyFixture('soft-two', [15, 15, 15, 'W'], [15]);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.equal(action.wildAs[softTwo.find(card => card.wild).id], 15);
  assert.equal(fixture.currentPlay.combination.bombKind, 'soft');
  assert.equal(fixture.currentPlay.combination.rank, 15);
  await screenshot('wildcard-soft-two.png');
  checks.push('three twos plus wildcard automatically form a soft two bomb when following a single two');

  await readyFixture('single-wild-forbidden', ['W']);
  before = count(); await clickPlay();
  await page.getByRole('status').filter({ hasText: /不能单出|无法组成能出的牌型/ }).waitFor();
  assert.equal(count(), before);
  assert.equal(await page.locator('.wild-options').count(), 0);
  checks.push('a selected lone wildcard cannot be played and sends no server action');

  await readyFixture('only-wild-can-pass', ['W']);
  fixture.players.find(player => player.id === 'self').hand = fixture.players.find(player => player.id === 'self').hand.filter(card => card.wild);
  fixture.version++; publish();
  await page.waitForFunction(() => window.__wildView.hand.length === 1);
  await page.locator('.empty-center').filter({ hasText: '只剩赖子，可以不出。' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '不出', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '提示', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '可以不出，交给下家领出' }).waitFor();
  await page.getByRole('button', { name: '不出', exact: true }).click();
  await page.waitForFunction(() => window.__wildView.turnId !== 'self');
  assert.equal(fixture.phase, 'playing');
  assert.equal(fixture.currentPlay, null);
  checks.push('with only a wildcard and an empty table, the UI explains the rule and can pass the lead to the next player');

  const highStraight = await readyFixture('straight-two-forbidden', [11, 12, 13, 14, 'W']);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.equal(action.wildAs[highStraight.find(card => card.wild).id], 10);
  assert.deepEqual(fixture.currentPlay.cards.map(card => card.wild ? action.wildAs[card.id] : card.rank).sort((a, b) => a - b), [10, 11, 12, 13, 14]);
  checks.push('JQKA plus wildcard remains a ten-to-ace straight and never substitutes two in a sequence');

  const multiple = await readyFixture('two-wildcards', [4, 5, 8, 'W', 'W']);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.deepEqual(Object.values(action.wildAs).sort((a, b) => a - b), [6, 7]);
  assert.equal(Object.keys(action.wildAs).length, multiple.filter(card => card.wild).length);
  checks.push('two wildcard identities receive automatic 6 and 7 declarations and are accepted by Game');

  const bomb = await readyFixture('soft-bomb-choice', [7, 7, 7, 'W']);
  before = count(); await clickPlay();
  await page.getByRole('button', { name: /^软炸弹 7/ }).waitFor();
  assert.equal(count(), before, 'a bomb versus three-with-one choice is not guessed');
  await page.getByRole('button', { name: /^软炸弹 7/ }).click();
  action = await acceptedSince(before);
  assert.equal(action.wildAs[bomb.find(card => card.wild).id], 7);
  assert.equal(fixture.currentPlay.combination.bombKind, 'soft');
  assert.equal(fixture.multiplier, 6);
  await screenshot('wildcard-soft-bomb.png');
  checks.push('three sevens plus wildcard offer a soft bomb and the chosen bomb doubles the real Game multiplier');

  const forcedBomb = await readyFixture('soft-bomb-automatic', [3, 3, 3, 'W'], [15]);
  before = count(); await clickPlay(); action = await acceptedSince(before);
  assert.equal(action.wildAs[forcedBomb.find(card => card.wild).id], 3);
  assert.equal(fixture.currentPlay.combination.bombKind, 'soft');
  assert.equal(await page.locator('.wild-options').count(), 0);
  checks.push('three threes plus wildcard automatically bomb a single two without a manual declaration');

  await readyFixture('soft-cannot-beat-hard', [14, 14, 14, 'W'], [3, 3, 3, 3]);
  before = count(); await clickPlay();
  await page.getByRole('status').filter({ hasText: '这些牌无法组成能出的牌型' }).waitFor();
  assert.equal(count(), before);
  checks.push('a soft ace bomb cannot beat a hard three bomb or send an invalid play request');

  const changed = await readyFixture('selection-change', [4, 5, 6, 7, 'W']);
  before = count(); await clickPlay(); await page.locator('.wild-options').waitFor({ state: 'visible' });
  await page.locator(`[data-card-id="${changed[0].id}"]`).click({ position: { x: 5, y: 45 } });
  await page.locator('.wild-options').waitFor({ state: 'detached' });
  assert.equal(count(), before);
  checks.push('changing selected cards cancels old wildcard choices without submitting stale candidates');

  await ambiguous('right-click-three', 3, true);
  checks.push('right-click opens the same nonmodal ambiguity choices and submits only the chosen option');
  assert.equal(await page.locator('select,.wild-picker').count(), 0);
  checks.push('no manual wildcard rank selector remains in the playing UI');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', checks, errors, acceptedPlays: plays.filter(play => play.accepted).length }, null, 2));
} catch (error) {
  errors.push(error.stack || String(error)); process.exitCode = 1;
  await screenshot('wildcard-failure.png').catch(() => {});
  console.error(JSON.stringify({ result: 'failed', checks, errors }, null, 2));
} finally {
  await writeFile(new URL('wildcard-playtest-report.json', output), JSON.stringify({ result: errors.length ? 'failed' : 'passed', checks, errors, plays }, null, 2));
  await browser.close();
  await staticServer.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => transport.close(resolve));
}
