import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'desktop-online-profile-'));
const expectedServer = 'https://glass-landlord.onrender.com';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
let createdRoom = false;
const report = { checks: [], errors: [], sockets: [], profile, stderr: [] };
try {
  app = await electron.launch({ executablePath: path.join(project, 'release/win-unpacked/玻璃斗地主.exe'), args: [`--user-data-dir=${profile}`], cwd: project, env, timeout: 30000 });
  app.process().stderr?.on('data', chunk => report.stderr.push(chunk.toString()));
  report.app = await app.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') }));
  assert.equal(report.app.version, '0.1.1');
  assert.equal(path.resolve(report.app.userData).toLowerCase(), path.resolve(profile).toLowerCase(), 'Must use an isolated test profile');
  report.checks.push('packaged v0.1.1 launched with isolated user profile');
  page = await app.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(90000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('websocket', socket => report.sockets.push(socket.url()));
  await page.evaluate(() => { localStorage.removeItem('glass-server'); localStorage.removeItem('glass-room'); });
  await page.reload();
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.evaluate(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        window.__onlineSocket = this;
        this.addEventListener('message', event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'state') window.__onlineView = message.state;
            if (message.type === 'closed') window.__onlineClosed = true;
          } catch {}
        });
      }
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const addressField = page.getByLabel('房间服务地址', { exact: true });
  assert.equal(await addressField.inputValue(), expectedServer);
  report.checks.push('new profile settings displayed configured public service');
  await page.getByRole('button', { name: '使用本机服务（离线 / 局域网）', exact: true }).click();
  const localOrigin = await page.evaluate(() => location.origin);
  assert.equal(await addressField.inputValue(), localOrigin);
  assert.equal(await page.evaluate(() => localStorage.getItem('glass-server')), localOrigin);
  report.checks.push('local service shortcut changed address to embedded server origin');
  await page.getByRole('button', { name: '使用默认联机服务', exact: true }).click();
  assert.equal(await addressField.inputValue(), expectedServer);
  assert.equal(await page.evaluate(() => localStorage.getItem('glass-server')), expectedServer);
  await page.screenshot({ path: path.join(output, 'desktop-online-settings.png'), omitBackground: true });
  report.checks.push('default service shortcut restored public address');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('input[name=nickname]').fill('新版联机验收');
  await page.locator('input[name=password]').fill(`qa-${randomBytes(9).toString('hex')}`);
  await page.getByRole('button', { name: '开一桌', exact: true }).click();
  await page.waitForFunction(() => window.__onlineView?.phase === 'lobby');
  createdRoom = true;
  report.room = await page.evaluate(() => ({ code: window.__onlineView.code, selfId: window.__onlineView.selfId }));
  assert.ok(report.sockets.includes('wss://glass-landlord.onrender.com/ws'));
  report.checks.push('created password room through default public secure WebSocket');
  await page.getByRole('button', { name: '添加两位陪练，先玩一局', exact: true }).click();
  await page.waitForFunction(() => window.__onlineView?.players.length === 3);
  await page.getByRole('button', { name: '我准备好了', exact: true }).click();
  await page.waitForFunction(() => window.__onlineView?.players.every(player => player.ready));
  await page.getByRole('button', { name: '开始这局', exact: true }).click();
  await page.waitForFunction(() => window.__onlineView?.phase === 'bidding');
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const state = await page.evaluate(() => ({ phase: window.__onlineView.phase, turn: window.__onlineView.turnId, me: window.__onlineView.selfId }));
    if (state.phase === 'playing') break;
    if (state.phase === 'bidding' && state.turn === state.me) await page.getByRole('button', { name: '3 分', exact: true }).click();
    await page.waitForTimeout(250);
  }
  await page.waitForFunction(() => window.__onlineView?.phase === 'playing');
  report.game = await page.evaluate(() => ({ phase: window.__onlineView.phase, ownCards: window.__onlineView.hand.length, players: window.__onlineView.players.map(player => ({ name: player.name, role: player.role, cards: player.cardCount, connected: player.connected })), desktop: !!window.desktop, transparentBackground: getComputedStyle(document.body).backgroundColor }));
  assert.ok(report.game.ownCards >= 17);
  assert.equal(report.game.desktop, true);
  await page.screenshot({ path: path.join(output, 'desktop-online-playing.png'), omitBackground: true });
  report.checks.push('public room added bots, prepared, bid and entered real play with dealt cards');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '离开', exact: true }).click();
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.waitForFunction(() => window.__onlineClosed === true);
  createdRoom = false;
  report.checks.push('left and closed only the test-created public room');
  assert.equal(report.errors.length, 0);
  report.checks.push('no renderer errors');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack : String(error));
  await page?.screenshot({ path: path.join(output, 'desktop-online-failure.png'), omitBackground: true }).catch(() => {});
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  if (createdRoom && page) {
    await page.evaluate(() => { if (window.__onlineSocket?.readyState === WebSocket.OPEN) window.__onlineSocket.send(JSON.stringify({ type: 'leave' })); }).catch(() => {});
    await page.waitForFunction(() => window.__onlineClosed === true, null, { timeout: 3000 }).catch(() => {});
    report.cleanupAttempted = true;
  }
  await writeFile(path.join(output, 'desktop-online-report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => {});
}
