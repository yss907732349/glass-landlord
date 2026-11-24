import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const packaged = process.argv.includes('--packaged');
const label = packaged ? 'packaged' : 'source';
const profile = await mkdtemp(path.join(output, `desktop-multiscreen-${label}-profile-`));
const expectedVersion = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const report = { mode: label, profile, checks: [], errors: [], stderr: [], positions: [] };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const near = (actual, expected, label) => { assert.ok(Math.abs(actual.x - expected.x) < 3 && Math.abs(actual.y - expected.y) < 3, `${label}: ${JSON.stringify(actual)} versus ${JSON.stringify(expected)}`); };
async function stagePosition(label) {
  const rect = await page.locator('.table-shell').boundingBox();
  const result = { label, rect, localCenter: center(rect), absoluteCenter: { x: center(rect).x + report.native.bounds.x, y: center(rect).y + report.native.bounds.y } };
  report.positions.push(result); return result;
}
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(80);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(output, `desktop-multiscreen-${label}-${name}.png`), Buffer.from(png, 'base64'));
}
async function dragCenter(target) {
  const before = await stagePosition('before-drag');
  const handle = await page.getByRole('button', { name: '拖动整套界面', exact: true }).boundingBox();
  const start = center(handle), dx = target.x - before.localCenter.x, dy = target.y - before.localCenter.y;
  (report.requestedDrags ||= []).push({ start, target, delta: { x: dx, y: dy }, end: { x: start.x + dx, y: start.y + dy } });
  await page.mouse.move(start.x, start.y); await page.waitForTimeout(120); await page.mouse.down(); await page.waitForTimeout(32);
  for (let step = 1; step <= 40; step++) { await page.mouse.move(start.x + dx * step / 40, start.y + dy * step / 40); await page.waitForTimeout(20); }
  await page.mouse.up(); await page.waitForTimeout(160);
}
try {
  app = await electron.launch({ executablePath: path.join(project, packaged ? 'release/win-unpacked/玻璃斗地主.exe' : 'node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : [project]), `--user-data-dir=${profile}`], cwd: project, env, timeout: 30000 });
  app.process().stderr?.on('data', chunk => report.stderr.push(chunk.toString()));
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor(); await page.waitForTimeout(200);
  await page.evaluate(() => { window.__dragTrace = []; for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) addEventListener(type, event => { if (window.__dragTrace.length < 200) window.__dragTrace.push({ type, x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY, buttons: event.buttons, target: event.target.className, pointerId: event.pointerId, trusted: event.isTrusted }); }, true); });
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  report.native = await app.evaluate(({ app, BrowserWindow, screen, globalShortcut }) => ({ version: app.getVersion(), profile: app.getPath('userData'), bounds: BrowserWindow.getAllWindows()[0].getBounds(), contentBounds: BrowserWindow.getAllWindows()[0].getContentBounds(), primaryId: screen.getPrimaryDisplay().id, displays: screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor })), shortcut: globalShortcut.isRegistered('CommandOrControl+Shift+0') }));
  assert.equal(report.native.version, expectedVersion); assert.equal(path.resolve(report.native.profile).toLowerCase(), profile.toLowerCase()); assert.equal(report.native.shortcut, true);
  const displays = report.native.displays;
  const left = Math.min(...displays.map(display => display.bounds.x)), top = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width)), bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  assert.deepEqual(report.native.bounds, { x: left, y: top, width: right - left, height: bottom - top });
  report.checks.push('native window exactly covers the union of real display bounds, including negative origins');
  report.layout = await page.evaluate(() => window.desktop.info());
  assert.deepEqual(report.layout.layout.bounds, report.native.bounds);
  const primary = displays.find(display => display.id === report.native.primaryId);
  const primaryLocal = { x: center(primary.workArea).x - left, y: center(primary.workArea).y - top };
  await page.waitForTimeout(180);
  near((await stagePosition('initial-primary')).localCenter, primaryLocal, 'initial stage center');
  report.checks.push('initial interface centers in the primary work area while native window retains all monitors');
  await dragCenter({ x: primaryLocal.x + 100, y: primaryLocal.y });
  near((await stagePosition('small-drag-primary')).localCenter, { x: primaryLocal.x + 100, y: primaryLocal.y }, 'small drag within primary display');
  await page.locator('.zoom-label').click(); await page.waitForTimeout(100);
  report.checks.push('a small 100-pixel drag stays accurate before crossing monitors');
  await capture('primary');
  const secondary = displays.find(display => display.id !== primary.id);
  if (secondary) {
    const target = { x: center(secondary.workArea).x - left, y: center(secondary.workArea).y - top };
    await dragCenter(target);
    near((await stagePosition('secondary')).localCenter, target, 'drag to secondary display');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.locator('input[name=nickname]').fill('副屏操作成功'); assert.equal(await page.locator('input[name=nickname]').inputValue(), '副屏操作成功');
    await capture('secondary');
    report.checks.push('real pointer drag crossed into the other physical monitor; settings and text entry remained usable there');
    await page.locator('.zoom-label').click(); await page.waitForTimeout(160);
    near((await stagePosition('reset-primary')).localCenter, primaryLocal, 'reset returns to primary display');
    assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()), report.native.bounds);
    report.checks.push('reset moved interface back to the primary monitor without shrinking native bounds');
    await dragCenter(target);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('reset-layout'));
    await page.waitForTimeout(160);
    near((await stagePosition('shortcut-event-primary')).localCenter, primaryLocal, 'reset shortcut event returns to primary');
    report.checks.push('registered reset shortcut renderer event also returns interface from secondary to primary');
  } else report.limitation = 'Only one physical display is available; crossing a real display boundary was not exercised.';
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(error.stack || String(error)); report.dragTrace = await page?.evaluate(() => window.__dragTrace).catch(() => []); await capture('failure').catch(() => {}); process.exitCode = 1; }
finally { await app?.close().catch(() => {}); await writeFile(path.join(output, `desktop-multiscreen-${label}-report.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
