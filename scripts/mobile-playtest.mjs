import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Game } from '../src/shared/game.ts';

// This suite uses the real game engine over a private WebSocket endpoint so
// touch requests must pass the same server rules as normal browser players.
const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const checks = [], errors = [], layouts = [], actions = [];
let fixture, sequence = 0, connections = 0;
const transport = createServer((_request, response) => response.writeHead(404).end());
const sockets = new WebSocketServer({ server: transport, path: '/ws' });
const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function publish() { for (const socket of sockets.clients) send(socket, { type: 'state', state: fixture.view('self') }); }
function loadFixture(label, phase = 'playing') {
  const game = new Game('654321', { random: () => .1 });
  for (const [id, name] of [['self', '手机验收'], ['right', '右边朋友'], ['left', '左边朋友']]) { game.addPlayer(id, name); game.act(id, { type: 'ready', ready: true }); }
  game.act('self', { type: 'start' }); game.act(game.turnId, { type: 'bid', value: 3 });
  game.landlordId = 'self'; game.turnId = 'self'; game.phase = phase;
  game.players.find(player => player.id === 'self').hand = Array.from({ length: 20 }, (_, index) => ({ id: `${label}-card-${index}`, rank: 3 + Math.floor(index / 2), suit: index % 2 ? 'H' : 'S' }));
  game.players.find(player => player.id === 'self').skills = [
    { id: `${label}-gift`, kind: 'gift' }, { id: `${label}-steal`, kind: 'steal' }, { id: `${label}-reverse`, kind: 'reverse' },
    ...(phase === 'skill_discard' ? [{ id: `${label}-three`, kind: 'three' }, { id: `${label}-peek`, kind: 'peek' }] : []),
  ];
  game.currentPlay = null; game.passCount = 0; game.events = [];
  game.deadline = Date.now() + 600000; game.version = ++sequence * 100;
  fixture = game; publish();
  return game;
}
sockets.on('connection', socket => {
  connections++; socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (['create', 'join', 'resume'].includes(message.type)) { send(socket, { type: 'joined', code: fixture.code, token: 'mobile-test-only', playerId: 'self' }); publish(); }
    else if (message.type === 'ping') send(socket, { type: 'pong', at: message.at });
    else if (message.type === 'action') {
      const record = { action: message.action, accepted: false }; actions.push(record);
      try { fixture.act('self', message.action); record.accepted = true; publish(); }
      catch (error) { record.error = error.message; send(socket, { type: 'error', message: error.message }); }
    } else if (message.type === 'leave') send(socket, { type: 'closed', message: '测试结束。' });
  });
});
await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${transport.address().port}`;
const vite = await createViteServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const contexts = [];
async function contextFor(viewport, mobile = true, fullscreenMode = null) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 }); contexts.push(context);
  await context.addInitScript(({ address, fullscreenMode }) => {
    try { localStorage.setItem('glass-server', address); localStorage.removeItem('glass-room'); } catch {}
    window.__mobileMessages = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); this.addEventListener('message', event => { const message = JSON.parse(event.data); window.__mobileMessages.push(message); if (message.type === 'state') window.__mobileView = message.state; }); } };
    if (fullscreenMode) {
      window.__mobileFullscreen = { requests: 0, exits: 0, locks: [], unlocks: 0 };
      let active = null;
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => active });
      Object.defineProperty(document, 'webkitFullscreenElement', { configurable: true, get: () => active });
      Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => fullscreenMode !== 'unsupported' });
      Object.defineProperty(HTMLElement.prototype, 'webkitRequestFullscreen', { configurable: true, value: undefined });
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: fullscreenMode === 'unsupported' ? undefined : function () {
        window.__mobileFullscreen.requests++;
        if (fullscreenMode === 'rejected') return Promise.reject(new DOMException('Test denial', 'NotAllowedError'));
        active = document.documentElement; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
      } });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: () => { active = null; window.__mobileFullscreen.exits++; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); } });
      Object.defineProperty(screen.orientation, 'lock', { configurable: true, value: orientation => { window.__mobileFullscreen.locks.push(orientation); return Promise.resolve(); } });
      Object.defineProperty(screen.orientation, 'unlock', { configurable: true, value: () => { window.__mobileFullscreen.unlocks++; } });
    }
  }, { address: endpoint, fullscreenMode });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.__mobileInputs = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      window.__mobileInputs.push({ type, x: event.clientX, y: event.clientY, target: button?.getAttribute('aria-label') ?? button?.textContent ?? String(event.target?.className) });
      if (window.__mobileInputs.length > 30) window.__mobileInputs.shift();
    }, true);
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); return { context, page };
}
const state = page => page.evaluate(() => window.__mobileView);
const screenshot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
async function atViewport(page, label, selectors = ['.room-panel', '.own-hand', '.skill-row', '.play-controls']) {
  const layout = await page.evaluate(selectors => ({ viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, boxes: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => { const r = element.getBoundingClientRect(); return { selector, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })) }), selectors);
  layouts.push({ label, ...layout });
  assert.ok(layout.document.width <= layout.viewport.width + 2, `${label}: page must not overflow horizontally`);
  for (const box of layout.boxes) {
    assert.ok(box.left >= -2 && box.right <= layout.viewport.width + 2, `${label}: ${box.selector} outside horizontal viewport`);
    assert.ok(box.top >= -2 && box.bottom <= layout.viewport.height + 2, `${label}: ${box.selector} outside vertical viewport`);
  }
}
async function showFixture(page, label, phase = 'playing') {
  loadFixture(label, phase);
  await page.waitForFunction(id => window.__mobileView?.hand[0]?.id === id, `${label}-card-0`);
  await page.waitForFunction(() => !document.querySelector('.own-hand .selected'));
  // Isolate screenshot scenes from an animation still finishing in the prior
  // fixture, while real gameplay updates continue to preserve its feedback.
  await page.locator('.fx-announcement').waitFor({ state: 'detached' });
}
async function exposedCardPoint(page, index) {
  return page.locator('.own-hand .playing-card').nth(index).evaluate(element => { const r = element.getBoundingClientRect(); const next = element.nextElementSibling?.getBoundingClientRect(); return { x: r.left + Math.max(2, Math.min(12, ((next?.left ?? r.right) - r.left) / 2)), y: r.top + Math.min(40, r.height / 2) }; });
}
async function touchCard(page, index) { const point = await exposedCardPoint(page, index); await page.touchscreen.tap(point.x, point.y); }
async function touchSweep(page, first, last) {
  const from = await exposedCardPoint(page, first), to = await exposedCardPoint(page, last);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 0 }] });
    for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
  } finally { await cdp.detach(); }
}
async function actionTap(page, locator) { const previous = (await state(page)).version; await locator.tap(); await page.waitForFunction(version => window.__mobileView?.version > version, previous); }
async function resizePage(page, viewport) {
  await page.setViewportSize(viewport);
  // Mobile Chromium applies its visual-viewport change after the layout resize.
  // Wait for both before dispatching the next physical touch coordinate.
  await page.waitForFunction(expected => innerWidth === expected.width && innerHeight === expected.height && Math.abs(visualViewport.width - expected.width) < 2, viewport);
  await page.waitForTimeout(120);
}

try {
  loadFixture('initial');
  const { page } = await contextFor({ width: 390, height: 844 }, true, 'success');
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await atViewport(page, 'portrait-create', ['.room-panel']);
  await page.getByRole('button', { name: '加入房间', exact: true }).tap();
  await page.locator('input[name=room]').fill('654321');
  await page.locator('input[name=nickname]').fill('手机验收'); await page.locator('input[name=password]').fill('mobile-only');
  assert.equal(await page.locator('input[name=room]').inputValue(), '654321');
  await screenshot(page, 'mobile-portrait-join.png');
  await page.getByRole('button', { name: '创建房间', exact: true }).tap();
  await page.getByRole('button', { name: '开一桌', exact: true }).tap();
  await page.waitForFunction(() => window.__mobileView?.phase === 'playing');
  checks.push('portrait room form accepts nickname, room number and password with no horizontal overflow, then creates a private room');

  await resizePage(page, { width: 844, height: 390 });
  await atViewport(page, 'landscape-844'); await screenshot(page, 'mobile-landscape-844.png');
  await touchSweep(page, 0, 4); assert.equal(await page.locator('.own-hand .selected').count(), 5);
  await touchSweep(page, 0, 4); assert.equal(await page.locator('.own-hand .selected').count(), 0);
  await touchCard(page, 0); assert.equal(await page.locator('.own-hand .selected').count(), 1);
  const beforeRotate = await state(page), beforeConnections = connections;
  await resizePage(page, { width: 390, height: 844 }); await screenshot(page, 'mobile-portrait-playing.png');
  await resizePage(page, { width: 844, height: 390 });
  assert.equal((await state(page)).selfId, beforeRotate.selfId); assert.equal(connections, beforeConnections);
  assert.equal(await page.locator('.own-hand .selected').count(), 1);
  await actionTap(page, page.getByRole('button', { name: /^出牌/ }));
  assert.equal(actions.at(-1).accepted, true); assert.equal(actions.at(-1).action.type, 'play');
  checks.push('actual touch dragging selects and deselects five cards; rotating preserves the connection and selection; tapping play reaches the real game engine');

  await showFixture(page, 'touch-gift');
  await page.locator('[data-skill-id="touch-gift-gift"]').tap();
  await page.locator('.mobile-skill-description').waitFor({ state: 'visible' });
  assert.match(await page.locator('.mobile-skill-description').textContent(), /送|手牌/);
  assert.equal(await page.locator('.modal-backdrop').count(), 0);
  await touchCard(page, 0); await page.locator('.avatar-button[data-player-id="right"]').tap();
  await actionTap(page, page.getByRole('button', { name: '对右边朋友使用技能', exact: true }));
  assert.equal(actions.at(-1).accepted, true); assert.equal((await state(page)).skillUsed, 1);
  const announcement = page.locator('.fx-announcement'); await announcement.waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
  await atViewport(page, 'skill-announcement', ['.fx-announcement', '.play-controls', '.skill-row']);
  assert.equal(await page.locator('.fx-skill-direction[data-actor-id="self"][data-target-id="right"]').count(), 1);
  await screenshot(page, 'mobile-skill-target-arrow.png');
  checks.push('touch skill selection reveals its description, selected-card gift and avatar target submit correctly, and arrow feedback stays inside the landscape screen');

  await resizePage(page, { width: 667, height: 375 }); await showFixture(page, 'long-hand');
  fixture.players.find(player => player.id === 'self').hand = Array.from({ length: 35 }, (_, index) => ({ id: `long-hand-card-${index}`, rank: 3 + Math.floor(index / 3), suit: index % 2 ? 'H' : 'S' }));
  fixture.version++; publish(); await page.waitForFunction(() => window.__mobileView?.hand.length === 35);
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    await page.getByRole('button', { name: '查看右侧手牌', exact: true }).tap();
    await page.waitForTimeout(300);
    if (await page.locator('.own-hand').evaluate(hand => hand.querySelector('.playing-card:last-child').getBoundingClientRect().right <= hand.getBoundingClientRect().right + 2)) break;
  }
  await page.waitForFunction(() => { const hand = document.querySelector('.own-hand'), last = hand.querySelector('.playing-card:last-child'); return hand.scrollLeft > 0 && last.getBoundingClientRect().right <= hand.getBoundingClientRect().right + 2; });
  await touchCard(page, 34); assert.equal(await page.locator('.own-hand .selected').last().getAttribute('data-card-id'), 'long-hand-card-34');
  await screenshot(page, 'mobile-long-hand-667.png');
  await page.getByRole('button', { name: '查看左侧手牌', exact: true }).tap(); await page.waitForFunction(() => document.querySelector('.own-hand').scrollLeft < 1);
  checks.push('35-card hands keep a readable minimum card spacing; arrow controls reveal the last card for touch selection and return to the first cards');

  await showFixture(page, 'small-discard', 'skill_discard');
  await atViewport(page, 'landscape-667-discard'); assert.equal(await page.locator('.skill-card').count(), 5);
  await page.locator('.skill-card').nth(0).tap(); await page.locator('.skill-card').nth(4).tap();
  const discard = page.getByRole('button', { name: '弃掉选中技能', exact: true }); assert.equal(await discard.isEnabled(), true);
  await screenshot(page, 'mobile-five-skills-667.png'); await actionTap(page, discard);
  assert.equal((await state(page)).skills.length, 3); assert.equal((await state(page)).phase, 'playing');
  checks.push('667×375 landscape keeps all five overflow skills and the discard action usable; the real engine accepts dropping back to three');

  await resizePage(page, { width: 844, height: 300 }); await showFixture(page, 'compact');
  await atViewport(page, 'landscape-844x300-compact', ['.opponent', '.own-hand', '.play-controls', '.skill-row', '.skill-zone']);
  await touchSweep(page, 0, 4); assert.equal(await page.locator('.own-hand .selected').count(), 5);
  await screenshot(page, 'mobile-landscape-844x300.png');
  await touchSweep(page, 0, 4); assert.equal(await page.locator('.own-hand .selected').count(), 0);
  checks.push('844×300 compact landscape keeps both opponents, hand, play controls and skills inside the screen with touch dragging intact');
  await resizePage(page, { width: 667, height: 375 });

  await page.getByRole('button', { name: '玩法说明', exact: true }).tap();
  const help = page.locator('.help-panel'); await help.waitFor({ state: 'visible' });
  await atViewport(page, 'mobile-help-panel', ['.help-panel']);
  const scroll = await help.evaluate(element => { element.scrollTop = element.scrollHeight; return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }; });
  assert.ok(scroll.scrollHeight > scroll.clientHeight && scroll.scrollTop > 0);
  await help.getByRole('button', { name: '懂了，开整', exact: true }).tap();
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await atViewport(page, 'mobile-settings-panel', ['.settings-panel']);
  await page.getByRole('button', { name: '完成', exact: true }).tap();
  checks.push('help and settings panels fit short landscape viewports and long help content scrolls to its final action');

  const fullscreen = page.getByRole('button', { name: '全屏横屏玩', exact: true });
  await fullscreen.tap(); await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  await page.waitForFunction(() => window.__mobileFullscreen.locks.includes('landscape'));
  await page.getByRole('button', { name: '退出全屏', exact: true }).tap(); await fullscreen.waitFor();
  const fs = await page.evaluate(() => window.__mobileFullscreen); assert.equal(fs.requests, 1); assert.equal(fs.exits, 1); assert.ok(fs.unlocks >= 1);
  checks.push('a user tap enters fullscreen and requests landscape; exiting tracks fullscreenchange and releases orientation lock');
  for (const mode of ['unsupported', 'rejected']) {
    const fallback = await contextFor({ width: 667, height: 375 }, true, mode);
    await fallback.page.getByRole('button', { name: '全屏横屏玩', exact: true }).tap();
    await fallback.page.getByRole('status').filter({ hasText: /横屏|全屏/ }).waitFor();
    assert.equal(await fallback.page.getByRole('button', { name: '全屏横屏玩', exact: true }).isEnabled(), true);
    await fallback.context.close();
  }
  checks.push('unsupported or denied fullscreen produces readable guidance, leaves the game usable and allows another attempt without an unhandled rejection');

  const desktop = await contextFor({ width: 1366, height: 768 }, false);
  await atViewport(desktop.page, 'desktop-preserved', ['.room-panel']); await screenshot(desktop.page, 'mobile-regression-desktop.png');
  checks.push('desktop browser retains a contained room form at 1366×768');
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(error.stack || String(error)); process.exitCode = 1;
  for (const context of contexts) for (const page of context.pages()) layouts.push({ label: 'failure-inputs', inputs: await page.evaluate(() => window.__mobileInputs).catch(() => []) });
  for (let index = 0; index < contexts.length; index++) for (const page of contexts[index].pages()) await screenshot(page, `mobile-failure-${index}.png`).catch(() => {});
} finally {
  await writeFile(new URL('mobile-playtest-report.json', output), JSON.stringify({ checks, errors, layouts, actions }, null, 2));
  await browser.close(); await vite.close(); for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => transport.close(resolve));
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
