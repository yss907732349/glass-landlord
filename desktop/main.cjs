const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('node:path');
const { createGameServer } = require('../build/server.cjs');
const { getDesktopLayout } = require('./layout.cjs');
let windowRef, localService, tray;
let displayLayout, displayTimer, cropTimer, nativeFrame, frameRevision = 1;
let safeRegions = [], safeRevision = 0, interactionLocked = false, layoutGesture = false, shapeRevision = 0, shapeMode = 'native-shape', currentShape = [], lastShapeKey = '', userPinned = true;
const sameBounds = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
function initialFrame(layout) {
  const fit = Math.min(layout.primary.width / 1120, layout.primary.height / 600, 1.25);
  const width = Math.min(layout.bounds.width, Math.ceil(1080 * fit + 64));
  const height = Math.min(layout.bounds.height, Math.ceil(560 * fit + 64));
  return { x: Math.round(layout.bounds.x + layout.primary.x + (layout.primary.width - width) / 2), y: Math.round(layout.bounds.y + layout.primary.y + (layout.primary.height - height) / 2), width, height };
}
function publishFrame() { windowRef.webContents.send('native-frame', { ...nativeFrame, revision: frameRevision }); }
function setNativeFrame(frame, force = false) {
  if (!windowRef || windowRef.isDestroyed() || (!force && sameBounds(frame, nativeFrame))) return;
  clearTimeout(cropTimer);
  safeRegions = []; safeRevision = 0; frameRevision++;
  windowRef.setBounds(frame); nativeFrame = windowRef.getContentBounds();
  lastShapeKey = ''; applyInteractionShape(); publishFrame();
}
function scheduleCrop() {
  clearTimeout(cropTimer);
  if (interactionLocked || layoutGesture || safeRevision !== frameRevision || !safeRegions.length) return;
  cropTimer = setTimeout(() => {
    if (interactionLocked || layoutGesture || safeRevision !== frameRevision || !safeRegions.length) return;
    const desktop = displayLayout.bounds;
    const x = Math.max(desktop.x, Math.floor(Math.min(...safeRegions.map(rect => rect.x)) - 32));
    const y = Math.max(desktop.y, Math.floor(Math.min(...safeRegions.map(rect => rect.y)) - 32));
    const right = Math.min(desktop.x + desktop.width, Math.ceil(Math.max(...safeRegions.map(rect => rect.x + rect.width)) + 32));
    const bottom = Math.min(desktop.y + desktop.height, Math.ceil(Math.max(...safeRegions.map(rect => rect.y + rect.height)) + 32));
    const target = right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : initialFrame(displayLayout);
    setNativeFrame(target);
  }, 40);
}
function applyInteractionShape() {
  if (!windowRef || windowRef.isDestroyed()) return;
  const bounds = windowRef.getContentBounds();
  const full = [{ x: 0, y: 0, width: bounds.width, height: bounds.height }];
  const regions = interactionLocked || safeRevision !== frameRevision || !safeRegions.length ? full : safeRegions.map(rect => {
    const x = Math.max(0, Math.floor(rect.x - bounds.x - 24));
    const y = Math.max(0, Math.floor(rect.y - bounds.y - 24));
    const right = Math.min(bounds.width, Math.ceil(rect.x + rect.width - bounds.x + 24));
    const bottom = Math.min(bounds.height, Math.ceil(rect.y + rect.height - bounds.y + 24));
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }).filter(rect => rect.width > 0 && rect.height > 0);
  const shape = regions.length ? regions : full;
  const key = JSON.stringify(shape);
  if (key === lastShapeKey) return;
  windowRef.setIgnoreMouseEvents(false);
  try { windowRef.setShape(shape); shapeMode = 'native-shape'; }
  catch (error) { shapeMode = 'safe-full-window'; console.error('Native interaction shape unavailable:', error.message); }
  // Reapplying a Windows region can change native z-order; retain the user's pin setting.
  windowRef.setAlwaysOnTop(false);
  if (userPinned) windowRef.setAlwaysOnTop(true, 'floating');
  lastShapeKey = key; currentShape = shape; shapeRevision++;
}
function releaseInteraction() { interactionLocked = false; layoutGesture = false; applyInteractionShape(); scheduleCrop(); }
const isTest = process.argv.includes('--smoke-test');
app.setAppUserModelId('friends.glass.landlord');
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { windowRef?.show(); windowRef?.focus(); });
function toggle() { if (!windowRef) return; if (windowRef.isVisible()) windowRef.hide(); else { windowRef.show(); windowRef.focus(); } }
app.whenReady().then(async () => {
  const serviceOptions = { port: 4318, host: '0.0.0.0', staticDir: path.join(__dirname, '../dist') };
  try { localService = await createGameServer(serviceOptions); }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; localService = await createGameServer({ ...serviceOptions, port: 0 }); }
  displayLayout = getDesktopLayout(screen);
  const bounds = initialFrame(displayLayout);
  windowRef = new BrowserWindow({ ...bounds, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, hasShadow: false, alwaysOnTop: true, show: false, title: '玻璃斗地主', icon: path.join(__dirname, 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.setAlwaysOnTop(true, 'floating');
  nativeFrame = windowRef.getContentBounds();
  windowRef.setMenuBarVisibility(false);
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const appUrl = `http://127.0.0.1:${localService.port}`;
  ipcMain.handle('service-info', event => {
    if (event.sender !== windowRef?.webContents) return { addresses: [] };
    const addresses = Object.values(require('node:os').networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${localService.port}`);
    return { addresses, layout: getDesktopLayout(screen), frame: nativeFrame, frameRevision, interaction: { mode: shapeMode, ignored: false, locked: interactionLocked, layoutGesture, revision: shapeRevision, regionsRevision: safeRevision, regions: currentShape } };
  });
  windowRef.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${appUrl}/`)) event.preventDefault(); });
  ipcMain.on('window-control', (event, command, value) => {
    if (event.sender !== windowRef?.webContents) return;
    if (command === 'pin') { userPinned = !!value; windowRef.setAlwaysOnTop(userPinned, 'floating'); }
    else if (command === 'passthrough') windowRef.setIgnoreMouseEvents(false);
    else if (command === 'hide') windowRef.hide();
    else if (command === 'minimize') windowRef.minimize();
    else if (command === 'close') app.quit();
  });
  ipcMain.on('interaction-regions', (event, message) => {
    if (event.sender !== windowRef?.webContents || message?.revision !== frameRevision || !Array.isArray(message.regions)) return;
    safeRegions = message.regions.slice(0, 100).filter(rect => rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0);
    safeRevision = frameRevision; applyInteractionShape(); scheduleCrop();
  });
  ipcMain.on('interaction-lock', (event, message) => {
    if (event.sender !== windowRef?.webContents) return;
    interactionLocked = !!message?.locked;
    layoutGesture = interactionLocked && !!message?.layoutGesture;
    if (layoutGesture) setNativeFrame(displayLayout.bounds);
    applyInteractionShape(); if (!interactionLocked) scheduleCrop(); else clearTimeout(cropTimer);
  });
  windowRef.on('blur', releaseInteraction);
  windowRef.on('hide', releaseInteraction);
  windowRef.webContents.on('did-start-navigation', () => { safeRegions = []; safeRevision = 0; interactionLocked = false; layoutGesture = false; lastShapeKey = ''; applyInteractionShape(); });
  await windowRef.loadURL(appUrl);
  windowRef.show();
  // Reapply after showing: Windows can constrain constructor geometry to one display.
  setNativeFrame(bounds, true);
  globalShortcut.register('CommandOrControl+Shift+H', toggle);
  const updateDisplays = (reset = false) => {
    const previousBounds = displayLayout.bounds;
    displayLayout = getDesktopLayout(screen);
    windowRef.webContents.send('display-layout', { ...displayLayout, previousBounds, reset });
    setNativeFrame(initialFrame(displayLayout), true);
  };
  globalShortcut.register('CommandOrControl+Shift+0', () => { updateDisplays(true); windowRef.webContents.send('reset-layout'); windowRef.show(); });
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip('玻璃斗地主 · Ctrl+Shift+H 显示 / 隐藏');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示 / 隐藏牌局', click: toggle }, { label: '置顶显示', type: 'checkbox', checked: true, click: item => { userPinned = item.checked; windowRef.setAlwaysOnTop(userPinned, 'floating'); } }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
  tray.on('double-click', toggle);
  const queueDisplayUpdate = () => {
    clearTimeout(displayTimer);
    displayTimer = setTimeout(() => { if (windowRef && !windowRef.isDestroyed()) updateDisplays(); }, 100);
  };
  screen.on('display-added', queueDisplayUpdate);
  screen.on('display-removed', queueDisplayUpdate);
  screen.on('display-metrics-changed', queueDisplayUpdate);
  if (isTest) {
    await new Promise(resolve => setTimeout(resolve, 1300));
    const report = await windowRef.webContents.executeJavaScript(`JSON.stringify({title:document.title,background:getComputedStyle(document.body).backgroundColor,desktop:!!window.desktop,content:document.body.innerText.slice(0,160)})`);
    console.log('DESKTOP_SMOKE', report, 'transparent', windowRef.isAlwaysOnTop());
    await windowRef.webContents.capturePage().then(image => require('node:fs').writeFileSync(path.join(process.cwd(), 'artifacts/desktop-smoke.png'), image.toPNG()));
    app.quit();
  }
}).catch(error => { console.error('桌面启动失败', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { clearTimeout(displayTimer); clearTimeout(cropTimer); globalShortcut.unregisterAll(); localService?.close(); });
