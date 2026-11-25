const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createGameServer } = require('../build/server.cjs');
const { getDesktopLayout } = require('./layout.cjs');
const { HideShortcutController } = require('./shortcuts.cjs');
let windowRef, localService, tray, trayMenu, displayLayout, displayTimer, cropTimer, diagnosticTimer, hideShortcuts;
let nativeFrame, frameRevision = 1, tableRegion, lastKnownTableRegion, lastTableKey = '', pendingLayout = false;
let interactionLocked = false, layoutGesture = false, layoutSuspended = false, userPinned = true;
const transitions = [];
const PADDING = 48;
const sameBounds = (a, b) => a && b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
const isTest = process.argv.includes('--smoke-test');
function diagnostics() {
  return { version: app.getVersion(), at: Date.now(), frame: nativeFrame, events: transitions };
}
function record(type, detail = {}) {
  transitions.push({ at: Date.now(), type, ...detail });
  if (transitions.length > 100) transitions.shift();
  clearTimeout(diagnosticTimer);
  diagnosticTimer = setTimeout(() => {
    fs.writeFile(path.join(app.getPath('userData'), 'window-diagnostics.json'), JSON.stringify(diagnostics(), null, 2), () => {});
  }, 250);
}
function initialFrame(layout) {
  const fit = Math.min(layout.primary.width / 1120, layout.primary.height / 600, 1.25);
  const width = Math.min(layout.bounds.width, Math.ceil(1080 * fit + PADDING * 2));
  const height = Math.min(layout.bounds.height, Math.ceil(560 * fit + PADDING * 2));
  return { x: Math.round(layout.bounds.x + layout.primary.x + (layout.primary.width - width) / 2), y: Math.round(layout.bounds.y + layout.primary.y + (layout.primary.height - height) / 2), width, height };
}
function setNativeFrame(frame, reason, force = false) {
  if (!windowRef || windowRef.isDestroyed() || (!force && sameBounds(frame, nativeFrame))) return;
  clearTimeout(cropTimer);
  tableRegion = null; frameRevision++;
  windowRef.setBounds(frame); nativeFrame = windowRef.getContentBounds();
  record('frame', { reason, frame: nativeFrame, revision: frameRevision });
  windowRef.webContents.send('native-frame', { ...nativeFrame, revision: frameRevision });
}
function scheduleCrop() {
  clearTimeout(cropTimer);
  if (!pendingLayout || interactionLocked || layoutSuspended || !tableRegion || !windowRef?.isVisible()) return;
  cropTimer = setTimeout(() => {
    if (!pendingLayout || interactionLocked || layoutSuspended || !tableRegion || !windowRef?.isVisible()) return;
    const desktop = displayLayout.bounds;
    const x = Math.max(desktop.x, Math.floor(tableRegion.x - PADDING));
    const y = Math.max(desktop.y, Math.floor(tableRegion.y - PADDING));
    const right = Math.min(desktop.x + desktop.width, Math.ceil(tableRegion.x + tableRegion.width + PADDING));
    const bottom = Math.min(desktop.y + desktop.height, Math.ceil(tableRegion.y + tableRegion.height + PADDING));
    pendingLayout = false;
    setNativeFrame(right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : initialFrame(displayLayout), 'layout-settled');
  }, 120);
}
function abortInteraction(suspend = false) {
  // Ordinary focus changes leave native state alone. An interrupted layout must
  // release its expanded desktop-sized input area even if the renderer is paused.
  const expanded = displayLayout && sameBounds(nativeFrame, displayLayout.bounds);
  interactionLocked = false; layoutGesture = false; layoutSuspended = suspend && !expanded; clearTimeout(cropTimer);
  if (suspend && expanded) {
    pendingLayout = true; tableRegion ||= lastKnownTableRegion;
    if (tableRegion) scheduleCrop();
    else { pendingLayout = false; setNativeFrame(initialFrame(displayLayout), 'layout-aborted'); }
  }
}
function toggle() {
  if (!windowRef) return;
  record('command', { command: 'toggle' });
  if (windowRef.isVisible() && !windowRef.isMinimized()) windowRef.hide();
  else { if (windowRef.isMinimized()) windowRef.restore(); windowRef.show(); windowRef.focus(); scheduleCrop(); }
}
app.setAppUserModelId('friends.glass.landlord');
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (windowRef?.isMinimized()) windowRef.restore(); windowRef?.show(); windowRef?.focus(); });
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const serviceOptions = { port: 4318, host: '0.0.0.0', staticDir: path.join(__dirname, '../dist') };
  try { localService = await createGameServer(serviceOptions); }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; localService = await createGameServer({ ...serviceOptions, port: 0 }); }
  displayLayout = getDesktopLayout(screen);
  const bounds = initialFrame(displayLayout);
  windowRef = new BrowserWindow({ ...bounds, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, hasShadow: false, alwaysOnTop: true, show: false, title: '玻璃斗地主', icon: path.join(__dirname, 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.setAlwaysOnTop(true, 'floating');
  windowRef.setIgnoreMouseEvents(false);
  windowRef.setMenu(null);
  nativeFrame = windowRef.getContentBounds();
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && !input.alt && ['+', '=', '-', '0', 'Add', 'Subtract'].includes(input.key) && !(input.shift && input.key === '0')) event.preventDefault();
  });
  windowRef.webContents.on('zoom-changed', event => { event.preventDefault(); });
  const appUrl = `http://127.0.0.1:${localService.port}`;
  ipcMain.handle('service-info', event => {
    if (event.sender !== windowRef?.webContents) return { addresses: [] };
    const addresses = Object.values(require('node:os').networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${localService.port}`);
    const regions = tableRegion ? [{ x: tableRegion.x - nativeFrame.x - 24, y: tableRegion.y - nativeFrame.y - 24, width: tableRegion.width + 48, height: tableRegion.height + 48 }] : [];
    return { addresses, layout: displayLayout, frame: nativeFrame, frameRevision, interaction: { mode: 'stable-window', ignored: false, locked: interactionLocked, layoutGesture, revision: frameRevision, regionsRevision: tableRegion ? frameRevision : 0, regions }, window: { visible: windowRef.isVisible(), minimized: windowRef.isMinimized(), pinned: windowRef.isAlwaysOnTop(), focused: windowRef.isFocused(), zoomFactor: windowRef.webContents.getZoomFactor() }, diagnostics: transitions, hideShortcut: hideShortcuts?.snapshot() };
  });
  windowRef.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${appUrl}/`)) event.preventDefault(); });
  ipcMain.on('window-control', (event, command, value) => {
    if (event.sender !== windowRef?.webContents) return;
    record('command', { command, ...(command === 'pin' ? { value: !!value } : {}) });
    if (command === 'pin' && userPinned !== !!value) { userPinned = !!value; windowRef.setAlwaysOnTop(userPinned, 'floating'); }
    else if (command === 'hide') windowRef.hide();
    else if (command === 'minimize') windowRef.minimize();
    else if (command === 'close') app.quit();
  });
  ipcMain.on('interaction-regions', (event, message) => {
    if (event.sender !== windowRef?.webContents || message?.revision !== frameRevision || !Array.isArray(message.regions)) return;
    const rect = message.regions[0];
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
    tableRegion = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    lastKnownTableRegion = tableRegion;
    const key = JSON.stringify(tableRegion);
    if (key !== lastTableKey) { lastTableKey = key; pendingLayout = true; }
    scheduleCrop();
  });
  ipcMain.on('interaction-lock', (event, message) => {
    if (event.sender !== windowRef?.webContents) return;
    const wasGesture = layoutGesture;
    interactionLocked = !!message?.locked;
    layoutGesture = interactionLocked && !!message?.layoutGesture;
    if (message?.reason === 'blur' || message?.reason === 'hidden') { abortInteraction(true); return; }
    if (layoutGesture && !wasGesture) { layoutSuspended = false; pendingLayout = true; setNativeFrame(displayLayout.bounds, 'layout-start'); }
    if (interactionLocked) clearTimeout(cropTimer);
    else { if (wasGesture) pendingLayout = true; scheduleCrop(); }
  });
  for (const name of ['blur', 'hide', 'minimize']) windowRef.on(name, () => { record(name); abortInteraction(true); });
  for (const name of ['show', 'restore', 'focus', 'always-on-top-changed']) windowRef.on(name, () => {
    record(name, { pinned: windowRef.isAlwaysOnTop() });
    if (name === 'always-on-top-changed') {
      userPinned = windowRef.isAlwaysOnTop();
      const pinItem = trayMenu?.getMenuItemById('pin'); if (pinItem) pinItem.checked = userPinned;
      if (!windowRef.webContents.isDestroyed()) windowRef.webContents.send('window-state', { pinned: userPinned });
    }
    if (name === 'focus' || name === 'restore') { layoutSuspended = false; scheduleCrop(); }
  });
  windowRef.webContents.on('render-process-gone', (_event, details) => { record('renderer-gone', { reason: details.reason, exitCode: details.exitCode }); abortInteraction(true); });
  windowRef.webContents.on('did-start-navigation', () => { lastTableKey = ''; pendingLayout = false; abortInteraction(true); });
  windowRef.webContents.on('did-finish-load', () => { windowRef.webContents.setZoomFactor(1); layoutSuspended = false; scheduleCrop(); });
  await windowRef.loadURL(appUrl);
  await windowRef.webContents.setVisualZoomLevelLimits(1, 1);
  windowRef.show();
  // Windows/Electron may finish initializing DPI metrics with the first HWND.
  // Publish one shared snapshot to both native geometry and renderer layout.
  const readyLayout = getDesktopLayout(screen);
  if (JSON.stringify(readyLayout) !== JSON.stringify(displayLayout)) {
    const previousBounds = displayLayout.bounds; displayLayout = readyLayout;
    windowRef.webContents.send('display-layout', { ...displayLayout, previousBounds, reset: true });
  }
  setNativeFrame(initialFrame(displayLayout), 'startup', true);
  hideShortcuts = new HideShortcutController({
    globalShortcut, userData: app.getPath('userData'),
    helperPath: app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked/build/hotkey-helper.exe') : path.join(__dirname, '../build/hotkey-helper.exe'),
    sourcePath: path.join(__dirname, 'hotkey-helper.cs'), packaged: app.isPackaged,
    onTrigger: toggle,
    onChange: state => {
      record('shortcut', { accelerator: state.accelerator, mode: state.mode, ok: state.ok });
      tray?.setToolTip(`玻璃斗地主 · ${state.accelerator} 显示 / 隐藏${state.ok ? '' : '（快捷键未启用）'}`);
      if (!windowRef?.webContents.isDestroyed()) windowRef?.webContents.send('shortcut-state', state);
    },
  });
  ipcMain.handle('set-hide-shortcut', async (event, accelerator) => {
    if (event.sender !== windowRef?.webContents) return { ok: false, accelerator: '', mode: 'unavailable', message: '无权修改快捷键。' };
    return hideShortcuts.set(accelerator);
  });
  await hideShortcuts.start();
  const updateDisplays = (reset = false) => {
    const previousBounds = displayLayout.bounds;
    displayLayout = getDesktopLayout(screen); abortInteraction(); lastTableKey = '';
    windowRef.webContents.send('display-layout', { ...displayLayout, previousBounds, reset });
    setNativeFrame(initialFrame(displayLayout), reset ? 'reset' : 'displays-changed', true);
  };
  globalShortcut.register('CommandOrControl+Shift+0', () => { record('command', { command: 'reset' }); updateDisplays(true); windowRef.webContents.send('reset-layout'); if (windowRef.isMinimized()) windowRef.restore(); windowRef.show(); });
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon); tray.setToolTip(`玻璃斗地主 · ${hideShortcuts.snapshot().accelerator} 显示 / 隐藏${hideShortcuts.snapshot().ok ? '' : '（快捷键未启用）'}`);
  trayMenu = Menu.buildFromTemplate([{ label: '显示 / 隐藏牌局', click: toggle }, { id: 'pin', label: '置顶显示', type: 'checkbox', checked: userPinned, click: item => { if (userPinned !== item.checked) { record('command', { command: 'pin', value: item.checked }); userPinned = item.checked; windowRef.setAlwaysOnTop(userPinned, 'floating'); } } }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]);
  tray.setContextMenu(trayMenu);
  tray.on('double-click', toggle);
  const queueDisplayUpdate = () => { clearTimeout(displayTimer); displayTimer = setTimeout(() => { if (windowRef && !windowRef.isDestroyed()) updateDisplays(); }, 100); };
  screen.on('display-added', queueDisplayUpdate); screen.on('display-removed', queueDisplayUpdate); screen.on('display-metrics-changed', queueDisplayUpdate);
  if (isTest) {
    await new Promise(resolve => setTimeout(resolve, 1300));
    console.log('DESKTOP_SMOKE', await windowRef.webContents.executeJavaScript(`JSON.stringify({title:document.title,background:getComputedStyle(document.body).backgroundColor,desktop:!!window.desktop})`));
    const destination = path.join(process.env.PORTABLE_EXECUTABLE_DIR || process.cwd(), 'artifacts'); fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'desktop-smoke.png'), (await windowRef.webContents.capturePage()).toPNG()); app.quit();
  }
}).catch(error => { console.error('桌面启动失败', error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  clearTimeout(displayTimer); clearTimeout(cropTimer); clearTimeout(diagnosticTimer); hideShortcuts?.close(); globalShortcut.unregisterAll(); localService?.close();
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'window-diagnostics.json'), JSON.stringify(diagnostics(), null, 2)); } catch {}
});
