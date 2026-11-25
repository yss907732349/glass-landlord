import { useEffect, useState } from 'react';

export type HideShortcutState = { accelerator: string; mode: string; message?: string; ok?: boolean };
const MODIFIERS = ['Ctrl+Shift', 'Ctrl+Alt', 'Alt+Shift', 'Ctrl+Alt+Shift', 'Ctrl', 'Alt'];
const KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), 'Space'];
function split(accelerator: string) {
  const parts = accelerator.replace(/CommandOrControl|Control/g, 'Ctrl').split('+');
  return { modifiers: parts.slice(0, -1).join('+'), key: parts.at(-1) || 'H' };
}

export function HideShortcutSettings() {
  const [current, setCurrent] = useState<HideShortcutState | null>(null);
  const [modifiers, setModifiers] = useState('Ctrl+Shift');
  const [key, setKey] = useState('H');
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const supported = !!window.desktop?.setHideShortcut;
  const proposed = `${modifiers}+${key}`;
  const apply = (value: HideShortcutState) => {
    setCurrent(value);
    const parsed = split(value.accelerator);
    setModifiers(parsed.modifiers); setKey(parsed.key);
  };
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void window.desktop!.info().then(info => {
      if (active && info.hideShortcut) apply(info.hideShortcut);
    }).catch(() => { if (active) setFeedback('暂时无法读取快捷键，请重新打开设置。'); });
    const changed = (event: Event) => {
      const value = (event as CustomEvent<HideShortcutState>).detail;
      if (value?.accelerator) { setCurrent(value); setFeedback(value.message || ''); }
    };
    addEventListener('glass-shortcut-state', changed);
    return () => { active = false; removeEventListener('glass-shortcut-state', changed); };
  }, [supported]);
  async function save(value: string) {
    if (!window.desktop?.setHideShortcut || pending) return;
    setPending(true); setFeedback('正在设置…');
    try {
      const result = await window.desktop.setHideShortcut(value);
      setFeedback(result.message || (result.ok ? '快捷键已保存。' : '快捷键未生效，请换一组重试。'));
      if (result.ok) apply(result);
      else setCurrent(result);
    } catch { setFeedback('保存失败，原快捷键仍保留，请重试。'); }
    finally { setPending(false); }
  }
  if (!supported) return <p className="shortcut-help">更新桌面版后，可在这里自定义显示／隐藏快捷键。</p>;
  return <fieldset className="shortcut-settings">
    <legend>显示／隐藏快捷键</legend>
    <div className="shortcut-inputs">
      <label>组合键<select aria-label="隐藏快捷键组合键" value={modifiers} disabled={pending} onChange={event => { setModifiers(event.target.value); setFeedback(''); }}>{MODIFIERS.map(value => <option value={value} key={value}>{value.replaceAll('+', ' + ')}</option>)}</select></label>
      <span aria-hidden="true">＋</span>
      <label>按键<select aria-label="隐藏快捷键按键" value={key} disabled={pending} onChange={event => { setKey(event.target.value); setFeedback(''); }}>{KEYS.map(value => <option value={value} key={value}>{value === 'Space' ? '空格' : value}</option>)}</select></label>
    </div>
    <div className="shortcut-actions"><button type="button" className="secondary-button" disabled={pending || (proposed === current?.accelerator && current.ok === true && current.mode === 'priority')} onClick={() => void save(proposed)}>{pending ? '设置中…' : '保存快捷键'}</button><button type="button" className="text-button" disabled={pending} onClick={() => void save('Ctrl+Shift+H')}>恢复默认</button></div>
    <p className="shortcut-help">普通软件冲突时优先响应本游戏；系统保留快捷键不能覆盖。</p>
    <p className="shortcut-status" role="status">{feedback || current?.message || '正在读取快捷键…'}</p>
  </fieldset>;
}
