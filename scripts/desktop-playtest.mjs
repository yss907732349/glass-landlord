import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const report = { checks: [], errors: [], stderr: [] };
try {
  app = await electron.launch({ executablePath: path.join(project, 'release/win-unpacked/玻璃斗地主.exe'), cwd: project, env, timeout: 25000 });
  app.process().stderr?.on('data', chunk => report.stderr.push(chunk.toString()));
  const page = await app.firstWindow({ timeout: 25000 });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor({ timeout: 20000 });
  report.window = await page.evaluate(() => ({ title: document.title, background: getComputedStyle(document.body).backgroundColor, desktop: !!window.desktop, url: location.href, body: document.body.innerText.slice(0, 180) }));
  report.native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ background: window.getBackgroundColor(), alwaysOnTop: window.isAlwaysOnTop(), bounds: window.getBounds(), url: window.webContents.getURL() })));
  report.checks.push('packaged app loaded from its embedded room service');
  await page.evaluate(() => {
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          try { const message = JSON.parse(event.data); if (message.type === 'state') window.__packagedView = message.state; } catch {}
        });
      }
    };
  });
  await page.locator('input[name=nickname]').fill('打包验收');
  await page.locator('input[name=password]').fill('packaged-test');
  await page.getByRole('button', { name: '开一桌', exact: true }).click();
  await page.waitForFunction(() => window.__packagedView?.phase === 'lobby');
  report.checks.push('room created with a password over packaged WebSocket server');
  await page.getByRole('button', { name: '添加两位陪练，先玩一局' }).click();
  await page.waitForFunction(() => window.__packagedView?.players.length === 3);
  await page.getByRole('button', { name: '我准备好了', exact: true }).click();
  await page.waitForFunction(() => window.__packagedView?.players.every(player => player.ready));
  await page.getByRole('button', { name: '开始这局', exact: true }).click();
  await page.waitForFunction(() => window.__packagedView?.phase === 'bidding');
  report.checks.push('bots joined, all three ready, and a real game started');
  report.game = await page.evaluate(() => ({ phase: window.__packagedView.phase, players: window.__packagedView.players.map(player => ({ name: player.name, ready: player.ready, connected: player.connected, cards: player.cardCount })), ownCards: window.__packagedView.hand.length }));
  await page.screenshot({ path: path.join(output, 'desktop-packaged.png'), omitBackground: true });
  report.checks.push('transparent packaged window screenshot captured');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack : String(error));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await writeFile(path.join(output, 'desktop-packaged-report.json'), JSON.stringify(report, null, 2));
  await app?.close().catch(() => {});
}
