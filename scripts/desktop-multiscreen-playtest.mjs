import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const packaged = process.argv.includes('--packaged');
const memoryBudget = process.argv.includes('--memory-budget');
const label = `${packaged ? 'packaged' : 'source'}${memoryBudget ? '-cache-budget' : ''}`;
const profile = await mkdtemp(path.join(output, `desktop-multiscreen-${label}-profile-`));
const expectedVersion = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const report = { mode: label, memoryBudget, profile, checks: [], errors: [], stderr: [], positions: [] };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page, input;
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const near = (actual, expected, label) => { assert.ok(Math.abs(actual.x - expected.x) < 3 && Math.abs(actual.y - expected.y) < 3, `${label}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`); };
async function nativeFrame() {
  return app.evaluate(({ BrowserWindow }) => ({ ...BrowserWindow.getAllWindows()[0].getContentBounds(), zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() }));
}
async function settleFrame() {
  await page.waitForTimeout(300);
  await page.waitForFunction(async () => !(await window.desktop.info()).interaction.locked, null, { timeout: 5000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function memorySample(label) {
  const result = await app.evaluate(({ app, BrowserWindow }) => ({
    frame: BrowserWindow.getAllWindows()[0].getContentBounds(),
    processes: app.getAppMetrics().map(({ type, memory, cpu }) => ({ type, memory, cpu })),
  }));
  result.label = label;
  result.totalWorkingSetMB = Math.round(result.processes.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024);
  result.totalPrivateMB = Math.round(result.processes.reduce((sum, item) => sum + (item.memory.privateBytes || 0), 0) / 1024);
  (report.memory ||= []).push(result);
}
async function stagePosition(label) {
  await settleFrame();
  const frame = await nativeFrame();
  const rect = await page.locator('.table-shell').boundingBox();
  const result = { label, frame, rect, localCenter: center(rect), absoluteCenter: { x: center(rect).x * frame.zoom + frame.x, y: center(rect).y * frame.zoom + frame.y } };
  report.positions.push(result); return result;
}
async function dispatchAtScreen(type, point, buttons = 0) {
  const frame = await nativeFrame();
  await input.send('Input.dispatchMouseEvent', { type, x: (point.x - frame.x) / frame.zoom, y: (point.y - frame.y) / frame.zoom, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
}
async function locatorScreenCenter(locator) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const rect = await locator.boundingBox(); assert.ok(rect, 'control is visible');
  const frame = await nativeFrame(), local = center(rect);
  return { x: frame.x + local.x * frame.zoom, y: frame.y + local.y * frame.zoom };
}
async function clickControl(locator) {
  const point = await locatorScreenCenter(locator);
  await dispatchAtScreen('mouseMoved', point);
  await dispatchAtScreen('mousePressed', point, 1);
  await dispatchAtScreen('mouseReleased', point);
  await settleFrame();
}
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(80);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(output, `desktop-multiscreen-${label}-${name}.png`), Buffer.from(png, 'base64'));
}
async function dragCenter(target) {
  const before = await stagePosition('before-drag');
  const start = await locatorScreenCenter(page.getByRole('button', { name: '拖动整套界面', exact: true }));
  const dx = target.x - before.absoluteCenter.x, dy = target.y - before.absoluteCenter.y;
  (report.requestedDrags ||= []).push({ start, target, delta: { x: dx, y: dy }, end: { x: start.x + dx, y: start.y + dy } });
  await dispatchAtScreen('mouseMoved', start); await page.waitForTimeout(120);
  await dispatchAtScreen('mousePressed', start, 1); await page.waitForTimeout(64);
  for (let step = 1; step <= 40; step++) { await dispatchAtScreen('mouseMoved', { x: start.x + dx * step / 40, y: start.y + dy * step / 40 }, 1); await page.waitForTimeout(20); }
  await dispatchAtScreen('mouseReleased', { x: start.x + dx, y: start.y + dy }); await settleFrame();
}
try {
  app = await electron.launch({ executablePath: path.join(project, packaged ? 'release/win-unpacked/玻璃斗地主.exe' : 'node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : [project]), `--user-data-dir=${profile}`, ...(memoryBudget ? ['--skia-resource-cache-limit-mb=16', '--force-gpu-mem-discardable-limit-mb=32'] : [])], cwd: project, env, timeout: 30000 });
  app.process().stderr?.on('data', chunk => report.stderr.push(chunk.toString()));
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  input = await page.context().newCDPSession(page);
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor(); await page.waitForTimeout(200);
  await page.evaluate(() => { window.__dragTrace = []; for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) addEventListener(type, event => { if (window.__dragTrace.length < 200) window.__dragTrace.push({ type, x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY, buttons: event.buttons, target: event.target.className, pointerId: event.pointerId, trusted: event.isTrusted }); }, true); });
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  report.native = await app.evaluate(({ app, BrowserWindow, screen, globalShortcut }) => ({ version: app.getVersion(), profile: app.getPath('userData'), bounds: BrowserWindow.getAllWindows()[0].getBounds(), contentBounds: BrowserWindow.getAllWindows()[0].getContentBounds(), primaryId: screen.getPrimaryDisplay().id, displays: screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor })), shortcut: globalShortcut.isRegistered('CommandOrControl+Shift+0') }));
  assert.equal(report.native.version, expectedVersion); assert.equal(path.resolve(report.native.profile).toLowerCase(), profile.toLowerCase()); assert.equal(report.native.shortcut, true);
  const displays = report.native.displays;
  const left = Math.min(...displays.map(display => display.bounds.x)), top = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width)), bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  report.layout = await page.evaluate(() => window.desktop.info());
  report.desktopUnion = { x: left, y: top, width: right - left, height: bottom - top };
  assert.deepEqual(report.layout.layout.bounds, report.desktopUnion);
  report.checks.push('virtual workspace retains the union of all connected physical displays');
  const primary = displays.find(display => display.id === report.native.primaryId);
  const primaryCenter = center(primary.workArea);
  await page.waitForTimeout(180);
  const initial = await stagePosition('initial-primary');
  near(initial.absoluteCenter, primaryCenter, 'initial stage center');
  assert.ok(initial.rect.x >= -1 && initial.rect.y >= -1 && (initial.rect.x + initial.rect.width) * initial.frame.zoom <= initial.frame.width + 1 && (initial.rect.y + initial.rect.height) * initial.frame.zoom <= initial.frame.height + 1, 'cropped native frame contains the whole interface');
  assert.ok(initial.frame.width * initial.frame.height < report.desktopUnion.width * report.desktopUnion.height, 'idle native surface is smaller than the desktop union');
  report.layout = await page.evaluate(() => window.desktop.info());
  assert.deepEqual(report.layout.frame, { x: initial.frame.x, y: initial.frame.y, width: initial.frame.width, height: initial.frame.height });
  report.checks.push('initial interface centers on primary display inside a smaller native frame');
  await memorySample('initial-idle');
  await dragCenter({ x: primaryCenter.x + 100, y: primaryCenter.y });
  near((await stagePosition('small-drag-primary')).absoluteCenter, { x: primaryCenter.x + 100, y: primaryCenter.y }, 'small drag within primary display');
  await clickControl(page.locator('.zoom-label'));
  report.checks.push('a small 100-pixel drag stays accurate before crossing monitors');
  await capture('primary');
  const secondary = displays.find(display => display.id !== primary.id);
  if (secondary) {
    const target = center(secondary.workArea);
    await dragCenter(target);
    const secondaryStage = await stagePosition('secondary');
    near(secondaryStage.absoluteCenter, target, 'drag to secondary display');
    assert.ok(secondaryStage.frame.width * secondaryStage.frame.height < report.desktopUnion.width * report.desktopUnion.height, 'native frame contracts after crossing monitors');
    await clickControl(page.getByRole('button', { name: '设置', exact: true }));
    await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor();
    await clickControl(page.getByRole('button', { name: '完成', exact: true }));
    await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('input[name=nickname]').fill('副屏操作成功'); assert.equal(await page.locator('input[name=nickname]').inputValue(), '副屏操作成功');
    await capture('secondary');
    report.checks.push('CDP pointer drag crossed into the other physical monitor; settings and text entry remained usable there');
    await clickControl(page.locator('.zoom-label'));
    near((await stagePosition('reset-primary')).absoluteCenter, primaryCenter, 'reset returns to primary display');
    report.checks.push('reset returned the interface and contracted native frame to the primary monitor');
    await dragCenter(target);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('reset-layout'));
    await page.waitForTimeout(160);
    near((await stagePosition('shortcut-event-primary')).absoluteCenter, primaryCenter, 'reset shortcut event returns to primary');
    report.checks.push('registered reset shortcut renderer event also returns interface from secondary to primary');
  } else report.limitation = 'Only one physical display is available; crossing a real display boundary was not exercised.';
  const beforeResize = await stagePosition('before-resize');
  const zoomBefore = Number.parseInt(await page.locator('.zoom-label').innerText(), 10);
  const resizeStart = await locatorScreenCenter(page.locator('.resize-handle.bottom-right'));
  const resizeDelta = { x: 100, y: 55 };
  await dispatchAtScreen('mouseMoved', resizeStart);
  await dispatchAtScreen('mousePressed', resizeStart, 1); await page.waitForTimeout(64);
  for (let step = 1; step <= 20; step++) { await dispatchAtScreen('mouseMoved', { x: resizeStart.x + resizeDelta.x * step / 20, y: resizeStart.y + resizeDelta.y * step / 20 }, 1); await page.waitForTimeout(20); }
  await dispatchAtScreen('mouseReleased', { x: resizeStart.x + resizeDelta.x, y: resizeStart.y + resizeDelta.y });
  const afterResize = await stagePosition('after-resize');
  const zoomAfter = Number.parseInt(await page.locator('.zoom-label').innerText(), 10);
  assert.ok(zoomAfter > zoomBefore && afterResize.rect.width > beforeResize.rect.width && afterResize.rect.height > beforeResize.rect.height, 'resize handle increases displayed scale and actual interface bounds');
  near({ x: beforeResize.frame.x + beforeResize.rect.x * beforeResize.frame.zoom, y: beforeResize.frame.y + beforeResize.rect.y * beforeResize.frame.zoom }, { x: afterResize.frame.x + afterResize.rect.x * afterResize.frame.zoom, y: afterResize.frame.y + afterResize.rect.y * afterResize.frame.zoom }, 'resize preserves the opposite corner in desktop coordinates');
  report.resize = { zoomBefore, zoomAfter, beforeFrame: beforeResize.frame, afterFrame: afterResize.frame };
  report.checks.push('resize handle changes zoom and native bounds while preserving its opposite screen corner');
  await clickControl(page.locator('.zoom-label'));
  await memorySample('after-gestures-contracted');
  await page.waitForTimeout(8000);
  await memorySample('after-gestures-idle-eight-seconds');
  report.checks.push('recorded process memory before and after expanded gestures, including eight seconds of idle recovery');
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(error.stack || String(error)); report.dragTrace = await page?.evaluate(() => window.__dragTrace).catch(() => []); await capture('failure').catch(() => {}); process.exitCode = 1; }
finally { await app?.close().catch(() => {}); await writeFile(path.join(output, `desktop-multiscreen-${label}-report.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
