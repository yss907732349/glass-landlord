const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const DEFAULT_HIDE_SHORTCUT = 'Ctrl+Shift+H';
function parseHideShortcut(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('请设置 Ctrl、Alt 或 Shift 加字母、数字、F键或空格。');
  const parts = value.split('+').map(part => part.trim());
  if (parts.length < 2 || parts.some(part => !part)) throw new Error('快捷键至少包含一个修饰键和一个普通键。');
  const aliases = { control: 'Ctrl', ctrl: 'Ctrl', commandorcontrol: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  const modifiers = new Set();
  for (const part of parts.slice(0, -1)) {
    const modifier = aliases[part.toLowerCase()];
    if (!modifier || modifiers.has(modifier)) throw new Error('仅支持 Ctrl、Alt、Shift 组合，且不能重复。');
    modifiers.add(modifier);
  }
  let key = parts.at(-1).toUpperCase(), virtualKey;
  if (/^[A-Z0-9]$/.test(key)) virtualKey = key.charCodeAt(0);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) virtualKey = 0x70 + Number(key.slice(1)) - 1;
  else if (key === 'SPACE' || key === 'SPACEBAR') { key = 'Space'; virtualKey = 0x20; }
  else throw new Error('普通键支持字母、数字、F1～F24或空格。');
  const ordered = ['Ctrl', 'Alt', 'Shift'].filter(modifier => modifiers.has(modifier));
  const accelerator = [...ordered, key].join('+');
  if (accelerator === 'Alt+F4' || accelerator === 'Alt+Space' || accelerator === 'Ctrl+Shift+0') throw new Error('此组合由系统或恢复布局功能保留，请换一组。');
  if (ordered.length === 1 && ordered[0] === 'Shift' && /^[A-Z0-9]$/.test(key)) throw new Error('请加上 Ctrl 或 Alt，避免影响正常打字。');
  return { accelerator, virtualKey, modifiers: (modifiers.has('Ctrl') ? 1 : 0) | (modifiers.has('Alt') ? 2 : 0) | (modifiers.has('Shift') ? 4 : 0) };
}

class HideShortcutController {
  constructor({ globalShortcut, userData, helperPath, sourcePath, packaged = false, platform = process.platform, onTrigger, onChange = () => {}, spawnHelper = spawn, compile = execFileSync }) {
    Object.assign(this, { globalShortcut, userData, helperPath, sourcePath, packaged, platform, onTrigger, onChange, spawnHelper, compile });
    this.file = path.join(userData, 'shortcuts.json');
    this.current = null; this.child = null; this.closed = false; this.busy = false;
    this.state = { accelerator: DEFAULT_HIDE_SHORTCUT, mode: 'unavailable', ok: false, message: '隐藏快捷键尚未启用。' };
  }
  snapshot() { return { ...this.state }; }
  publish(state) { this.state = { ...state }; this.onChange(this.snapshot()); return this.snapshot(); }
  async start() {
    let value = DEFAULT_HIDE_SHORTCUT;
    try { value = parseHideShortcut(JSON.parse(fs.readFileSync(this.file, 'utf8')).hideShortcut).accelerator; } catch {}
    const result = await this.set(value, false);
    return result.ok ? result : this.publish(result);
  }
  ensureHelper() {
    if (fs.existsSync(this.helperPath)) return;
    if (this.packaged) throw new Error('Priority shortcut helper is missing');
    const compiler = ['Framework64', 'Framework'].map(folder => path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', folder, 'v4.0.30319/csc.exe')).find(fs.existsSync);
    if (!compiler) throw new Error('Compiler unavailable');
    fs.mkdirSync(path.dirname(this.helperPath), { recursive: true });
    this.compile(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${this.helperPath}`, this.sourcePath], { windowsHide: true, stdio: 'pipe' });
  }
  async priority(chord) {
    this.ensureHelper();
    const child = this.spawnHelper(this.helperPath, [String(chord.virtualKey), String(chord.modifiers)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {}); // A helper that exits early may close its pipe first.
    await new Promise((resolve, reject) => {
      let buffer = '', settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('Shortcut helper timed out')), 5000);
      child.once('error', error => finish(error));
      child.once('exit', () => { finish(new Error('Shortcut helper stopped')); if (this.child === child && !this.closed) this.recover(chord); });
      child.stdout.on('data', data => {
        buffer += data.toString();
        if (buffer.length > 2048) return finish(new Error('Invalid helper response'));
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (line === 'READY') finish();
          else if (line === 'TRIGGER' && this.child === child && !this.closed) this.onTrigger();
          else if (line.startsWith('ERROR')) finish(new Error('Shortcut helper failed'));
        }
      });
    }).catch(error => { child.stdin?.end(); child.kill(); throw error; });
    if ((child.exitCode !== null && child.exitCode !== undefined) || (child.signalCode !== null && child.signalCode !== undefined)) throw new Error('Shortcut helper stopped');
    return child;
  }
  recover(chord) {
    this.child = null;
    let ok = false;
    try { ok = this.globalShortcut.register(chord.accelerator, this.onTrigger); } catch {}
    this.current = ok ? chord.accelerator : null;
    this.publish({ accelerator: chord.accelerator, ok, mode: ok ? 'global' : 'unavailable', message: ok ? '优先模式意外退出，已切换普通全局快捷键；可重新保存恢复优先模式。' : '隐藏快捷键已失效，可能被其他程序占用。请在设置中重新保存或更换组合；仍可用托盘显示／隐藏。' });
  }
  async set(value, persist = true) {
    let chord;
    try { chord = parseHideShortcut(value); } catch (error) { return { ...this.snapshot(), ok: false, message: error.message }; }
    if (this.closed || this.busy) return { ...this.snapshot(), ok: false, message: '快捷键正在切换，请稍后重试。' };
    if (chord.accelerator === this.state.accelerator && this.state.mode === 'priority' && this.child) return this.snapshot();
    this.busy = true;
    let candidate, mode = 'global';
    const previousChild = this.child, previousGlobal = this.current;
    try {
      if (this.platform === 'win32') { try { candidate = await this.priority(chord); mode = 'priority'; } catch {} }
      if (this.closed) { candidate?.stdin?.end(); candidate?.kill(); return { ...this.snapshot(), ok: false, message: '程序正在退出。' }; }
      if (!candidate) {
        let ok = previousGlobal === chord.accelerator;
        if (!ok) { try { ok = this.globalShortcut.register(chord.accelerator, this.onTrigger); } catch {} }
        if (!ok) return { ...this.snapshot(), ok: false, message: '该组合被其他程序占用，且优先模式未能启动。请换一组或重试；仍可用托盘显示／隐藏。' };
      }
      if (persist) {
        try { fs.mkdirSync(this.userData, { recursive: true }); fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ hideShortcut: chord.accelerator }, null, 2)); fs.renameSync(`${this.file}.tmp`, this.file); }
        catch {
          candidate?.stdin?.end(); candidate?.kill();
          if (!candidate && chord.accelerator !== previousGlobal) this.globalShortcut.unregister(chord.accelerator);
          return { ...this.snapshot(), ok: false, message: '无法保存快捷键设置，已保留原快捷键。' };
        }
      }
      // The old helper can crash while the replacement starts. Its recovery
      // may register a fallback after the transaction captured previousGlobal.
      const supersededGlobal = this.current;
      this.child = candidate || null; this.current = candidate ? null : chord.accelerator;
      if (supersededGlobal && supersededGlobal !== this.current) this.globalShortcut.unregister(supersededGlobal);
      previousChild?.stdin?.end(); previousChild?.kill();
      return this.publish({ accelerator: chord.accelerator, ok: true, mode, message: mode === 'priority' ? '已启用冲突优先：该组合由本程序先处理；系统保留键除外。' : '已启用普通全局快捷键；优先模式不可用，其他程序占用时无法强制接管。' });
    } finally { this.busy = false; }
  }
  close() {
    this.closed = true;
    if (this.current) this.globalShortcut.unregister(this.current);
    this.current = null;
    this.child?.stdin?.end(); this.child?.kill(); this.child = null;
  }
}

module.exports = { DEFAULT_HIDE_SHORTCUT, parseHideShortcut, HideShortcutController };
