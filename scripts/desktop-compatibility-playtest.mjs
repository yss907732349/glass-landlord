import { _electron as electron } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'desktop-compatibility-profile-'));
const expectedVersion = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(server, 'listening');
const address = `http://127.0.0.1:${server.address().port}`;
const report = { checks: [], errors: [], profile, address, received: [] };
server.on('connection', socket => socket.on('message', data => {
  const request = JSON.parse(data);
  report.received.push(request.type);
  if (request.type === 'create') {
    socket.send(JSON.stringify({ type: 'joined', code: '000001', playerId: 'compatibility-only', token: 'local-test-only' }));
    socket.send(JSON.stringify({ type: 'state', state: { code: '000001' } }));
  }
}));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await electron.launch({ executablePath: path.join(project, 'release/win-unpacked/玻璃斗地主.exe'), args: [`--user-data-dir=${profile}`], cwd: project, env, timeout: 30000 });
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), expectedVersion);
  page = await app.firstWindow();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.evaluate(value => { localStorage.setItem('glass-server', value); localStorage.removeItem('glass-room'); }, address);
  await page.reload();
  await page.locator('input[name=nickname]').fill('兼容验收');
  await page.locator('input[name=password]').fill('local-compatibility-test');
  await page.getByRole('button', { name: '开一桌', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '房间服务还是旧版，请更新服务后再联机。离线游玩可在设置中切换本机服务。' }).waitFor();
  assert.ok(report.received.includes('leave'));
  assert.equal(await page.evaluate(() => localStorage.getItem('glass-room')), null);
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  assert.deepEqual(report.errors, []);
  await page.screenshot({ path: path.join(output, 'desktop-compatibility-old-service.png'), omitBackground: true });
  report.checks.push('final packaged app detected a local simulated legacy state before rendering it', 'legacy connection received leave; saved room cleared and lobby restored', 'clear update-service message shown without renderer errors; no public service contacted');
} catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
finally {
  await app?.close().catch(() => {});
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'desktop-compatibility-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
