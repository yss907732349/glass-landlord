import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { HideShortcutController, parseHideShortcut } = require('../desktop/shortcuts.cjs');

function globalKeys() {
  const bindings = new Map<string, () => void>();
  const denied = new Set<string>();
  return { bindings, denied, register(key: string, callback: () => void) { if (denied.has(key) || bindings.has(key)) return false; bindings.set(key, callback); return true; }, unregister(key: string) { bindings.delete(key); } };
}
function fixture(extra: Record<string, unknown> = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), 'landlord-shortcut-test-'));
  const globalShortcut = globalKeys();
  const controller = new HideShortcutController({ userData, globalShortcut, helperPath: process.execPath, platform: 'linux', onTrigger() {}, ...extra });
  return { controller, globalShortcut, userData, cleanup() { controller.close(); rmSync(userData, { recursive: true, force: true }); } };
}
class Helper extends EventEmitter {
  stdout = new PassThrough(); stdin = new PassThrough(); exitCode: number | null = null;
  kill() { if (this.exitCode === null) { this.exitCode = 1; this.emit('exit', 1); } return true; }
}

test('hide shortcut normalizes supported modifiers and rejects system/reserved and typing chords', () => {
  assert.equal(parseHideShortcut('shift + control + h').accelerator, 'Ctrl+Shift+H');
  assert.deepEqual(parseHideShortcut('Alt+F24'), { accelerator: 'Alt+F24', virtualKey: 0x87, modifiers: 2 });
  assert.equal(parseHideShortcut('Ctrl+Space').virtualKey, 0x20);
  for (const key of ['', 'H', 'Shift+A', 'Alt+F4', 'Alt+Space', 'Ctrl+Shift+0', 'Win+L', 'Ctrl+Ctrl+H', 'Ctrl+Delete', 'Ctrl+F25']) assert.throws(() => parseHideShortcut(key));
});

test('a conflicting replacement keeps the previous live shortcut and persisted selection', async () => {
  const f = fixture();
  try {
    assert.equal((await f.controller.set('Ctrl+Alt+Q')).ok, true);
    f.globalShortcut.denied.add('Ctrl+Alt+W');
    const rejected = await f.controller.set('Ctrl+Alt+W');
    assert.equal(rejected.ok, false); assert.equal(rejected.accelerator, 'Ctrl+Alt+Q');
    assert.deepEqual([...f.globalShortcut.bindings.keys()], ['Ctrl+Alt+Q']);
    assert.equal(JSON.parse(readFileSync(path.join(f.userData, 'shortcuts.json'), 'utf8')).hideShortcut, 'Ctrl+Alt+Q');
    assert.equal((await f.controller.set('Ctrl+Alt+E')).ok, true);
    assert.deepEqual([...f.globalShortcut.bindings.keys()], ['Ctrl+Alt+E']);
  } finally { f.cleanup(); }
});

test('priority helper wins despite global registration conflict, routes only trigger messages and releases old helper', async () => {
  const children: Helper[] = []; let triggers = 0;
  const f = fixture({ platform: 'win32', onTrigger: () => triggers++, spawnHelper: () => { const child = new Helper(); children.push(child); queueMicrotask(() => child.stdout.write('READY\n')); return child; } });
  try {
    f.globalShortcut.denied.add('Ctrl+Alt+Q');
    const first = await f.controller.set('Ctrl+Alt+Q');
    assert.equal(first.mode, 'priority'); assert.equal(first.ok, true); assert.equal(f.globalShortcut.bindings.size, 0);
    children[0].stdout.write('TRIGGER\n'); assert.equal(triggers, 1);
    assert.equal((await f.controller.set('Ctrl+Alt+E')).mode, 'priority');
    assert.notEqual(children[0].exitCode, null); assert.equal(children[1].exitCode, null);
    children[0].stdout.write('TRIGGER\n'); assert.equal(triggers, 1);
    children[1].stdout.write('TRIGGER\n'); assert.equal(triggers, 2);
    f.controller.close(); assert.notEqual(children[1].exitCode, null);
    assert.equal(JSON.parse(readFileSync(path.join(f.userData, 'shortcuts.json'), 'utf8')).hideShortcut, 'Ctrl+Alt+E');
  } finally { f.cleanup(); }
});

test('helper failure uses a real fallback and an unexpected exit reports when fallback is also occupied', async () => {
  const children: Helper[] = [];
  const f = fixture({ platform: 'win32', spawnHelper: () => { const child = new Helper(); children.push(child); queueMicrotask(() => child.stdout.write(children.length === 1 ? 'ERROR Failed\n' : 'READY\n')); return child; } });
  try {
    const fallback = await f.controller.set('Ctrl+Alt+Q'); assert.equal(fallback.mode, 'global'); assert.equal(fallback.ok, true);
    assert.equal(f.globalShortcut.bindings.has('Ctrl+Alt+Q'), true);
    const priority = await f.controller.set('Ctrl+Alt+W'); assert.equal(priority.mode, 'priority');
    assert.equal(f.globalShortcut.bindings.size, 0);
    f.globalShortcut.denied.add('Ctrl+Alt+W'); children[1].kill();
    assert.equal(f.controller.snapshot().mode, 'unavailable'); assert.equal(f.controller.snapshot().ok, false);
  } finally { f.cleanup(); }
});

test('an old helper crashing during replacement cannot leave its recovered global chord registered', async () => {
  const children: Helper[] = [];
  const f = fixture({ platform: 'win32', spawnHelper: () => {
    const child = new Helper(); children.push(child);
    queueMicrotask(() => { if (children.length === 2) children[0].kill(); child.stdout.write('READY\n'); });
    return child;
  } });
  try {
    assert.equal((await f.controller.set('Ctrl+Alt+Q')).mode, 'priority');
    assert.equal((await f.controller.set('Ctrl+Alt+W')).mode, 'priority');
    assert.equal(f.globalShortcut.bindings.size, 0);
    assert.equal(f.controller.snapshot().accelerator, 'Ctrl+Alt+W');
  } finally { f.cleanup(); }
});

test('a persistence failure rolls back the new helper and keeps the old hook active', async () => {
  const children: Helper[] = [];
  const f = fixture({ platform: 'win32', spawnHelper: () => {
    const child = new Helper(); children.push(child); queueMicrotask(() => child.stdout.write('READY\n')); return child;
  } });
  try {
    await f.controller.set('Ctrl+Alt+Q');
    f.controller.file = path.join(f.userData, 'missing-folder', 'shortcuts.json');
    const failed = await f.controller.set('Ctrl+Alt+W');
    assert.equal(failed.ok, false); assert.equal(failed.accelerator, 'Ctrl+Alt+Q');
    assert.equal(children[0].exitCode, null); assert.notEqual(children[1].exitCode, null);
    assert.equal(f.controller.child, children[0]);
    assert.equal(JSON.parse(readFileSync(path.join(f.userData, 'shortcuts.json'), 'utf8')).hideShortcut, 'Ctrl+Alt+Q');
  } finally { f.cleanup(); }
});

test('saved shortcut survives a restart and malformed configuration falls back without throwing', async () => {
  const f = fixture();
  try {
    await f.controller.set('Ctrl+Alt+F9'); f.controller.close();
    const restarted = new HideShortcutController({ userData: f.userData, globalShortcut: f.globalShortcut, helperPath: '', platform: 'linux', onTrigger() {} });
    assert.equal((await restarted.start()).accelerator, 'Ctrl+Alt+F9'); restarted.close();
    writeFileSync(path.join(f.userData, 'shortcuts.json'), '{broken');
    const recovered = new HideShortcutController({ userData: f.userData, globalShortcut: f.globalShortcut, helperPath: '', platform: 'linux', onTrigger() {} });
    assert.equal((await recovered.start()).accelerator, 'Ctrl+Shift+H'); recovered.close();
  } finally { f.cleanup(); }
});

test('Windows helper self-test covers exact modifiers, auto-repeat and released-modifier key-up without emitting input', { skip: process.platform !== 'win32' || !existsSync('build/hotkey-helper.exe') }, () => {
  assert.match(execFileSync(path.resolve('build/hotkey-helper.exe'), ['--self-test'], { encoding: 'utf8', windowsHide: true }), /SELFTEST OK/);
});

test('Windows priority hook starts and exits cleanly without sending a keyboard event', { skip: process.platform !== 'win32' || !existsSync('build/hotkey-helper.exe') }, async () => {
  const f = fixture({ platform: 'win32', helperPath: path.resolve('build/hotkey-helper.exe') });
  try {
    // This uncommon chord is only installed briefly. The test never presses it.
    f.globalShortcut.denied.add('Ctrl+Alt+Shift+F24');
    const result = await f.controller.set('Ctrl+Alt+Shift+F24');
    assert.equal(result.mode, 'priority'); assert.equal(result.ok, true);
    const child = f.controller.child; const exited = once(child, 'exit'); f.controller.close();
    await exited; assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally { f.cleanup(); }
});
