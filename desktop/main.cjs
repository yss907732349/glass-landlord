const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('node:path');
const { createGameServer } = require('../build/server.cjs');
const { getDesktopLayout } = require('./layout.cjs');
let windowRef, localService, tray;
let displayLayout, displayTimer;
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
  const bounds = displayLayout.bounds;
  windowRef = new BrowserWindow({ ...bounds, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, hasShadow: false, alwaysOnTop: true, show: false, title: '玻璃斗地主', icon: path.join(__dirname, 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.setAlwaysOnTop(true, 'floating');
  windowRef.setMenuBarVisibility(false);
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const appUrl = `http://127.0.0.1:${localService.port}`;
  ipcMain.handle('service-info', event => {
    if (event.sender !== windowRef?.webContents) return { addresses: [] };
    const addresses = Object.values(require('node:os').networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${localService.port}`);
    return { addresses, layout: getDesktopLayout(screen) };
  });
  windowRef.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${appUrl}/`)) event.preventDefault(); });
  ipcMain.on('window-control', (event, command, value) => {
    if (event.sender !== windowRef?.webContents) return;
    if (command === 'pin') windowRef.setAlwaysOnTop(!!value, 'floating');
    else if (command === 'passthrough') windowRef.setIgnoreMouseEvents(!!value, { forward: true });
    else if (command === 'hide') windowRef.hide();
    else if (command === 'minimize') windowRef.minimize();
    else if (command === 'close') app.quit();
  });
  await windowRef.loadURL(appUrl);
  windowRef.show();
  // Windows constrains the initial constructor size to one display. Reapply after showing.
  windowRef.setBounds(displayLayout.bounds);
  globalShortcut.register('CommandOrControl+Shift+H', toggle);
  const updateDisplays = (reset = false) => {
    const previousBounds = displayLayout.bounds;
    displayLayout = getDesktopLayout(screen);
    windowRef.setBounds(displayLayout.bounds);
    windowRef.webContents.send('display-layout', { ...displayLayout, previousBounds, reset });
  };
  globalShortcut.register('CommandOrControl+Shift+0', () => { updateDisplays(true); windowRef.webContents.send('reset-layout'); windowRef.show(); });
  const trayIcon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 });
  tray = new Tray(trayIcon);
  tray.setToolTip('玻璃斗地主 · Ctrl+Shift+H 显示 / 隐藏');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示 / 隐藏牌局', click: toggle }, { label: '置顶显示', type: 'checkbox', checked: true, click: item => windowRef.setAlwaysOnTop(item.checked, 'floating') }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]));
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
app.on('will-quit', () => { clearTimeout(displayTimer); globalShortcut.unregisterAll(); localService?.close(); });
