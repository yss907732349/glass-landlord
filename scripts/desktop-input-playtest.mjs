import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url))), output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const packaged = process.argv.includes('--packaged'), label = packaged ? 'packaged' : 'source';
const profile = await mkdtemp(path.join(output, `desktop-input-${label}-profile-`));
const expectedVersion = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const report = { mode: label, profile, checks: [], errors: [], states: [], nativeHits: [] };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const python = 'C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const nativeInput = String.raw`import ctypes,json,sys,time
u=ctypes.windll.user32
try:u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
except Exception:pass
class Point(ctypes.Structure): _fields_=[('x',ctypes.c_long),('y',ctypes.c_long)]
class Rect(ctypes.Structure): _fields_=[('left',ctypes.c_long),('top',ctypes.c_long),('right',ctypes.c_long),('bottom',ctypes.c_long)]
u.WindowFromPoint.argtypes=[Point];u.WindowFromPoint.restype=ctypes.c_void_p
u.GetAncestor.argtypes=[ctypes.c_void_p,ctypes.c_uint];u.GetAncestor.restype=ctypes.c_void_p
u.PostMessageW.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_size_t,ctypes.c_ssize_t]
u.ScreenToClient.argtypes=[ctypes.c_void_p,ctypes.POINTER(Point)]
u.GetWindowLongW.argtypes=[ctypes.c_void_p,ctypes.c_int]
u.IsWindowVisible.argtypes=[ctypes.c_void_p]
u.GetWindowRect.argtypes=[ctypes.c_void_p,ctypes.POINTER(Rect)]
u.GetDpiForWindow.argtypes=[ctypes.c_void_p]
def window_rect(hwnd):
 r=Rect();u.GetWindowRect(hwnd,ctypes.byref(r));return {'x':r.left,'y':r.top,'width':r.right-r.left,'height':r.bottom-r.top,'dpi':u.GetDpiForWindow(hwnd),'visible':bool(u.IsWindowVisible(hwnd))}
overlay=int(sys.argv[2])
background=int(sys.argv[3])
result=[]
for event in json.loads(sys.argv[1]):
 x,y=round(event['x']),round(event['y']);hwnd=u.WindowFromPoint(Point(x,y));root=u.GetAncestor(hwnd,2)
 local=Point(x,y);u.ScreenToClient(hwnd,ctypes.byref(local));coords=(local.x&65535)|((local.y&65535)<<16)
 kind=event['type']
 owned=root in (overlay,background)
 if kind=='move' and owned:u.PostMessageW(hwnd,512,event.get('buttons',0),coords)
 if kind in ('down','click') and owned:u.PostMessageW(hwnd,513,1,coords)
 if kind=='click':time.sleep(.005)
 if kind in ('up','click') and owned:u.PostMessageW(hwnd,514,0,coords)
 result.append({'kind':kind,'x':x,'y':y,'root':str(root),'overlayExStyle':u.GetWindowLongW(overlay,-20),'overlayVisible':bool(u.IsWindowVisible(overlay)),'overlayRect':window_rect(overlay),'backgroundRect':window_rect(background)})
 if event.get('pause'):time.sleep(event['pause'])
print(json.dumps(result))`;
let app, page;
async function native(events) {
  const physical = await app.evaluate(({ screen }, values) => values.map(value => ({ ...value, ...screen.dipToScreenPoint({ x: Math.round(value.x), y: Math.round(value.y) }) })), events);
  report.requestedInputs ||= []; report.requestedInputs.push({ at: Date.now(), logical: events, physical });
  const hits = JSON.parse(execFileSync(python, ['-c', nativeInput, JSON.stringify(physical), report.native?.overlay || '0', report.native?.background || '0'], { encoding: 'utf8' }));
  report.nativeHits.push(...hits); return hits;
}
async function info(label) { const value = await page.evaluate(() => window.desktop.info()); report.states.push({ label, frame: value.frame, frameRevision: value.frameRevision, ...value.interaction }); return value.interaction; }
async function settled() { await page.waitForTimeout(250); await page.waitForFunction(async () => { const value = await window.desktop.info(); return !value.interaction.locked && value.interaction.regionsRevision === value.frameRevision; }); await page.waitForTimeout(140); }
async function backgroundClicks() { return app.evaluate(async () => globalThis.__inputBackground.webContents.executeJavaScript('window.clicks')); }
async function clearClicks() { await app.evaluate(async () => globalThis.__inputBackground.webContents.executeJavaScript('window.clicks=[]')); }
async function absolutePoint(locator) { await locator.scrollIntoViewIfNeeded(); const rect = await locator.boundingBox(); const { frame } = await page.evaluate(() => window.desktop.info()); return { x: frame.x + rect.x + rect.width / 2, y: frame.y + rect.y + rect.height / 2 }; }
async function tableCenter() { return absolutePoint(page.locator('.table-shell')); }
async function floor() { return page.evaluate(() => { const part = document.querySelector('[data-native-hit-plane]')?.firstElementChild; if (!part) return null; const rect = part.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, html: part.outerHTML }; }); }
try {
  app = await electron.launch({ executablePath: path.join(project, packaged ? 'release/win-unpacked/玻璃斗地主.exe' : 'node_modules/electron/dist/electron.exe'), args: [...(packaged ? [] : [project]), `--user-data-dir=${profile}`], cwd: project, env, timeout: 30000 });
  page = await app.firstWindow(); page.on('pageerror', error => report.errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.evaluate(() => { window.__inputDOMTrace = []; for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, event => { if (window.__inputDOMTrace.length < 200) window.__inputDOMTrace.push({ time: Date.now(), type, x: event.clientX, y: event.clientY, screenX: event.screenX, screenY: event.screenY, button: event.target.closest('button')?.getAttribute('aria-label') || event.target.closest('button')?.textContent }); }, true); });
  await settled();
  const toolbar = await page.getByRole('button', { name: '设置', exact: true }).boundingBox();
  report.native = await app.evaluate(async ({ app, BrowserWindow, screen }, rect) => {
    const overlay = BrowserWindow.getAllWindows()[0], bounds = overlay.getBounds();
    globalThis.__inputOverlay = overlay;
    globalThis.__inputTrace = [];
    globalThis.__inputNativeCalls = [];
    for (const name of ['setBounds', 'setShape', 'setAlwaysOnTop', 'setIgnoreMouseEvents', 'hide', 'minimize']) {
      const original = overlay[name].bind(overlay);
      overlay[name] = (...args) => { globalThis.__inputNativeCalls.push({ at: Date.now(), name, args }); return original(...args); };
    }
    for (const type of ['always-on-top-changed', 'focus', 'blur', 'hide', 'show', 'minimize']) overlay.on(type, (_event, value) => globalThis.__inputTrace.push({ time: Date.now(), type, value }));
    overlay.webContents.on('ipc-message', (_event, channel, ...args) => { if (channel === 'window-control' || channel === 'interaction-lock') globalThis.__inputTrace.push({ time: Date.now(), channel, args }); });
    const fixtureBounds = { x: bounds.x + bounds.width - 232, y: bounds.y + Math.round(rect.y - 40), width: 400, height: 250 };
    const background = new BrowserWindow({ ...fixtureBounds, frame: false, show: false, backgroundColor: '#28303b', webPreferences: { contextIsolation: true } });
    globalThis.__inputBackground = background;
    await background.loadURL('data:text/html,<html><body style="margin:0;width:100vw;height:100vh;background:%2328303b;color:white">Isolated native input test window<script>window.clicks=[];addEventListener("click",e=>window.clicks.push({x:e.clientX,y:e.clientY}))</script></body></html>');
    background.show(); background.setBounds(fixtureBounds); background.moveTop();
    return { version: app.getVersion(), bounds, fixtureBounds: background.getBounds(), overlay: overlay.getNativeWindowHandle().readBigUInt64LE().toString(), background: background.getNativeWindowHandle().readBigUInt64LE().toString(), displays: screen.getAllDisplays().map(display => display.bounds) };
  }, toolbar);
  assert.equal(report.native.version, expectedVersion); report.bounds = report.native.bounds;
  await page.waitForFunction(async () => (await window.desktop.info()).interaction?.mode === 'stable-window'); await page.waitForTimeout(160);
  let state = await info('initial'); assert.equal(state.ignored, false); assert.equal(state.locked, false);
  assert.equal((await page.evaluate(() => window.desktop.info())).window.pinned, true);
  const ordinaryBaseline = { frame: (await page.evaluate(() => window.desktop.info())).frame, floor: await floor() };
  await app.evaluate(() => { globalThis.__inputNativeCalls = []; globalThis.__inputTrace = []; });
  assert.ok(report.bounds.width < report.native.displays.reduce((sum, display) => sum + display.width, 0));
  report.checks.push('startup uses a small native viewport cropped around the interface');
  const shell = await page.locator('.table-shell').boundingBox();
  const outside = { x: report.bounds.x + report.bounds.width + 30, y: report.native.fixtureBounds.y + 160 };
  const transparentMargin = { x: report.bounds.x + report.bounds.width - 4, y: report.native.fixtureBounds.y + 160 };
  const gap = { x: report.bounds.x + shell.x + shell.width - 30, y: report.native.fixtureBounds.y + 160 };
  await clearClicks(); const outsideHit = await native([{ type: 'click', ...outside }]); await page.waitForTimeout(80);
  assert.equal(outsideHit[0].root, report.native.background); assert.equal((await backgroundClicks()).length, 1);
  await clearClicks(); const gapHit = await native([{ type: 'click', ...gap }]); await page.waitForTimeout(180);
  assert.equal(gapHit[0].root, report.native.overlay); assert.equal((await backgroundClicks()).length, 0);
  report.checks.push('Win32 native clicks reach the isolated background outside the native window, and cannot pass through a transparent gap inside it');

  await info('after-gap-before-settings');
  await clearClicks(); await native([{ type: 'move', ...outside }, { type: 'click', ...await absolutePoint(page.getByRole('button', { name: '设置', exact: true })) }]);
  await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor(); assert.equal((await backgroundClicks()).length, 0);
  await settled();
  const ordinaryFrame = await page.evaluate(() => window.desktop.info());
  assert.ok(ordinaryFrame.frame.width < ordinaryFrame.layout.bounds.width);
  report.checks.push('ordinary settings interaction keeps the native viewport small');
  await page.getByRole('slider', { name: '整体透明度', exact: true }).evaluate(element => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '85'); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.table-shell')).opacity) === .15);
  for (let count = 0; count < 4; count++) {
    await native([{ type: 'click', ...await absolutePoint(page.getByRole('button', { name: '完成', exact: true })) }]);
    await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor({ state: 'hidden' }); await page.waitForTimeout(160);
    await native([{ type: 'move', ...outside }, { type: 'click', ...await absolutePoint(page.getByRole('button', { name: '设置', exact: true })) }]);
    await page.getByRole('heading', { name: '界面设置', exact: true }).waitFor();
  }
  assert.equal((await backgroundClicks()).length, 0);
  await native([{ type: 'click', ...await absolutePoint(page.getByRole('button', { name: '完成', exact: true })) }]); await settled();
  report.checks.push('four immediate native entries from outside to a toolbar button opened the correct control without a move-to-IPC delay or background click');

  await page.evaluate(() => {
    const fixture = document.createElement('div'); fixture.className = 'skill-row'; fixture.dataset.nativeFixture = 'true'; fixture.style.cssText = 'position:absolute;left:300px;top:510px;display:flex;gap:8px;z-index:80';
    window.__nativeSkillClicks = [];
    for (let index = 0; index < 3; index++) { const button = document.createElement('button'); button.className = 'skill-card'; button.textContent = `原生输入夹具${index}`; button.style.cssText = 'width:105px;height:32px'; button.addEventListener('click', () => { window.__nativeSkillClicks.push(index); fixture.prepend(button); }); fixture.append(button); }
    document.querySelector('.table-shell').append(fixture);
  });
  await clearClicks();
  for (let count = 0; count < 8; count++) {
    const button = page.locator('[data-native-fixture] button').last();
    await native([{ type: 'move', ...outside }, { type: 'click', ...await absolutePoint(button) }]); await page.waitForTimeout(24);
  }
  assert.equal(await page.evaluate(() => window.__nativeSkillClicks.length), 8); assert.equal((await backgroundClicks()).length, 0);
  await page.evaluate(() => document.querySelector('[data-native-fixture]').remove()); await page.waitForTimeout(180);
  report.checks.push('eight native skill-button fixture clicks remained captured while each click reordered the controls in the DOM');
  const alphaPath = path.join(output, `desktop-input-${label}-transparency-85.png`);
  const alphaFrame = (await page.evaluate(() => window.desktop.info())).frame;
  const png = await app.evaluate(async () => (await globalThis.__inputOverlay.webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(alphaPath, Buffer.from(png, 'base64'));
  report.alpha = JSON.parse(execFileSync(python, ['-c', 'from PIL import Image\nimport json,sys\nim=Image.open(sys.argv[1]).convert("RGBA");p=json.loads(sys.argv[2]);sx=im.width/p["frame"]["width"];sy=im.height/p["frame"]["height"];print(json.dumps({k:im.getpixel((round(v["x"]*sx),round(v["y"]*sy)))[3] for k,v in p["points"].items()}))', alphaPath, JSON.stringify({ frame: alphaFrame, points: { gap: { x: gap.x - alphaFrame.x, y: gap.y - alphaFrame.y }, transparentMargin: { x: transparentMargin.x - alphaFrame.x, y: transparentMargin.y - alphaFrame.y } } })], { encoding: 'utf8' }));
  assert.equal(report.alpha.gap, 1); assert.equal(report.alpha.transparentMargin, 0); report.checks.push('at 85% UI transparency the table gap has alpha 1 and padding stays visually transparent; desktop click-through is checked outside native bounds separately');
  report.ordinaryCalls = await app.evaluate(() => globalThis.__inputNativeCalls);
  report.ordinaryTrace = await app.evaluate(() => globalThis.__inputTrace);
  const ordinaryFinal = await page.evaluate(() => window.desktop.info());
  assert.deepEqual(report.ordinaryCalls, [], 'ordinary clicks must never mutate native shape, bounds, z-order, hiding or minimization');
  assert.deepEqual(ordinaryFinal.frame, ordinaryBaseline.frame);
  assert.deepEqual(await floor(), ordinaryBaseline.floor, 'ordinary presses and releases must retain the exact same alpha hit floor');
  assert.equal(ordinaryFinal.window.visible, true); assert.equal(ordinaryFinal.window.minimized, false); assert.equal(ordinaryFinal.window.pinned, true);
  assert.equal(report.ordinaryTrace.filter(event => ['hide', 'minimize', 'always-on-top-changed'].includes(event.type)).length, 0);
  report.checks.push('ordinary native clicks preserve bounds, hit floor, topmost and visibility without any native window mutation');

  const start = await absolutePoint(page.getByRole('button', { name: '拖动整套界面', exact: true }));
  const startCenter = await tableCenter();
  const layout = (await page.evaluate(() => window.desktop.info())).layout, desktop = layout.bounds;
  const targetDisplay = layout.displays.find(display => {
    const area = display.workArea;
    return Math.abs(desktop.x + area.x + area.width / 2 - startCenter.x) > 100 || Math.abs(desktop.y + area.y + area.height / 2 - startCenter.y) > 100;
  });
  const targetArea = targetDisplay?.workArea || layout.primary;
  const primaryCenter = { x: desktop.x + targetArea.x + targetArea.width / 2, y: desktop.y + targetArea.y + targetArea.height / 2 };
  const destination = { x: start.x + primaryCenter.x - startCenter.x, y: start.y + primaryCenter.y - startCenter.y };
  await clearClicks(); await native([{ type: 'down', ...start }]); await page.waitForFunction(async () => { const info = await window.desktop.info(); return info.interaction.locked && info.interaction.layoutGesture && info.frame.width === info.layout.bounds.width; }); await page.waitForTimeout(100);
  state = await info('pointer-held'); assert.equal(state.locked, true); assert.equal(state.layoutGesture, true);
  assert.deepEqual((await page.evaluate(() => window.desktop.info())).frame, desktop);
  const heldFloor = await floor(); assert.deepEqual({ x: heldFloor.x, y: heldFloor.y, width: heldFloor.width, height: heldFloor.height }, { x: 0, y: 0, width: desktop.width, height: desktop.height });
  await native(Array.from({ length: 12 }, (_, index) => ({ type: 'move', buttons: 1, x: start.x + (destination.x - start.x) * (index + 1) / 12, y: start.y + (destination.y - start.y) * (index + 1) / 12, pause: .01 })));
  state = await info('outside-original-shell-held'); assert.equal(state.locked, true); assert.equal((await backgroundClicks()).length, 0);
  await page.waitForTimeout(100);
  await native([{ type: 'up', ...destination }]); await settled();
  await page.waitForFunction(async () => (await window.desktop.info()).frame.width < (await window.desktop.info()).layout.bounds.width);
  state = await info('released'); assert.equal(state.locked, false); assert.equal(state.layoutGesture, false);
  const endCenter = await tableCenter(); report.drag = { startCenter, expectedCenter: primaryCenter, endCenter };
  assert.ok(Math.abs(endCenter.x - primaryCenter.x) < 3 && Math.abs(endCenter.y - primaryCenter.y) < 3, 'the native drag must move the table across screens to the requested screen position');
  const releasedFloor = await floor(); assert.ok(releasedFloor.width < desktop.width, 'release restores the alpha floor to the table');
  const cropped = await page.evaluate(() => window.desktop.info()); assert.ok(cropped.frame.width < desktop.width);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.id !== globalThis.__inputBackground.id).webContents.send('reset-layout')); await settled();
  await app.evaluate(() => { globalThis.__inputBackground.showInactive(); globalThis.__inputBackground.moveTop(); });
  await native([{ type: 'click', ...outside }]); await page.waitForTimeout(80); assert.equal((await backgroundClicks()).length, 1);
  report.checks.push('native drag moved across screens with a full alpha floor during the gesture and restored outside desktop clicks after release');
  report.allNativeCalls = await app.evaluate(() => globalThis.__inputNativeCalls);
  assert.equal(report.allNativeCalls.filter(call => ['setShape', 'setAlwaysOnTop', 'setIgnoreMouseEvents', 'hide', 'minimize'].includes(call.name)).length, 0, 'even layout gestures must not mutate shape, z-order, ignore-input mode or visibility');
  assert.deepEqual(report.errors, []);
  await page.screenshot({ path: path.join(output, `desktop-input-${label}.png`), omitBackground: true });
} catch (error) { report.errors.push(error.stack || String(error)); report.eventTrace = await app?.evaluate(() => globalThis.__inputTrace).catch(() => null); report.domTrace = await page?.evaluate(() => window.__inputDOMTrace).catch(() => null); report.hitPlane = await page?.evaluate(() => ({ html: document.querySelector('[data-native-hit-plane]')?.outerHTML, body: getComputedStyle(document.body).backgroundColor })).catch(() => null); await page?.screenshot({ path: path.join(output, `desktop-input-${label}-failure.png`), omitBackground: true }).catch(() => {}); process.exitCode = 1; }
finally {
  if (app) await native([{ type: 'up', x: report.bounds?.x || 0, y: report.bounds?.y || 0 }]).catch(() => {});
  await app?.close().catch(() => {});
  await writeFile(path.join(output, `desktop-input-${label}-report.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
