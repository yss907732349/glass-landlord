import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../server/index.ts';

const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createGameServer({ port: 0, host: '127.0.0.1' });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const report = { checks: [], errors: [] };
let page;
const point = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
async function shell() { return page.locator('.table-shell').boundingBox(); }
function samePosition(a, b) { assert.ok(Math.abs(a.x - b.x) < .1 && Math.abs(a.y - b.y) < .1, `${JSON.stringify(a)} moved to ${JSON.stringify(b)}`); }
async function drag(locator, button, dx, dy) {
  const start = point(await locator.boundingBox());
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 }); await page.mouse.up({ button });
}
async function synthetic(type, values) { await page.evaluate(({ type, values }) => window.dispatchEvent(new PointerEvent(type, { bubbles: true, isPrimary: true, ...values })), { type, values }); }
try {
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    window.__windowCommands = []; window.__gestureView = null;
    localStorage.setItem('glass-server', location.origin);
    window.desktop = { isDesktop: true, info: async () => ({ addresses: [], window: { pinned: false } }), pin: value => window.__windowCommands.push(['pin', value]), hide: () => window.__windowCommands.push(['hide']), minimize: () => window.__windowCommands.push(['minimize']), close: () => window.__windowCommands.push(['close']) };
    addEventListener('pointerdown', event => { if (event.isTrusted) window.__lastPointerId = event.pointerId; }, true);
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); this.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.type === 'state') window.__gestureView = message.state; }); } };
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.getByRole('button', { name: '置顶', exact: true }).waitFor();
  await page.evaluate(() => dispatchEvent(new CustomEvent('glass-window-state', { detail: { pinned: true } })));
  await page.getByRole('button', { name: '取消置顶', exact: true }).waitFor();
  await page.evaluate(() => dispatchEvent(new CustomEvent('glass-window-state', { detail: { pinned: false } })));
  await page.getByRole('button', { name: '置顶', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__windowCommands), []);
  report.checks.push('the pin button reflects initial native state and external pin changes without sending a new pin command');
  const handle = page.getByRole('button', { name: '拖动整套界面', exact: true });
  const corner = page.getByRole('button', { name: '右下角拖动缩放', exact: true });
  const reset = page.locator('.zoom-label');
  for (const button of ['right', 'middle']) {
    const before = await shell(), zoom = await reset.innerText();
    await drag(handle, button, 55, 25); samePosition(before, await shell());
    await drag(corner, button, -55, -25); assert.equal(await reset.innerText(), zoom); samePosition(before, await shell());
  }
  report.checks.push('right and middle mouse buttons never start moving or resizing the interface');
  for (const target of [handle, corner]) {
    const before = await shell(), zoom = await reset.innerText();
    await target.evaluate(element => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: false, pointerId: 99, button: 0, buttons: 1, screenX: 30, screenY: 30 })));
    await synthetic('pointermove', { pointerId: 99, isPrimary: false, buttons: 1, screenX: 180, screenY: 140 });
    await synthetic('pointerup', { pointerId: 99, isPrimary: false, buttons: 0 });
    samePosition(before, await shell()); assert.equal(await reset.innerText(), zoom);
  }
  report.checks.push('a secondary pointer cannot start a layout gesture');
  const start = point(await handle.boundingBox()), before = await shell();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  const pointerId = await page.evaluate(() => window.__lastPointerId);
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) await synthetic(type, { pointerId: pointerId + 100, buttons: type === 'pointermove' ? 1 : 0, screenX: 1800, screenY: 1200 });
  samePosition(before, await shell());
  await synthetic('pointerup', { pointerId, buttons: 1 });
  await page.mouse.move(start.x + 40, start.y + 20, { steps: 5 });
  let after = await shell(); assert.ok(Math.abs(after.x - before.x - 40) < .1 && Math.abs(after.y - before.y - 20) < .1);
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await page.mouse.move(start.x + 90, start.y + 50); samePosition(after, await shell()); await page.mouse.up();
  report.checks.push('only the initiating pointer moves or ends a gesture; blur cancels it without allowing stale movement');
  await reset.click();
  await drag(corner, 'left', -55, -25); assert.notEqual(await reset.innerText(), '100%'); await reset.click();
  const cancelStart = point(await corner.boundingBox()), cancelZoom = await reset.innerText();
  await page.mouse.move(cancelStart.x, cancelStart.y); await page.mouse.down();
  await synthetic('pointercancel', { pointerId: await page.evaluate(() => window.__lastPointerId), buttons: 0 });
  await page.mouse.move(cancelStart.x - 50, cancelStart.y - 25); await page.mouse.up(); assert.equal(await reset.innerText(), cancelZoom);
  report.checks.push('left-button resizing remains usable and pointer cancellation ends the session');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('锁定布局，避免误拖', { exact: true }).check();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  assert.ok(await handle.isDisabled()); assert.ok(await corner.isDisabled());
  assert.ok(await page.getByRole('button', { name: '左上角拖动缩放', exact: true }).isDisabled());
  const lockedPosition = await shell(), lockedZoom = await reset.innerText();
  await drag(handle, 'left', 55, 25); await drag(corner, 'left', -55, -25);
  samePosition(lockedPosition, await shell()); assert.equal(await reset.innerText(), lockedZoom);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('锁定布局，避免误拖', { exact: true }).uncheck();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  assert.ok(await handle.isEnabled()); assert.ok(await corner.isEnabled());
  report.checks.push('locking the layout disables all three handles and prevents actual left-button drags until unlocked');

  await page.locator('input[name=nickname]').fill('手势回归'); await page.locator('input[name=password]').fill('gesture-test');
  await page.getByRole('button', { name: '开一桌', exact: true }).click(); await page.waitForFunction(() => window.__gestureView?.phase === 'lobby');
  await page.getByRole('button', { name: '添加两位陪练，先玩一局', exact: true }).click(); await page.waitForFunction(() => window.__gestureView?.players.length === 3);
  await page.getByRole('button', { name: '我准备好了', exact: true }).click(); await page.waitForFunction(() => window.__gestureView?.players.every(player => player.ready));
  await page.getByRole('button', { name: '开始这局', exact: true }).click(); await page.locator('.own-hand .playing-card').first().waitFor();
  const hand = page.locator('.own-hand'), cards = hand.locator('.playing-card');
  const cardPoint = async index => { const box = await cards.nth(index).boundingBox(); return { x: box.x + 5, y: box.y + 45 }; };
  const from = await cardPoint(0), to = await cardPoint(3);
  for (const button of ['right', 'middle']) { await page.mouse.move(from.x, from.y); await page.mouse.down({ button }); await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up({ button }); assert.equal(await hand.locator('.selected').count(), 0); }
  await cards.first().evaluate(element => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: false, pointerId: 99, button: 0, buttons: 1 })));
  assert.equal(await hand.locator('.selected').count(), 0);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); assert.equal(await hand.locator('.selected').count(), 1);
  await hand.evaluate((element, x) => element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, isPrimary: true, pointerId: 99, buttons: 1, clientX: x })), to.x); assert.equal(await hand.locator('.selected').count(), 1);
  await synthetic('pointercancel', { pointerId: 99, buttons: 0 });
  await page.mouse.move(to.x, to.y, { steps: 5 }); assert.equal(await hand.locator('.selected').count(), 4);
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  const selected = await hand.locator('.selected').count(); const farther = await cardPoint(5);
  await page.mouse.move(farther.x, farther.y); await page.mouse.up(); assert.equal(await hand.locator('.selected').count(), selected);
  report.checks.push('card sweeps reject right, middle and secondary pointers; only their owner can sweep, and blur cancels the sweep');

  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '离开', exact: true }).click(); await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.evaluate(() => localStorage.setItem('glass-zoom', '.35')); await page.reload(); await handle.waitFor();
  assert.equal(await page.getByRole('button', { name: '最小化', exact: true }).count(), 0);
  assert.equal(await page.locator('.window-tools .close-button').count(), 0);
  const menuButton = page.getByRole('button', { name: '窗口菜单', exact: true });
  await menuButton.click(); const menu = page.getByRole('menu', { name: '窗口操作', exact: true }); await menu.waitFor();
  const heights = await menu.getByRole('menuitem').evaluateAll(items => items.map(item => item.getBoundingClientRect().height)); assert.equal(heights.length, 2); assert.ok(heights.every(height => height >= 35.9));
  assert.deepEqual(await page.evaluate(() => window.__windowCommands), []);
  await page.screenshot({ path: fileURLToPath(new URL('interaction-window-menu-35.png', output)), omitBackground: true });
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' });
  await menuButton.click(); await page.mouse.click(0, 0); await menu.waitFor({ state: 'hidden' }); assert.deepEqual(await page.evaluate(() => window.__windowCommands), []);
  await menuButton.click(); await menu.getByRole('menuitem', { name: '隐藏牌局', exact: false }).click(); assert.deepEqual(await page.evaluate(() => window.__windowCommands), [['hide']]);
  await menuButton.click(); await menu.getByRole('menuitem', { name: '退出程序', exact: true }).click(); assert.deepEqual(await page.evaluate(() => window.__windowCommands), [['hide'], ['close']]);
  report.checks.push('at minimum zoom, window actions stay at least 36 physical pixels tall and require an explicit menu action; opening, Escape and outside clicks never hide or close');
  assert.deepEqual(report.errors, []); report.result = 'passed';
} catch (error) { report.errors.push(error.stack || String(error)); report.result = 'failed'; process.exitCode = 1; }
finally { await browser.close(); await server.close(); await writeFile(new URL('interaction-gesture-playtest-report.json', output), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
