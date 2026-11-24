import { _electron as electron } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
await mkdir(path.join(project, 'artifacts'), { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.join(project, 'node_modules/electron/dist/electron.exe'), args: [project, `--user-data-dir=${path.join(project, 'artifacts/preview-profile')}`], cwd: project, env });
try {
  const page = await app.firstWindow();
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('glass-server', location.origin); });
  await page.reload();
  await page.locator('input[name=nickname]').fill('桌边玩家');
  await page.locator('input[name=password]').fill('preview');
  await page.getByRole('button', { name: '开一桌', exact: true }).click();
  await page.getByRole('button', { name: '添加两位陪练，先玩一局' }).click();
  await page.getByRole('button', { name: '我准备好了', exact: true }).click();
  const start = page.getByRole('button', { name: '开始这局', exact: true });
  await start.waitFor(); await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '开始这局')?.disabled);
  await start.click();
  await page.locator('.own-hand .playing-card').first().waitFor();
  await page.getByRole('button', { name: '3 分', exact: true }).click({ timeout: 10000 }).catch(() => {});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Native Electron capture preserves alpha; the preview can be composited on any desktop colour.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const image = await window.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  await writeFile(path.join(project, 'artifacts/desktop-glass-transparent.png'), Buffer.from(png, 'base64'));
  console.log(JSON.stringify(await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], textShadow: getComputedStyle(document.querySelector('.card-corner')).textShadow, cardBackground: getComputedStyle(document.querySelector('.playing-card')).backgroundColor, stageOpacity: getComputedStyle(document.querySelector('.table-shell')).opacity, bodyBackground: getComputedStyle(document.body).backgroundColor, oldSymbols: document.querySelectorAll('.card-suit,.opposite').length })), null, 2));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('slider', { name: '整体透明度', exact: true }).fill('50');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.settings-panel').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const faded = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(project, 'artifacts/desktop-ui-50-transparent.png'), Buffer.from(faded, 'base64'));
} finally { await app.close(); }
