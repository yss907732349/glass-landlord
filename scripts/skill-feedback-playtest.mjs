import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Game } from '../src/shared/game.ts';
import { SKILLS } from '../src/shared/skills.ts';

const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const checks = [], errors = [];
const game = new Game('654321', { random: () => .1 });
for (const [id, name] of [['self', '自己'], ['right', '右边朋友'], ['left', '左边朋友']]) { game.addPlayer(id, name); game.act(id, { type: 'ready', ready: true }); }
game.act('self', { type: 'start' }); game.act(game.turnId, { type: 'bid', value: 3 });
game.turnId = 'self'; game.phase = 'playing'; game.deadline = Date.now() + 600000;
game.events = [];
let sequence = 0;
const transport = createServer((_request, response) => response.writeHead(404).end());
const sockets = new WebSocketServer({ server: transport, path: '/ws' });
const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function publish() { for (const socket of sockets.clients) send(socket, { type: 'state', state: game.view('self') }); }
function event(kind, actorId, targetId) {
  const record = { id: `feedback-${++sequence}`, type: 'skill', skillKind: kind, actorId, ...(targetId ? { targetId } : {}), at: Date.now() };
  game.events.push(record); game.version++; publish(); return record;
}
sockets.on('connection', socket => {
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'create') { send(socket, { type: 'joined', code: game.code, token: 'test-only', playerId: 'self' }); publish(); }
    else if (message.type === 'ping') send(socket, { type: 'pong', at: message.at });
    else if (message.type === 'leave') send(socket, { type: 'closed', message: '测试结束。' });
  });
});
await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${transport.address().port}`;
const vite = await createViteServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await context.addInitScript(address => {
  try { localStorage.setItem('glass-server', address); localStorage.removeItem('glass-room'); } catch {}
  const Native = window.WebSocket;
  window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('message', event => { try { const value = JSON.parse(event.data); if (value.type === 'state') window.__feedbackView = value.state; } catch {} }); } };
}, endpoint);
const page = await context.newPage(); page.setDefaultTimeout(10000);
page.on('pageerror', error => errors.push(error.message));
const screenshot = name => page.screenshot({ path: fileURLToPath(new URL(name, output)), omitBackground: true });
async function feedback(kind, actor, target) {
  const record = event(kind, actor, target);
  const effect = page.locator(`.skill-fx[data-event-id="${record.id}"]`);
  await effect.locator('.fx-announcement').waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  return { effect, record, announcement: effect.locator('.fx-announcement') };
}
async function anchor(id) {
  return page.evaluate(id => {
    const table = document.querySelector('.table-shell').getBoundingClientRect();
    const element = id === 'self' ? document.querySelector('.own-heading') : document.querySelector(`.avatar-button[data-player-id="${id}"]`);
    const box = element.getBoundingClientRect();
    return { x: (box.x + box.width / 2 - table.x) * 1080 / table.width, y: (box.y + box.height / 2 - table.y) * 560 / table.height };
  }, id);
}
async function assertArrow(effect, actor, target) {
  const arrow = effect.locator(`.fx-skill-direction[data-actor-id="${actor}"][data-target-id="${target}"]`);
  assert.equal(await arrow.count(), 1);
  const from = await anchor(actor), to = await anchor(target);
  const actual = await arrow.evaluate(element => ({ from: { x: Number(element.dataset.fromX), y: Number(element.dataset.fromY) }, to: { x: Number(element.dataset.toX), y: Number(element.dataset.toY) }, marker: element.querySelector('.fx-direction-track').getAttribute('marker-end') }));
  for (const [point, expected] of [[actual.from, from], [actual.to, to]]) { assert.ok(Math.abs(point.x - expected.x) < .01); assert.ok(Math.abs(point.y - expected.y) < .01); }
  assert.ok(actual.marker.startsWith('url(#skill-arrow-'));
}
try {
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.locator('input[name=nickname]').fill('自己'); await page.locator('input[name=password]').fill('test-only');
  await page.getByRole('button', { name: '开一桌', exact: true }).click(); await page.waitForFunction(() => window.__feedbackView?.phase === 'playing');
  for (const [actor, target] of [['self', 'right'], ['self', 'left'], ['left', 'right'], ['right', 'self']]) {
    const { effect, announcement } = await feedback('steal', actor, target);
    await assertArrow(effect, actor, target);
    assert.equal(await announcement.locator('strong').textContent(), '顺手牵羊');
    assert.equal(await announcement.locator('p').textContent(), SKILLS.find(skill => skill.kind === 'steal').description);
    const route = await announcement.locator('.fx-announcement-route').textContent();
    assert.ok(route.includes(game.players.find(player => player.id === actor).name)); assert.ok(route.includes(game.players.find(player => player.id === target).name));
    const rect = await announcement.boundingBox(), table = await page.locator('.table-shell').boundingBox();
    assert.ok(Math.abs(rect.x + rect.width / 2 - table.x - table.width / 2) < 1);
  }
  checks.push('self/right/left targeted skills always draw caster-to-target arrows anchored to real nameplate or avatar centers and show the correct names and description centrally');
  let current = await feedback('steal', 'self', 'left');
  await screenshot('skill-feedback-targeted.png');
  await page.locator('.own-hand .playing-card').first().click({ position: { x: 5, y: 45 } });
  assert.equal(await page.locator('.own-hand .selected').count(), 1);
  assert.equal(await page.locator('.table-effects').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  assert.equal(await current.announcement.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  assert.equal(await current.effect.locator('.fx-flight').count(), 1);
  checks.push('arrow and announcement do not intercept card selection, and the existing transfer flight remains');
  current = await feedback('wild', 'self');
  assert.equal(await current.effect.locator('.fx-skill-direction').count(), 0);
  assert.equal(await current.announcement.getAttribute('data-target-id'), 'self');
  assert.match(await current.announcement.locator('.fx-announcement-route').textContent(), /自己→自己/);
  checks.push('self-only wildcard skill identifies its caster and self target without inventing an opponent arrow');
  current = await feedback('reverse', 'left');
  assert.equal(await current.effect.locator('.fx-skill-direction').count(), 2);
  await assertArrow(current.effect, 'left', 'self'); await assertArrow(current.effect, 'left', 'right');
  assert.match(await current.announcement.locator('.fx-announcement-route').textContent(), /左边朋友→全场/);
  checks.push('global reverse skill clearly points from its caster to both other seats and labels the effect as whole-table');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings-panel input[type=range]').nth(1).fill('35');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  current = await feedback('gift', 'right', 'left');
  await assertArrow(current.effect, 'right', 'left');
  const geometry = await current.announcement.evaluate(element => ({ width: element.getBoundingClientRect().width, font: parseFloat(getComputedStyle(element.querySelector('p')).fontSize), scale: new DOMMatrix(getComputedStyle(element).transform).a, tableScale: document.querySelector('.table-shell').getBoundingClientRect().width / 1080 }));
  assert.ok(geometry.font * geometry.scale * geometry.tableScale >= 8.3);
  const announcementRect = await current.announcement.boundingBox(), tableRect = await page.locator('.table-shell').boundingBox();
  assert.ok(announcementRect.x >= tableRect.x && announcementRect.x + announcementRect.width <= tableRect.x + tableRect.width);
  await screenshot('skill-feedback-scale-35.png');
  checks.push('at 35% table scale the central description compensates its text size, stays within the table and keeps arrow endpoints aligned');
  for (let i = 0; i < 6; i++) game.events.push({ id: `feedback-play-${++sequence}`, type: 'play', actorId: 'self', count: 1, at: Date.now() });
  game.version++; publish();
  await page.waitForTimeout(300);
  assert.equal(await current.announcement.isVisible(), true);
  assert.equal(await page.locator('.fx-announcement').count(), 1);
  checks.push('rapid ordinary plays keep the latest skill explanation visible without stacking multiple central announcements');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  current = await feedback('peek', 'self', 'right');
  assert.equal(await current.effect.locator('.fx-skill-direction').evaluate(element => getComputedStyle(element).opacity), '1');
  assert.equal(await current.effect.locator('.fx-direction-pulse').evaluate(element => getComputedStyle(element).display), 'none');
  await current.announcement.waitFor({ state: 'detached' });
  checks.push('reduced motion retains static direction and readable explanation, removes the moving pulse, and feedback expires automatically');
  assert.deepEqual(errors, []);
} catch (error) { errors.push(error.stack || String(error)); await screenshot('skill-feedback-failure.png').catch(() => {}); process.exitCode = 1; }
finally { await writeFile(new URL('skill-feedback-playtest-report.json', output), JSON.stringify({ checks, errors }, null, 2)); await browser.close(); await vite.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => transport.close(resolve)); console.log(JSON.stringify({ checks, errors }, null, 2)); }
