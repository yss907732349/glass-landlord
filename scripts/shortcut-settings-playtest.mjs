import { chromium } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const vite = await createViteServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const report = { checks: [], errors: [] };
let page;
try {
  page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    window.__shortcutCalls = [];
    const current = () => JSON.parse(localStorage.getItem('mock-hide-shortcut') || JSON.stringify({ ok: true, accelerator: 'Ctrl+Shift+H', mode: 'priority', message: '当前 Ctrl+Shift+H：已启用冲突优先。' }));
    window.desktop = {
      isDesktop: true, pin() {}, passthrough() {}, hide() {}, minimize() {}, close() {},
      info: async () => ({ addresses: [], window: { pinned: true }, hideShortcut: current() }),
      setHideShortcut: async accelerator => {
        window.__shortcutCalls.push(accelerator);
        await new Promise(resolve => setTimeout(resolve, 80));
        if (window.__shortcutFail) return { ...current(), ok: false, message: '快捷键注册失败，原快捷键仍保留。' };
        const state = { ok: true, accelerator, mode: 'priority', message: `当前 ${accelerator}：已启用冲突优先。` };
        localStorage.setItem('mock-hide-shortcut', JSON.stringify(state));
        dispatchEvent(new CustomEvent('glass-shortcut-state', { detail: state }));
        return state;
      },
    };
  });
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const panel = page.locator('.settings-panel');
  const modifiers = page.getByRole('combobox', { name: '隐藏快捷键组合键', exact: true });
  const key = page.getByRole('combobox', { name: '隐藏快捷键按键', exact: true });
  const status = page.locator('.shortcut-status');
  await status.filter({ hasText: '已启用冲突优先' }).waitFor();
  assert.equal(await modifiers.inputValue(), 'Ctrl+Shift');
  assert.equal(await key.inputValue(), 'H');
  assert.equal(await page.getByRole('button', { name: '保存快捷键', exact: true }).isDisabled(), true);
  report.checks.push('desktop settings load the active Ctrl+Shift+H binding and priority registration status');

  await modifiers.selectOption('Ctrl+Alt'); await key.selectOption('J');
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await status.filter({ hasText: 'Ctrl+Alt+J' }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.info())).hideShortcut.accelerator, 'Ctrl+Alt+J');
  assert.deepEqual(await page.evaluate(() => window.__shortcutCalls), ['Ctrl+Alt+J']);
  assert.equal(await page.getByRole('button', { name: '保存快捷键', exact: true }).isDisabled(), true);
  await page.screenshot({ path: fileURLToPath(new URL('shortcut-settings-saved.png', output)), omitBackground: true });
  report.checks.push('saving a new modifier and key sends exactly one request and persists the confirmed binding');

  await page.evaluate(() => { window.__shortcutFail = true; }); await key.selectOption('K');
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await status.filter({ hasText: '注册失败' }).waitFor();
  assert.equal((await page.evaluate(() => window.desktop.info())).hideShortcut.accelerator, 'Ctrl+Alt+J');
  assert.equal(await key.inputValue(), 'K', 'the rejected draft remains editable without replacing the active binding');
  await panel.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await status.filter({ hasText: 'Ctrl+Alt+J' }).waitFor();
  assert.equal(await key.inputValue(), 'J');
  report.checks.push('a failed registration clearly reports failure and reopening settings restores the original active shortcut');

  await page.evaluate(() => { window.__shortcutFail = false; });
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await status.filter({ hasText: 'Ctrl+Shift+H' }).waitFor();
  assert.equal(await modifiers.inputValue(), 'Ctrl+Shift'); assert.equal(await key.inputValue(), 'H');
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.shortcut-status').filter({ hasText: 'Ctrl+Shift+H' }).waitFor();
  report.checks.push('restoring the default binding updates both selectors and survives a page reload');
  await page.evaluate(() => dispatchEvent(new CustomEvent('glass-shortcut-state', { detail: { ok: true, accelerator: 'Ctrl+Shift+H', mode: 'global', message: '快捷键可用，冲突优先暂未启用。' } })));
  await status.filter({ hasText: '冲突优先暂未启用' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存快捷键', exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.__shortcutFail = true; });
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await status.filter({ hasText: '注册失败' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存快捷键', exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.__shortcutFail = false; });
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await status.filter({ hasText: '已启用冲突优先' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存快捷键', exact: true }).isDisabled(), true);
  report.checks.push('an unchanged binding can retry after fallback or failure and becomes disabled only after priority registration succeeds');
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.errors.push(error.stack || String(error)); process.exitCode = 1;
  await page?.screenshot({ path: fileURLToPath(new URL('shortcut-settings-failure.png', output)), omitBackground: true }).catch(() => {});
  console.error(JSON.stringify(report, null, 2));
} finally {
  await writeFile(new URL('shortcut-settings-playtest-report.json', output), JSON.stringify(report, null, 2));
  await browser.close(); await vite.close();
}
