import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No keyboard input or native pointer input is sent by this smoke test. Only
// its own isolated Electron instance is closed; existing user apps are untouched.
const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'desktop-shortcut-profile-'));
const executable = path.join(project, 'release/win-unpacked/玻璃斗地主.exe');
const helper = path.join(project, 'release/win-unpacked/resources/app.asar.unpacked/build/hotkey-helper.exe');
const expectedVersion = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const report = { checks: [], errors: [], stderr: [], profile, helpers: [] };
let app, page, ownedPid;

function helpers() {
  const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'hotkey-helper.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true }).trim();
  if (!value) return [];
  const rows = JSON.parse(value); return Array.isArray(rows) ? rows : [rows];
}
async function ownedHelpers() {
  return helpers().filter(item => item.ParentProcessId === ownedPid && path.resolve(item.ExecutablePath || '').toLowerCase() === helper.toLowerCase());
}
async function waitForOwnedHelper() {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const rows = await ownedHelpers();
    if (rows.length === 1) { report.helpers.push(rows[0]); return rows[0]; }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`The packaged app ${ownedPid} did not own exactly one unpacked priority helper: ${JSON.stringify(helpers())}; expected ${helper}`);
}
async function assertReleased(pid, knownHelpers) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const remaining = helpers().filter(item => item.ParentProcessId === pid || knownHelpers.includes(item.ProcessId));
    if (!remaining.length) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Shortcut helper remained after owned application ${pid} exited.`);
}
async function click(locator) { await locator.evaluate(element => element.click()); }
async function info() { return page.evaluate(() => window.desktop.info()); }
async function waitShortcut(predicate) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const state = (await info()).hideShortcut;
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out awaiting shortcut: ${JSON.stringify((await info()).hideShortcut)}`);
}
async function launch() {
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], cwd: project, env, timeout: 30000 });
  ownedPid = app.process().pid;
  app.process().stderr?.on('data', chunk => report.stderr.push(chunk.toString()));
  const native = await app.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData'), packaged: app.isPackaged, pid: process.pid }));
  report.native = native; ownedPid = native.pid;
  assert.equal(native.version, expectedVersion); assert.equal(native.packaged, true);
  assert.equal(path.resolve(native.userData).toLowerCase(), profile.toLowerCase());
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  const state = await waitShortcut(state => state?.mode === 'priority'); report.startupState = state;
  assert.equal(state.ok, true); assert.equal(state.mode, 'priority');
  await waitForOwnedHelper();
  return state;
}
async function closeOwned() {
  if (!app) return;
  const pid = ownedPid, known = report.helpers.filter(item => item.ParentProcessId === pid).map(item => item.ProcessId);
  const ownedApp = app; app = undefined; page = undefined;
  await ownedApp.close();
  await assertReleased(pid, known);
}
async function saveShortcut(modifiers, key, accelerator) {
  await page.getByRole('combobox', { name: '隐藏快捷键组合键', exact: true }).selectOption(modifiers);
  await page.getByRole('combobox', { name: '隐藏快捷键按键', exact: true }).selectOption(key);
  await click(page.getByRole('button', { name: '保存快捷键', exact: true }));
  await waitShortcut(state => state.accelerator === accelerator && state.ok && state.mode === 'priority');
  await page.locator('.shortcut-status').filter({ hasText: '已启用冲突优先' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '保存快捷键', exact: true }).isDisabled(), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'shortcuts.json'), 'utf8')), { hideShortcut: accelerator });
  await waitForOwnedHelper();
}

try {
  assert.ok((await stat(helper)).size > 0);
  const initial = await launch(); assert.equal(initial.accelerator, 'Ctrl+Shift+H');
  report.checks.push('packaged app owns its physically unpacked priority helper in an isolated profile');
  await click(page.getByRole('button', { name: '设置', exact: true }));
  await page.locator('.shortcut-status').filter({ hasText: '已启用冲突优先' }).waitFor();
  await saveShortcut('Ctrl+Alt', 'J', 'Ctrl+Alt+J');
  report.checks.push('settings save Ctrl+Alt+J through real IPC and persist the actual priority binding');
  const rejected = await page.evaluate(() => window.desktop.setHideShortcut('Alt+F4'));
  assert.equal(rejected.ok, false); assert.equal(rejected.accelerator, 'Ctrl+Alt+J');
  assert.equal((await info()).hideShortcut.accelerator, 'Ctrl+Alt+J');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'shortcuts.json'), 'utf8')).hideShortcut, 'Ctrl+Alt+J');
  report.checks.push('reserved Alt+F4 is rejected without replacing the active binding or saved configuration');
  await closeOwned();
  report.checks.push('first owned application exit releases all of its priority helpers');
  const restarted = await launch(); assert.equal(restarted.accelerator, 'Ctrl+Alt+J');
  await click(page.getByRole('button', { name: '设置', exact: true }));
  await expect(page.getByRole('combobox', { name: '隐藏快捷键组合键', exact: true })).toHaveValue('Ctrl+Alt');
  await expect(page.getByRole('combobox', { name: '隐藏快捷键按键', exact: true })).toHaveValue('J');
  report.checks.push('restarting the packaged app in the same profile restores Ctrl+Alt+J in priority mode and settings');
  await click(page.getByRole('button', { name: '恢复默认', exact: true }));
  await waitShortcut(state => state.accelerator === 'Ctrl+Shift+H');
  await page.locator('.shortcut-status').filter({ hasText: '已启用冲突优先' }).waitFor();
  assert.equal((await info()).hideShortcut.mode, 'priority');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'shortcuts.json'), 'utf8')).hideShortcut, 'Ctrl+Shift+H');
  await waitForOwnedHelper();
  await page.screenshot({ path: path.join(output, 'desktop-shortcut-packaged.png'), omitBackground: true });
  report.checks.push('restore-default updates and saves Ctrl+Shift+H with the real native priority helper');
  await closeOwned();
  report.checks.push('final owned application exit releases its helper without sending system keyboard or mouse input');
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.errors.push(error.stack || String(error)); process.exitCode = 1;
  await page?.screenshot({ path: path.join(output, 'desktop-shortcut-packaged-failure.png'), omitBackground: true }).catch(() => {});
} finally {
  try { await closeOwned(); } catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1; }
  await writeFile(path.join(output, 'desktop-shortcut-packaged-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
