import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game } from '../src/shared/game.ts';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(project, 'artifacts'); await mkdir(output, { recursive: true });
const packaged = process.argv.includes('--packaged'), baseline = process.argv.includes('--baseline-only');
const scaleFactor = Number(process.argv.find(value => value.startsWith('--scale-factor='))?.split('=')[1] || 1);
assert.ok(Number.isFinite(scaleFactor) && scaleFactor > 0 && scaleFactor <= 3);
const label = `${packaged ? 'packaged' : 'source'}${baseline ? '-baseline' : ''}${scaleFactor !== 1 ? `-scale-${scaleFactor}` : ''}`;
const profile = await mkdtemp(path.join(output, `desktop-stability-${label}-profile-`));
const report = { mode: label, profile, simulatedDeviceScaleFactor: scaleFactor !== 1 ? scaleFactor : null, checks: [], violations: [], errors: [], phases: [] };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, input, fixture, handle;
const python = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
function nativeState() {
  if (process.platform !== 'win32' || !handle) return null;
  return JSON.parse(execFileSync(python, ['-c', 'import ctypes,json,sys\nu=ctypes.windll.user32\nh=ctypes.c_void_p(int(sys.argv[1]))\nu.GetWindowLongPtrW.restype=ctypes.c_ssize_t\nprint(json.dumps({"visible":bool(u.IsWindowVisible(h)),"minimized":bool(u.IsIconic(h)),"topmost":bool(u.GetWindowLongPtrW(h,-20)&8)}))', handle], { encoding: 'utf8' }));
}
const transport = createServer((_request, response) => response.writeHead(404).end());
const sockets = new WebSocketServer({ server: transport, path: '/ws' });
const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function publish() { for (const socket of sockets.clients) send(socket, { type: 'state', state: fixture.view('self') }); }
function resetFixture() {
  const game = new Game('654321', { random: () => .1 });
  for (const [id, name] of [['self', '交互验收'], ['other-a', '目标甲'], ['other-b', '目标乙']]) { game.addPlayer(id, name); game.act(id, { type: 'ready', ready: true }); }
  game.act('self', { type: 'start' }); game.act(game.turnId, { type: 'bid', value: 3 });
  const self = game.players.find(player => player.id === 'self');
  self.hand = Array.from({ length: 10 }, (_, index) => ({ id: `stable-card-${index}`, rank: index + 3, suit: 'S' }));
  self.skills = [{ id: 'stable-steal', kind: 'steal' }, { id: 'stable-gift', kind: 'gift' }, { id: 'stable-reverse', kind: 'reverse' }];
  game.landlordId = 'self'; game.turnId = 'self'; game.phase = 'playing'; game.currentPlay = null; game.passCount = 0; game.deadline = Date.now() + 600000;
  fixture = game;
}
resetFixture();
sockets.on('connection', socket => {
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'create' || message.type === 'resume') { send(socket, { type: 'joined', code: fixture.code, token: 'test-only-token', playerId: 'self' }); publish(); }
    else if (message.type === 'ping') send(socket, { type: 'pong', at: message.at });
    else if (message.type === 'action') { try { fixture.act('self', message.action); publish(); } catch (error) { send(socket, { type: 'error', message: error.message }); } }
    else if (message.type === 'leave') send(socket, { type: 'closed', message: '测试结束。' });
  });
});
await new Promise(resolve => transport.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${transport.address().port}`;
async function snapshot() {
  return app.evaluate(({ BrowserWindow }) => {
    const window = globalThis.__stabilityWindow || BrowserWindow.getAllWindows()[0];
    return { at: Date.now(), visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), topmost: window.isAlwaysOnTop(), frame: window.getContentBounds(), traceLength: globalThis.__stabilityTrace.length };
  });
}
async function traceSince(before) { return app.evaluate((_electron, start) => globalThis.__stabilityTrace.slice(start), before.traceLength); }
async function live() {
  const value = await snapshot();
  assert.equal(value.visible, true, 'ordinary interaction must not hide the window');
  assert.equal(value.minimized, false, 'ordinary interaction must not minimize the window');
  assert.equal(value.topmost, true, 'ordinary interaction must preserve the requested pin setting');
  return value;
}
async function settle(ms = 350) { await page.waitForTimeout(ms); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function screenPoint(locator, position) {
  await locator.scrollIntoViewIfNeeded(); const rect = await locator.boundingBox(); assert.ok(rect);
  const frame = await snapshot();
  return { x: frame.frame.x + rect.x + (position?.x ?? rect.width / 2), y: frame.frame.y + rect.y + (position?.y ?? rect.height / 2) };
}
async function at(type, point, buttons = 0, button = 'left') {
  const frame = (await snapshot()).frame;
  const event = { type, x: point.x - frame.x, y: point.y - frame.y, button: type === 'mouseMoved' ? 'none' : button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 };
  report.inputRequests ||= []; report.inputRequests.push({ at: Date.now(), ...event });
  await input.send('Input.dispatchMouseEvent', event);
}
async function click(locator, position, hold = 20) {
  const point = await screenPoint(locator, position); await at('mouseMoved', point); await at('mousePressed', point, 1);
  await page.waitForTimeout(hold); await live(); await at('mouseReleased', point); await page.waitForTimeout(25); await live();
}
async function phase(name, execute, ordinary = true, expectedRendererCrash = false) {
  await settle(); const before = await live(); before.native = nativeState(); const failures = [];
  try { await execute(); if (!expectedRendererCrash) await settle(); await live(); } catch (error) { failures.push(error.stack || String(error)); }
  const events = await traceSince(before), after = await snapshot(); after.native = nativeState();
  if (before.native && (!before.native.visible || before.native.minimized || !before.native.topmost)) failures.push('Native HWND state was not visible, restored and pinned before the phase');
  if (after.native && (!after.native.visible || after.native.minimized || !after.native.topmost)) failures.push('Native HWND state lost visibility or the WS_EX_TOPMOST bit');
  if (ordinary) {
    const forbidden = events.filter(event => ['setAlwaysOnTop', 'setShape', 'setIgnoreMouseEvents', 'setBounds', 'hide', 'minimize', 'blur', 'closed', 'render-process-gone', 'unresponsive'].includes(event.name));
    if (forbidden.length) failures.push(`Ordinary interactions changed native state: ${JSON.stringify(forbidden)}`);
    if (JSON.stringify(before.frame) !== JSON.stringify(after.frame)) failures.push('Ordinary interaction changed native viewport bounds');
  } else {
    const forbidden = events.filter(event => ['hide', 'minimize', 'closed', ...(expectedRendererCrash ? [] : ['render-process-gone']), 'unresponsive'].includes(event.name));
    if (forbidden.length) failures.push(`Layout interactions changed visibility: ${JSON.stringify(forbidden)}`);
  }
  if (expectedRendererCrash && events.filter(event => event.name === 'render-process-gone').length !== 1) failures.push('The deliberate renderer crash must be observed exactly once');
  report.phases.push({ name, before, after, events, failures });
  if (failures.length) report.violations.push({ name, failures }); else report.checks.push(name);
}
async function dragLayout(locator, delta) {
  const start = await screenPoint(locator); await at('mouseMoved', start); await at('mousePressed', start, 1); await page.waitForTimeout(80);
  report.dragRequests ||= []; report.dragRequests.push({ start, delta });
  for (let step = 1; step <= 25; step++) { await at('mouseMoved', { x: start.x + delta.x * step / 25, y: start.y + delta.y * step / 25 }, 1); await page.waitForTimeout(15); await live(); }
  await at('mouseReleased', { x: start.x + delta.x, y: start.y + delta.y }); await settle();
}
async function stageCenter() {
  const rect = await page.locator('.table-shell').boundingBox(), frame = (await snapshot()).frame;
  return { x: frame.x + rect.x + rect.width / 2, y: frame.y + rect.y + rect.height / 2 };
}
try {
  app = await electron.launch({ executablePath: path.join(project, packaged ? 'release/win-unpacked/玻璃斗地主.exe' : 'node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : [project]), `--user-data-dir=${profile}`, ...(scaleFactor !== 1 ? [`--force-device-scale-factor=${scaleFactor}`] : [])], cwd: project, env });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.context().addInitScript(address => {
    localStorage.setItem('glass-server', address); localStorage.removeItem('glass-room');
    addEventListener('DOMContentLoaded', () => {
      const badge = document.createElement('div'); badge.textContent = '正在自动检查，请勿点击此窗口';
      badge.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647;pointer-events:none;background:#332500;color:#ffd77a;padding:3px 8px;border-radius:4px;font:15px sans-serif';
      document.body.append(badge);
    });
    window.__stabilityDocumentEvents = []; window.__stabilityPointer = [];
    for (const name of ['visibilitychange', 'pagehide', 'pointercancel', 'lostpointercapture', 'focus', 'blur']) addEventListener(name, event => window.__stabilityDocumentEvents.push({ at: Date.now(), name, hidden: document.hidden, target: event.target?.getAttribute?.('aria-label') || event.target?.className }), true);
    for (const name of ['pointerdown','pointermove','pointerup','click']) addEventListener(name,event=>{if(window.__stabilityPointer.length<3000)window.__stabilityPointer.push({at:Date.now(),name,x:event.clientX,y:event.clientY,sx:event.screenX,sy:event.screenY,buttons:event.buttons,trusted:event.isTrusted,target:event.target?.closest?.('button')?.getAttribute('aria-label')||event.target?.className});},true);
    const NativeSocket = window.WebSocket; window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); this.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'state') window.__stabilityView = message.state; }); } };
  }, endpoint);
  await page.reload(); await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  input = await page.context().newCDPSession(page);
  // Playwright may emulate focus for background renderer targets. Native focus
  // interruptions must exercise the same blur events as the desktop user.
  await input.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]; globalThis.__stabilityWindow = window; globalThis.__stabilityTrace = [];
    for (const name of ['setAlwaysOnTop', 'setShape', 'setIgnoreMouseEvents', 'setBounds', 'hide', 'show', 'minimize', 'restore', 'close']) {
      const original = window[name].bind(window); window[name] = (...args) => { globalThis.__stabilityTrace.push({ at: Date.now(), name, args }); return original(...args); };
    }
    for (const name of ['focus', 'blur', 'hide', 'show', 'minimize', 'restore', 'closed', 'unresponsive', 'always-on-top-changed', 'resize', 'move']) window.on(name, () => globalThis.__stabilityTrace.push({ at: Date.now(), name, event: true }));
    window.webContents.on('render-process-gone', (_event, details) => globalThis.__stabilityTrace.push({ at: Date.now(), name: 'render-process-gone', details }));
    window.webContents.on('ipc-message', (_event, channel, ...args) => { if (channel === 'window-control') globalThis.__stabilityTrace.push({ at: Date.now(), name: 'window-control', args }); });
    window.show(); window.focus();
  });
  handle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
  await settle(600);
  await page.waitForFunction(() => document.hasFocus());
  assert.equal((await snapshot()).focused, true, 'the owned window must have native focus before the input audit');
  report.environment = await app.evaluate(({ screen, BrowserWindow }) => ({ displays: screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor })), zoomFactor: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() }));
  report.environment.devicePixelRatio = await page.evaluate(() => devicePixelRatio);
  report.environment.layout = (await page.evaluate(() => window.desktop.info())).layout;
  report.version = await app.evaluate(({ app }) => app.getVersion());
  assert.equal(report.version, JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version);
  await phase('Repeated settings open/close preserves native visibility, z-order and frame', async () => {
    for (let index = 0; index < (baseline ? 3 : 8); index++) {
      await click(page.getByRole('button', { name: '设置', exact: true })); await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor();
      await click(page.getByRole('button', { name: '完成', exact: true })); await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor({ state: 'hidden' });
    }
  });
  if (!baseline) {
    await page.locator('input[name=nickname]').fill('交互验收'); await page.locator('input[name=password]').fill('test-only');
    await click(page.getByRole('button', { name: '开一桌', exact: true })); await page.waitForFunction(() => window.__stabilityView?.phase === 'playing'); await settle();
    await phase('Forty rapid skill selections and hovering never rebuild native input or z-order', async () => {
      const skill = page.locator('[data-skill-id="stable-steal"]');
      for (let index = 0; index < 20; index++) { await click(skill); assert.equal(await skill.getAttribute('aria-pressed'), 'true'); await click(skill); assert.equal(await skill.getAttribute('aria-pressed'), 'false'); }
    });
    await phase('Hand drag selects and deselects five cards without a native geometry transition', async () => {
      for (let round = 0; round < 4; round++) {
        const first = await screenPoint(page.locator('.own-hand .playing-card').nth(0), { x: 5, y: 45 });
        const last = await screenPoint(page.locator('.own-hand .playing-card').nth(4), { x: 5, y: 45 });
        await at('mouseMoved', first); await at('mousePressed', first, 1);
        for (let step = 1; step <= 12; step++) await at('mouseMoved', { x: first.x + (last.x - first.x) * step / 12, y: first.y }, 1);
        await page.waitForTimeout(250); await live(); await at('mouseReleased', last); await settle(30);
        assert.equal(await page.locator('.own-hand .selected').count(), round % 2 === 0 ? 5 : 0);
      }
    });
    await phase('Quick chat menu and bubble do not change native shape, z-order or frame', async () => {
      await click(page.getByRole('button', { name: '快捷聊天', exact: true })); assert.equal(await page.locator('.chat-phrase').count(), 5);
      await click(page.locator('.chat-phrase').first()); await page.locator('.chat-bubble.self-bubble').waitFor();
    });
    await phase('A real targeted skill animates and preserves normal input without a native rebuild', async () => {
      await click(page.locator('[data-skill-id="stable-steal"]')); await click(page.locator('[data-player-id="other-a"]'));
      await click(page.getByRole('button', { name: '对目标甲使用技能', exact: true }));
      await page.waitForFunction(() => !window.__stabilityView.skills.some(skill => skill.id === 'stable-steal'));
      assert.equal(fixture.turnId, 'self'); await page.waitForTimeout(2000);
    });
    await phase('A different primary pointer cannot replace or release the active preload pointer owner', async () => {
      const control = page.getByRole('button', { name: '设置', exact: true });
      const dispatch = (type, pointerId, pointerType, buttons) => control.evaluate((element, event) => element.dispatchEvent(new PointerEvent(event.type, { bubbles: true, composed: true, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true, button: 0, buttons: event.buttons })), { type, pointerId, pointerType, buttons });
      try {
        await dispatch('pointerdown', 701, 'mouse', 1);
        await page.waitForFunction(async () => (await window.desktop.info()).interaction.locked);
        await dispatch('pointerdown', 702, 'pen', 1); await dispatch('pointerup', 702, 'pen', 0); await dispatch('pointercancel', 702, 'pen', 0);
        assert.equal((await page.evaluate(() => window.desktop.info())).interaction.locked, true);
        await dispatch('pointerup', 701, 'mouse', 0);
        await page.waitForFunction(async () => !(await window.desktop.info()).interaction.locked);
      } finally { await dispatch('pointercancel', 701, 'mouse', 0); }
    });
    await phase('Locked layout handles cannot expand, move or resize the native input window', async () => {
      await click(page.getByRole('button', { name: '设置', exact: true }));
      await click(page.getByRole('checkbox', { name: '锁定布局，避免误拖', exact: true }));
      await click(page.getByRole('button', { name: '完成', exact: true }));
      try {
        const original = await stageCenter();
        for (const name of ['拖动整套界面', '右下角拖动缩放', '左上角拖动缩放']) {
          const handleButton = page.getByRole('button', { name, exact: true });
          assert.equal(await handleButton.isDisabled(), true);
          await dragLayout(handleButton, { x: 40, y: 20 });
          const info = await page.evaluate(() => window.desktop.info());
          assert.equal(info.interaction.locked, false); assert.equal(info.interaction.layoutGesture, false);
        }
        assert.deepEqual(await stageCenter(), original);
      } finally {
        await click(page.getByRole('button', { name: '设置', exact: true }));
        const checkbox = page.getByRole('checkbox', { name: '锁定布局，避免误拖', exact: true });
        if (await checkbox.isChecked()) await click(checkbox);
        await click(page.getByRole('button', { name: '完成', exact: true }));
      }
    });
    await phase('Cross-screen layout drag stays visible and reaches the requested absolute position', async () => {
      const layout = await page.evaluate(() => window.desktop.info()); report.crossScreen = [];
      const secondary = layout.layout.displays[1]?.workArea ?? layout.layout.primary;
      for (const next of [secondary, layout.layout.primary, secondary]) {
        const before = await stageCenter();
        const destination = { x: layout.layout.bounds.x + next.x + next.width / 2, y: layout.layout.bounds.y + next.y + next.height / 2 };
        await dragLayout(page.getByRole('button', { name: '拖动整套界面', exact: true }), { x: destination.x - before.x, y: destination.y - before.y });
        const after = await stageCenter(); report.crossScreen.push({ before, destination, after }); assert.ok(Math.abs(after.x - destination.x) < 4 && Math.abs(after.y - destination.y) < 4);
      }
    }, false);
    await phase('Corner resizing remains visible, then reset returns a usable stable frame', async () => {
      const before = await page.locator('.zoom-label').textContent(); await dragLayout(page.getByRole('button', { name: '右下角拖动缩放', exact: true }), { x: 60, y: 25 });
      assert.notEqual(await page.locator('.zoom-label').textContent(), before); await click(page.locator('.zoom-label')); await settle();
    }, false);
    await phase('Losing focus during a layout gesture contracts the desktop input area and cancels the old pointer', async () => {
      const desktop = (await page.evaluate(() => window.desktop.info())).layout.bounds;
      const start = await screenPoint(page.getByRole('button', { name: '拖动整套界面', exact: true }));
      await at('mouseMoved', start); await at('mousePressed', start, 1);
      await page.waitForFunction(async () => { const info = await window.desktop.info(); return info.interaction.layoutGesture && info.frame.width === info.layout.bounds.width; });
      await page.waitForTimeout(100);
      try {
        await app.evaluate(async ({ BrowserWindow }) => {
          const main = globalThis.__stabilityWindow, bounds = main.getBounds();
          const helper = new BrowserWindow({ width: 200, height: 70, x: bounds.x + 10, y: bounds.y + 10, frame: false, show: false, alwaysOnTop: true, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true } });
          globalThis.__stabilityFocusProbe = helper;
          await helper.loadURL('data:text/html;charset=utf-8,%3Cbody%20style%3D%22background%3A%2322262e%3Bcolor%3A%23ffd77a%3Bfont%3A12px%20sans-serif%22%3E%E8%87%AA%E5%8A%A8%E6%A3%80%E6%9F%A5%EF%BC%9A%E4%B8%B4%E6%97%B6%E7%84%A6%E7%82%B9%3C%2Fbody%3E');
          helper.show(); helper.focus();
        });
        await page.waitForFunction(() => !document.hasFocus()); await settle(450);
        assert.equal((await snapshot()).focused, false, 'the focus helper must cause real native focus loss');
        const stopped = await stageCenter(), info = await page.evaluate(() => window.desktop.info());
        assert.equal(info.interaction.locked, false); assert.equal(info.interaction.layoutGesture, false);
        assert.ok(info.frame.width < desktop.width, 'focus loss must release the desktop-sized native input window');
        await at('mouseMoved', { x: start.x + 280, y: start.y + 70 }, 1); await settle(80);
        const after = await stageCenter(); assert.ok(Math.abs(stopped.x - after.x) < 2 && Math.abs(stopped.y - after.y) < 2, 'the old pressed pointer must not keep moving the table after blur');
      } finally {
        await at('mouseReleased', { x: start.x + 280, y: start.y + 70 });
        await app.evaluate(() => { globalThis.__stabilityFocusProbe?.destroy(); globalThis.__stabilityFocusProbe = null; const window = globalThis.__stabilityWindow; window.show(); window.focus(); });
        await page.waitForFunction(() => document.hasFocus()); await settle();
        assert.equal((await snapshot()).focused, true, 'the owned window must regain native focus after the deliberate blur');
      }
    }, false);
    await phase('Post-layout settings and skill clicks remain stable', async () => {
      for (let index = 0; index < 4; index++) { await click(page.locator('[data-skill-id="stable-gift"]')); await click(page.locator('[data-skill-id="stable-gift"]')); }
      await click(page.getByRole('button', { name: '设置', exact: true })); await click(page.getByRole('button', { name: '完成', exact: true }));
    });
    await phase('Opening and dismissing the explicit window menu never hides the application', async () => {
      for (let index = 0; index < 4; index++) {
        await click(page.getByRole('button', { name: '窗口菜单', exact: true })); await page.getByRole('menu', { name: '窗口操作' }).waitFor();
        const row = await page.getByRole('menuitem', { name: /隐藏牌局/ }).boundingBox(); assert.ok(row.height >= 35);
        await click(page.getByRole('button', { name: '窗口菜单', exact: true })); assert.equal(await page.getByRole('menu', { name: '窗口操作' }).count(), 0);
      }
    });
    await phase('At minimum UI scale window actions keep usable hit targets and opening the menu does not hide', async () => {
      await click(page.getByRole('button', { name: '设置', exact: true }));
      await page.locator('.settings-panel input[type=range]').nth(1).evaluate(element => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '35'); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
      await click(page.getByRole('button', { name: '完成', exact: true })); await settle();
      assert.equal(await page.locator('.zoom-label').textContent(), '35%'); await click(page.getByRole('button', { name: '窗口菜单', exact: true }));
      const row = await page.getByRole('menuitem', { name: /隐藏牌局/ }).boundingBox(); assert.ok(row.height >= 35);
      await click(page.getByRole('button', { name: '窗口菜单', exact: true })); await live(); await click(page.locator('.zoom-label')); await settle();
    }, false);
    await phase('Browser zoom shortcuts and Ctrl-wheel do not alter Chromium zoom or input coordinates', async () => {
      const zoom = await page.locator('.zoom-label').textContent();
      await page.keyboard.press('Control+-'); await page.keyboard.press('Control+='); await page.keyboard.press('Control+0');
      const point = await screenPoint(page.locator('.zoom-label')), frame = (await snapshot()).frame;
      await input.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x - frame.x, y: point.y - frame.y, deltaX: 0, deltaY: -120, modifiers: 2 });
      await settle(); assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1);
      assert.equal(await page.locator('.zoom-label').textContent(), zoom);
    });
    const beforeHide = await snapshot();
    const windowMenuButton = page.getByRole('button', { name: '窗口菜单', exact: true });
    if (await windowMenuButton.getAttribute('aria-expanded') !== 'true') await click(windowMenuButton);
    const hidePoint = await screenPoint(page.getByRole('menuitem', { name: /隐藏牌局/ })); await at('mouseMoved', hidePoint); await at('mousePressed', hidePoint, 1); await at('mouseReleased', hidePoint);
    await page.waitForTimeout(250); assert.equal((await snapshot()).visible, false);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); }); await settle(); await live();
    report.phases.push({ name: 'Explicit hide and restore', events: await traceSince(beforeHide) }); report.checks.push('Only an explicit hide command hides the window and restore keeps it usable');
    await phase('Clicks after restoring a hidden window remain stable', async () => { await click(page.getByRole('button', { name: '设置', exact: true })); await click(page.getByRole('button', { name: '完成', exact: true })); });
    await phase('Right-click submits the selected card without native structure or visibility changes', async () => {
      const count = fixture.players.find(player => player.id === 'self').hand.length;
      const card = page.locator('.own-hand .playing-card').first(); await click(card, { x: 5, y: 45 });
      const point = await screenPoint(card, { x: 5, y: 45 }); await at('mouseMoved', point); await at('mousePressed', point, 2, 'right'); await at('mouseReleased', point, 0, 'right');
      await page.waitForFunction(() => window.__stabilityView?.currentPlay?.playerId === 'self');
      assert.equal(fixture.players.find(player => player.id === 'self').hand.length, count - 1);
    });
    const beforePin = await snapshot();
    for (const label of ['取消置顶', '置顶']) {
      const point = await screenPoint(page.getByRole('button', { name: label, exact: true })); await at('mouseMoved', point); await at('mousePressed', point, 1); await at('mouseReleased', point); await settle();
      assert.equal((await snapshot()).topmost, label === '置顶');
    }
    const pinEvents = await traceSince(beforePin);
    assert.deepEqual(pinEvents.filter(event => event.name === 'setAlwaysOnTop').map(event => event.args[0]), [false, true]);
    report.phases.push({ name: 'Explicit pin toggle', events: pinEvents }); report.checks.push('Only an explicit pin toggle changes always-on-top, exactly once per command');
    const beforeMinimize = await snapshot(); await page.evaluate(() => window.desktop.minimize());
    await page.waitForTimeout(250); assert.equal((await snapshot()).minimized, true);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); window.focus(); }); await settle(); await live();
    report.phases.push({ name: 'Explicit minimize and restore', events: await traceSince(beforeMinimize) }); report.checks.push('Explicit minimization restores to the same usable transparent window');
    await page.screenshot({ path: path.join(output, `desktop-stability-${label}.png`), omitBackground: true });
    await phase('A renderer crash during layout releases desktop input and reload restores normal controls', async () => {
      const desktop = (await page.evaluate(() => window.desktop.info())).layout.bounds;
      const start = await screenPoint(page.getByRole('button', { name: '拖动整套界面', exact: true }));
      await at('mouseMoved', start); await at('mousePressed', start, 1);
      await page.waitForFunction(async () => { const info = await window.desktop.info(); return info.interaction.layoutGesture && info.frame.width === info.layout.bounds.width; });
      report.preCrashDocumentEvents = await page.evaluate(() => window.__stabilityDocumentEvents);
      report.preCrashPointerEvents = await page.evaluate(() => window.__stabilityPointer);
      report.crashTestStarted = true;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
      await app.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
      const recovered = await snapshot();
      assert.equal(recovered.visible, true); assert.equal(recovered.minimized, false); assert.equal(recovered.topmost, true);
      assert.ok(recovered.frame.width < desktop.width, 'renderer failure must release the desktop-sized native input window');
      await app.evaluate(async () => {
        const window = globalThis.__stabilityWindow, contents = window.webContents;
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Reload after deliberate renderer crash timed out')), 10000); contents.once('did-finish-load', () => { clearTimeout(timer); resolve(); }); contents.reload(); });
        window.show(); window.focus();
        await new Promise(resolve => setTimeout(resolve, 500));
      });
      const recovery = await app.evaluate(() => globalThis.__stabilityWindow.webContents.executeJavaScript(`(async () => {
        const info = await window.desktop.info();
        const table = !!document.querySelector('.table-shell');
        document.querySelector('button[aria-label="设置"]').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const settingsOpened = !!document.querySelector('.settings-panel');
        [...document.querySelectorAll('.settings-panel button')].find(button => button.textContent === '完成').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        return { info, table, settingsOpened, settingsClosed: !document.querySelector('.settings-panel') };
      })()`));
      report.crashRecovery = recovery;
      assert.equal(recovery.info.interaction.locked, false); assert.equal(recovery.info.interaction.layoutGesture, false);
      assert.equal(recovery.table, true); assert.equal(recovery.settingsOpened, true); assert.equal(recovery.settingsClosed, true);
      const recoveredScreenshot = await app.evaluate(async () => (await globalThis.__stabilityWindow.webContents.capturePage()).toPNG().toString('base64'));
      await writeFile(path.join(output, `desktop-stability-${label}-crash-recovery.png`), Buffer.from(recoveredScreenshot, 'base64'));
    }, false, true);
  }
  report.final = await snapshot();
  if (!report.crashTestStarted) {
    report.documentEvents = await page.evaluate(() => window.__stabilityDocumentEvents);
    report.pointerEvents = await page.evaluate(() => window.__stabilityPointer);
  }
  report.fullTrace = await app.evaluate(() => globalThis.__stabilityTrace);
  if (report.violations.length || report.errors.length) process.exitCode = 1;
} catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; await page?.screenshot({ path: path.join(output, `desktop-stability-${label}-failure.png`), omitBackground: true }).catch(() => {}); }
finally {
  if (page && app) {
    report.documentEvents = report.crashTestStarted ? report.preCrashDocumentEvents || [] : await page.evaluate(() => window.__stabilityDocumentEvents || []).catch(() => []);
    report.pointerEvents = report.crashTestStarted ? report.preCrashPointerEvents || [] : await page.evaluate(() => window.__stabilityPointer || []).catch(() => []);
    report.fullTrace = await app.evaluate(() => globalThis.__stabilityTrace).catch(() => []);
    const pointerTypes = { pointerdown: 'mousePressed', pointerup: 'mouseReleased', pointermove: 'mouseMoved' };
    report.unrequestedPointerEvents = report.pointerEvents.filter(event => event.trusted && pointerTypes[event.name] && !report.inputRequests?.some(request => pointerTypes[event.name] === request.type && Math.abs(request.at - event.at) < 250 && Math.abs(request.x - event.x) < 2 && Math.abs(request.y - event.y) < 2));
  }
  await app?.close().catch(() => {}); for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => transport.close(resolve));
  await writeFile(path.join(output, `desktop-stability-${label}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode: label, checks: report.checks, violations: report.violations, errors: report.errors }, null, 2));
}
