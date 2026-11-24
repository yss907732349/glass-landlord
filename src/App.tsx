import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Card, GameView, PlayerView, SkillCard } from './shared/types.ts';
import { rankLabel, suitLabel } from './shared/cards.ts';
import { findHint, resolveWildPlays } from './shared/rules.ts';
import type { WildPlayOption } from './shared/rules.ts';
import { SKILLS } from './shared/skills.ts';
import { RoomConnection } from './network.ts';
import { DEFAULT_ROOM_SERVER } from './config.ts';
import { TableEffects } from './TableEffects.tsx';
import { QuickChat, ChatBubbles } from './QuickChat.tsx';

type ScreenRect = { x: number; y: number; width: number; height: number };
type DesktopLayout = { bounds: ScreenRect; primary: ScreenRect; displays: { id: number; bounds: ScreenRect; workArea: ScreenRect; scaleFactor: number }[]; reset?: boolean; previousBounds?: ScreenRect };
declare global { interface Window { desktop?: { pin: (value: boolean) => void; passthrough: (value: boolean) => void; hide: () => void; minimize: () => void; close: () => void; info: () => Promise<{ addresses: string[]; layout?: DesktopLayout; window?: { pinned: boolean } }>; isDesktop: boolean } } }
const skillInfo = (kind: string) => SKILLS.find(skill => skill.kind === kind)!;
const UI_WIDTH = 1080, UI_HEIGHT = 560;
const PHASE_NAMES: Record<string, string> = { lobby: '等待朋友入座', bidding: '叫地主', playing: '出牌', skill_discard: '弃掉多余技能', skill_use: '请更新客户端', finished: '本局结束' };
function Countdown({ deadline, paused }: { deadline: number; paused: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (paused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline, paused]);
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span className={`countdown ${remaining < 8 ? 'urgent' : ''}`}>{paused ? '已暂停' : `${remaining}s`}</span>;
}
function PlayingCard({ card, selected, onClick, small = false, disabled = false, dragManaged = false }: { card: Card; selected?: boolean; onClick?: () => void; small?: boolean; disabled?: boolean; dragManaged?: boolean }) {
  const red = card.suit === 'H' || card.suit === 'D';
  const rank = card.wild ? '赖' : card.rank === 16 ? '小' : card.rank === 17 ? '大' : rankLabel(card.rank);
  return <button type="button" className={`playing-card ${red ? 'red' : ''} ${card.wild ? 'wild' : ''} ${selected ? 'selected' : ''} ${small ? 'small' : ''}`} data-card-id={card.id} onClick={event => { if (!dragManaged || event.detail === 0) onClick?.(); }} disabled={disabled} aria-label={`${card.wild ? '赖子' : `${suitLabel(card.suit)}${rank}`}${selected ? '，已选择' : ''}`} aria-pressed={onClick ? !!selected : undefined}>
    <span className="card-corner"><b>{rank}</b><i>{card.wild ? '✧' : suitLabel(card.suit)}</i></span>
    {card.generated && <span className="generated-mark" title="技能生成">·</span>}
  </button>;
}
function Opponent({ player, active, side, passed, canTarget, targetSelected, onTarget, onUse, canUse }: { player?: PlayerView; active: boolean; side: string; passed: boolean; canTarget: boolean; targetSelected: boolean; onTarget: () => void; onUse: () => void; canUse: boolean }) {
  return <section className={`opponent ${side} ${active ? 'active-player' : ''} ${canTarget ? 'targetable' : ''} ${targetSelected ? 'target-selected' : ''}`} aria-label={player?.name || '空座位'}>
    <div className="player-heading"><button type="button" className={`avatar avatar-button ${player?.role === 'landlord' ? 'landlord-avatar' : ''}`} data-player-id={player?.id} aria-label={`选择${player?.name || '空座位'}作为技能目标`} aria-pressed={targetSelected} disabled={!player || !canTarget} onClick={onTarget}>{player?.name.slice(0, 1) || '＋'}</button><div><strong>{player?.name || '空座'}</strong><span>{player ? `${player.role === 'landlord' ? '地主' : player.role === 'farmer' ? '农民' : player.ready ? '已准备' : '未准备'}${player.role ? ` · 技能 ${player.skillCount}` : ''}${!player.connected ? ' · 掉线' : ''}` : '等朋友加入'}</span></div>{player && <b className="remaining">{player.cardCount}<small>张</small></b>}{targetSelected && <button className="target-use primary-button" aria-label={`对${player?.name}使用技能`} disabled={!canUse} onClick={onUse}>使用</button>}</div>
    {player && (passed || (player.bid !== null && !player.role)) && <div className="opponent-detail">{passed ? '不出' : player.bid ? `${player.bid}分` : '不叫'}</div>}
  </section>;
}

export default function App() {
  const [view, setView] = useState<GameView | null>(null);
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(() => localStorage.getItem('glass-name') || '桌边玩家');
  const [password, setPassword] = useState(''); const [roomCode, setRoomCode] = useState('');
  const [address, setAddress] = useState(() => localStorage.getItem('glass-server') || DEFAULT_ROOM_SERVER);
  const [settings, setSettings] = useState(false); const [help, setHelp] = useState(false); const [history, setHistory] = useState(false);
  const [windowMenu, setWindowMenu] = useState(false);
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('glass-zoom')) || 1);
  const [opacity, setOpacity] = useState(() => Math.max(15, Math.min(100, Number(localStorage.getItem('glass-ui-opacity')) || 88)));
  const [pinned, setPinned] = useState(true); const [locked, setLocked] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 }); const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  const [desktopLayout, setDesktopLayout] = useState<DesktopLayout | null>(null);
  const layoutRef = useRef<DesktopLayout | null>(null);
  const [selected, setSelected] = useState<string[]>([]); const [discardIds, setDiscardIds] = useState<string[]>([]);
  const [chosenSkill, setChosenSkill] = useState<SkillCard | null>(null); const [target, setTarget] = useState(''); const [skillPending, setSkillPending] = useState(false);
  const [wildChoices, setWildChoices] = useState<WildPlayOption[] | null>(null);
  const [peekOpen, setPeekOpen] = useState(false); const lastPeek = useRef('');
  const [localAddresses, setLocalAddresses] = useState<string[]>([]);
  const network = useRef<RoomConnection | null>(null);
  if (!network.current) network.current = new RoomConnection({
    state: setView, status: (text, waiting) => { setStatus(text); setBusy(waiting); if (!waiting) setSkillPending(false); },
    joined: () => { setPassword(''); }, left: () => { setView(null); setSelected([]); setChosenSkill(null); }
  });
  function applyDesktopLayout(next: DesktopLayout, initial = false) {
    const previous = next.previousBounds || layoutRef.current?.bounds;
    layoutRef.current = next; setDesktopLayout(next);
    setSize({ w: next.bounds.width, h: next.bounds.height });
    setPosition(current => {
      let x = initial || next.reset || !previous ? next.primary.x + next.primary.width / 2 : previous.x + previous.width / 2 + current.x - next.bounds.x;
      let y = initial || next.reset || !previous ? next.primary.y + next.primary.height / 2 : previous.y + previous.height / 2 + current.y - next.bounds.y;
      if (!next.displays.some(display => x >= display.workArea.x && x <= display.workArea.x + display.workArea.width && y >= display.workArea.y && y <= display.workArea.y + display.workArea.height)) {
        x = next.primary.x + next.primary.width / 2; y = next.primary.y + next.primary.height / 2;
      }
      return { x: x - next.bounds.width / 2, y: y - next.bounds.height / 2 };
    });
  }
  function resetPosition() {
    const layout = layoutRef.current;
    setPosition(layout ? { x: layout.primary.x + layout.primary.width / 2 - layout.bounds.width / 2, y: layout.primary.y + layout.primary.height / 2 - layout.bounds.height / 2 } : { x: 0, y: 0 });
    setZoom(1);
  }
  useEffect(() => { network.current!.restore(); window.desktop?.info().then(info => { setLocalAddresses(info.addresses); if (info.window) setPinned(info.window.pinned); if (info.layout) applyDesktopLayout(info.layout, true); }); return () => network.current!.dispose(); }, []);
  useEffect(() => { const update = () => setSize({ w: innerWidth, h: innerHeight }); addEventListener('resize', update); return () => removeEventListener('resize', update); }, []);
  useEffect(() => {
    const reset = () => { resetPosition(); setOpacity(88); };
    const displays = (event: Event) => applyDesktopLayout((event as CustomEvent<DesktopLayout>).detail);
    const windowState = (event: Event) => { const pinned = (event as CustomEvent<{ pinned: boolean }>).detail?.pinned; if (typeof pinned === 'boolean') setPinned(pinned); };
    addEventListener('glass-reset-layout', reset); addEventListener('glass-display-layout', displays);
    addEventListener('glass-window-state', windowState);
    return () => { removeEventListener('glass-reset-layout', reset); removeEventListener('glass-display-layout', displays); removeEventListener('glass-window-state', windowState); };
  }, []);
  useEffect(() => { localStorage.setItem('glass-zoom', String(zoom)); }, [zoom]);
  useEffect(() => { localStorage.setItem('glass-ui-opacity', String(opacity)); }, [opacity]);
  const playContext = JSON.stringify([view?.phase, view?.turnId, view?.paused, view?.currentPlay?.combination, view?.hand.map(card => card.id)]);
  useEffect(() => { setWildChoices(null); }, [selected, playContext, chosenSkill]);
  useEffect(() => {
    if (!view) return;
    setSelected(ids => { const next = ids.filter(id => view.hand.some(card => card.id === id)); return next.length === ids.length ? ids : next; });
    setDiscardIds(ids => { const next = ids.filter(id => view.skills.some(skill => skill.id === id)); return next.length === ids.length ? ids : next; });
    setSkillPending(false);
    if (chosenSkill && (!view.skills.some(skill => skill.id === chosenSkill.id) || view.phase !== 'playing' || view.turnId !== view.selfId)) { setChosenSkill(null); setTarget(''); }
    const key = view.privatePeek.map(card => card.id).join(',');
    if (key && key !== lastPeek.current) setPeekOpen(true); lastPeek.current = key;
  }, [view]);
  const self = view?.players.find(player => player.id === view.selfId);
  const selfIndex = view?.players.findIndex(player => player.id === view.selfId) ?? 0;
  const right = view?.players[(selfIndex + 1) % 3], left = view?.players[(selfIndex + 2) % 3];
  const myTurn = view?.turnId === view?.selfId;
  const skillTurn = !!view && view.phase === 'playing' && view.turnId === view.selfId && !view.paused;
  const fit = Math.min((desktopLayout?.primary.width || size.w) / (UI_WIDTH + 40), (desktopLayout?.primary.height || size.h) / (UI_HEIGHT + 40), 1.25); const scale = fit * zoom;
  const action = (value: Parameters<RoomConnection['action']>[0]) => { setStatus(''); if (!network.current!.action(value)) setStatus('尚未连接，请等待恢复或重新进入房间。'); };
  const toggleCard = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  const toggleDiscard = (id: string) => setDiscardIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (locked || event.button !== 0 || !event.isPrimary || drag.current || sizing.current || sweep.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, startX: position.x, startY: position.y };
  }
  function moveDrag(event: Pick<PointerEvent, 'pointerId' | 'screenX' | 'screenY'>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    setPosition({ x: drag.current.startX + event.screenX - drag.current.x, y: drag.current.startY + event.screenY - drag.current.y });
  }
  function enter(event: React.FormEvent) {
    event.preventDefault(); localStorage.setItem('glass-name', name.trim()); localStorage.setItem('glass-server', address.trim());
    try { network.current!.enter(mode, { name: name.trim(), password, code: roomCode }, address.trim()); } catch (error) { setStatus((error as Error).message); }
  }
  function hint() {
    if (!view) return;
    const found = findHint(view.hand, view.currentPlay?.combination || null);
    if (!found) { setSelected([]); setStatus('没有能压过的牌，可以选择不出。'); return; }
    setSelected(found.cardIds);
  }
  function play(choice?: WildPlayOption) {
    if (!view || view.phase !== 'playing' || view.turnId !== view.selfId || view.paused || chosenSkill || !selected.length) return;
    const cards = view.hand.filter(card => selected.includes(card.id));
    if (!cards.some(card => card.wild)) { action({ type: 'play', cardIds: selected }); return; }
    const options = resolveWildPlays(cards, view.currentPlay?.combination || null);
    if (!options.length) { setWildChoices(null); setStatus('这些牌无法组成能出的牌型，请重新选牌。'); return; }
    if (!choice && options.length > 1) { setWildChoices(options); setStatus(''); return; }
    const chosen = choice ? options.find(option => Object.entries(option.wildAs).every(([id, rank]) => choice.wildAs[id] === rank)) : options[0];
    if (!chosen) { setWildChoices(null); setStatus('牌局已变化，请重新选择打法。'); return; }
    action({ type: 'play', cardIds: selected, wildAs: chosen.wildAs }); setWildChoices(null);
  }
  const skillDef = chosenSkill ? skillInfo(chosenSkill.kind) : null;
  const canUseSkill = !!chosenSkill && !!skillDef && skillTurn && !skillPending && (!skillDef.target || !!target) && (skillDef.select === 0 || selected.length === skillDef.select);
  function useChosenSkill() {
    if (!canUseSkill || !chosenSkill || !skillDef) return;
    setSkillPending(true); setStatus('');
    if (!network.current!.action({ type: 'skill', skillId: chosenSkill.id, targetId: skillDef.target ? target : undefined, cardIds: skillDef.select ? selected : undefined })) { setSkillPending(false); setStatus('连接已中断，正在恢复。'); }
  }
  function chooseSkill(skill: SkillCard) {
    if (view?.mustDiscard) { toggleDiscard(skill.id); return; }
    if (!skillTurn) { setStatus('轮到你出牌时，就可以使用技能。'); return; }
    setChosenSkill(chosenSkill?.id === skill.id ? null : skill); setTarget(''); setSelected([]);
  }
  const sweep = useRef<{ pointerId: number; start: number; selecting: boolean; initial: string[] } | null>(null);
  function sweepDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !view || drag.current || sizing.current || sweep.current) return;
    const card = (event.target as Element).closest<HTMLElement>('[data-card-id]');
    const index = view.hand.findIndex(item => item.id === card?.dataset.cardId); if (index < 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    sweep.current = { pointerId: event.pointerId, start: index, selecting: !selected.includes(view.hand[index].id), initial: [...selected] };
    toggleCard(view.hand[index].id);
  }
  function sweepMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sweep.current || sweep.current.pointerId !== event.pointerId || !event.isPrimary || !(event.buttons & 1) || !view) return;
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')];
    let end = 0; cards.forEach((card, index) => { if (event.clientX >= card.getBoundingClientRect().left) end = index; });
    const { start, selecting, initial } = sweep.current; const next = new Set(initial);
    for (let index = Math.min(start, end); index <= Math.max(start, end); index++) { const id = view.hand[index]?.id; if (id) { if (selecting) next.add(id); else next.delete(id); } }
    setSelected([...next]);
  }
  function quickPlay(event: React.MouseEvent) {
    event.preventDefault(); if (view?.phase === 'playing' && myTurn && !view.paused && selected.length && !chosenSkill) play();
  }
  const sizing = useRef<{ pointerId: number; x: number; y: number; zoom: number; px: number; py: number; sign: number; fit: number } | null>(null);
  function resizeDown(event: ReactPointerEvent<HTMLButtonElement>, sign: number) {
    if (locked || event.button !== 0 || !event.isPrimary || drag.current || sizing.current || sweep.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    sizing.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, zoom, px: position.x, py: position.y, sign, fit };
  }
  function resizeMove(event: Pick<PointerEvent, 'pointerId' | 'screenX' | 'screenY'>) {
    if (!sizing.current || sizing.current.pointerId !== event.pointerId) return; const start = sizing.current;
    const delta = ((event.screenX - start.x) * UI_WIDTH + (event.screenY - start.y) * UI_HEIGHT) / (UI_WIDTH * UI_WIDTH + UI_HEIGHT * UI_HEIGHT);
    const nextZoom = Math.max(.35, Math.min(2, start.zoom + start.sign * delta / start.fit));
    const scaleDelta = (nextZoom - start.zoom) * start.fit;
    setZoom(nextZoom); setPosition({ x: start.px + start.sign * scaleDelta * UI_WIDTH / 2, y: start.py + start.sign * scaleDelta * UI_HEIGHT / 2 });
  }
  useEffect(() => {
    // Resizing the native viewport may release DOM pointer capture on Windows.
    // Keep layout gestures alive by tracking their screen coordinates on window.
    const move = (event: PointerEvent) => { if (event.isPrimary && (event.buttons & 1)) { moveDrag(event); resizeMove(event); } };
    const end = (event: PointerEvent) => {
      if (event.type === 'pointerup' && (event.buttons & 1)) return;
      if (drag.current?.pointerId === event.pointerId) drag.current = null;
      if (sizing.current?.pointerId === event.pointerId) sizing.current = null;
      if (sweep.current?.pointerId === event.pointerId) sweep.current = null;
    };
    const blur = () => { drag.current = null; sizing.current = null; sweep.current = null; setWindowMenu(false); };
    addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end); addEventListener('blur', blur);
    return () => { removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end); removeEventListener('blur', blur); };
  }, []);
  useEffect(() => {
    if (!windowMenu) return;
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.window-menu-wrap'))) setWindowMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setWindowMenu(false); document.querySelector<HTMLButtonElement>('.window-menu-trigger')?.focus(); } };
    addEventListener('pointerdown', outside); addEventListener('keydown', escape);
    return () => { removeEventListener('pointerdown', outside); removeEventListener('keydown', escape); };
  }, [windowMenu]);

  return <div className={`app-root ${window.desktop ? 'desktop-mode' : 'browser-mode'} ${view ? 'has-game' : 'in-lobby'}`} style={{ '--ui-opacity': opacity / 100 } as CSSProperties}>
    <main className="table-shell" style={{ transform: `translate(calc(-50% + ${position.x}px),calc(-50% + ${position.y}px)) scale(${scale})` }}>
      <header className="topbar"><div className="wordmark"><span className="brand-mark">♠</span><div><strong>玻璃斗地主</strong><span>朋友局，别客气。</span></div></div>
        <div className="window-tools"><button className="icon-button move-handle" disabled={locked} title="拖动整套界面" aria-label="拖动整套界面" onPointerDown={startDrag}>⠿</button><span className="toolbar-divider"/><button className="zoom-label" title="重置位置与缩放" onClick={resetPosition}>{Math.round(zoom * 100)}%</button><span className="toolbar-divider"/><button className={`icon-button ${pinned ? 'toggled' : ''}`} aria-label={pinned ? '取消置顶' : '置顶'} title={window.desktop ? '置顶' : '桌面版支持置顶'} onClick={() => { setPinned(!pinned); window.desktop?.pin(!pinned); }}>♧</button><button className="icon-button" aria-label="玩法说明" onClick={() => setHelp(true)}>?</button><button className={`icon-button ${settings ? 'toggled' : ''}`} aria-label="设置" onClick={() => setSettings(!settings)}>⚙</button>{window.desktop && <div className="window-menu-wrap">
          <button type="button" className="icon-button window-menu-trigger" aria-label="窗口菜单" title="窗口菜单" aria-haspopup="menu" aria-expanded={windowMenu} aria-controls="window-actions" onClick={() => setWindowMenu(value => !value)}>⋯</button>
          {windowMenu && <div id="window-actions" className="window-menu interactive" data-native-overlay role="menu" aria-label="窗口操作" style={{ '--window-menu-scale': Math.max(1, 1 / scale) } as CSSProperties} onKeyDown={event => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
          }}>
            <button type="button" role="menuitem" onClick={() => { setWindowMenu(false); window.desktop?.hide(); }}>隐藏牌局<small>Ctrl+Shift+H</small></button>
            <button type="button" role="menuitem" className="window-menu-exit" onClick={() => { setWindowMenu(false); window.desktop?.close(); }}>退出程序</button>
          </div>}
        </div>}</div>
      </header>
      {!view ? <section className="welcome-layout">
        <div className="welcome-art"><span className="welcome-caption">没有桌布，也能开一桌。</span><h1>好牌靠手气。<br/>翻盘靠捣乱。</h1><p>透明的牌，藏不住的坏心思。<br/>叫上两位朋友，把这局摆在桌面上。</p><div className="showcase-cards"><PlayingCard card={{ id: 'show1', rank: 14, suit: 'S' }} disabled/><PlayingCard card={{ id: 'show2', rank: 13, suit: 'H' }} disabled/><PlayingCard card={{ id: 'show3', rank: 3, suit: 'W', wild: true }} disabled/></div><div className="showcase-tag"><span>↶</span><div><strong>下一手，反着来。</strong><small>11 种技能，让朋友重新认识你。</small></div></div></div>
        <form className="room-panel glass-panel interactive" onSubmit={enter}><div className="panel-title"><span className="tiny-suits">♠ <i>♥</i> ♣ <i>♦</i></span><h2>朋友，入座。</h2><p>三人一桌，凭房间号和密码加入。</p></div><div className="segmented"><button type="button" className={mode === 'create' ? 'selected-tab' : ''} onClick={() => setMode('create')}>创建房间</button><button type="button" className={mode === 'join' ? 'selected-tab' : ''} onClick={() => setMode('join')}>加入房间</button></div><label>怎么称呼你<input name="nickname" value={name} onChange={event => setName(event.target.value)} maxLength={12} required placeholder="输入昵称" autoComplete="nickname"/></label>{mode === 'join' && <label>房间号<input name="room" value={roomCode} onChange={event => setRoomCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="[0-9]{6}" required placeholder="6 位房间号"/></label>}<label>房间密码<input name="password" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={4} maxLength={32} required placeholder="4～32 位，告诉你的朋友" autoComplete={mode === 'create' ? 'new-password' : 'current-password'}/></label><button className="primary-button enter-button" disabled={busy}>{busy ? '正在连接…' : mode === 'create' ? '开一桌' : '入座'}</button><button type="button" className="server-link" onClick={() => setSettings(true)}>连接地址 {address ? '· 已设置' : '· 当前服务'}</button><p className="quiet-note">也可以创建房间后，添加两位陪练先试一局。</p></form>
      </section> : <>
        <div className="room-strip interactive"><button className="room-code" title="复制房间号" onClick={() => navigator.clipboard.writeText(view.code).then(() => setStatus('房间号已复制，记得把密码也告诉朋友。')).catch(() => setStatus(`房间号：${view.code}`))}>房间 <b>{view.code}</b><span>⧉</span></button><span className="phase-label">{PHASE_NAMES[view.phase]}</span><span className="direction-label">{view.direction === 1 ? '↻' : '↺'}</span><button className="text-button" onClick={() => setHistory(true)}>牌局记录</button><QuickChat key={view.code} view={view} onSend={phraseId => action({ type: 'chat', phraseId })}/><button className="text-button" onClick={() => { if (view.phase === 'lobby' || view.phase === 'finished' || confirm('离开会中断本局，确定离开？')) network.current!.leave(); }}>离开</button></div>
        <Opponent player={left} active={view.turnId === left?.id} side="left-opponent" passed={view.lastActorId === left?.id && view.passCount > 0} canTarget={!!skillDef?.target && skillTurn} targetSelected={target === left?.id && !!chosenSkill} onTarget={() => setTarget(left?.id || '')} onUse={useChosenSkill} canUse={canUseSkill}/>
        <Opponent player={right} active={view.turnId === right?.id} side="right-opponent" passed={view.lastActorId === right?.id && view.passCount > 0} canTarget={!!skillDef?.target && skillTurn} targetSelected={target === right?.id && !!chosenSkill} onTarget={() => setTarget(right?.id || '')} onUse={useChosenSkill} canUse={canUseSkill}/>
        <section className="table-center"><div className="center-context"><span>第 {view.trick || 1} 轮</span><b>×{view.multiplier}</b>{view.deadline && <Countdown deadline={view.deadline} paused={view.paused}/>}</div>
          {view.phase === 'lobby' ? <div className="waiting-panel glass-panel interactive"><span className="waiting-symbol">♣</span><h2>{view.players.length < 3 ? '还差朋友，等你叫人。' : '人齐了，准备开局。'}</h2><p>地主抽两张、最多留三张；农民各抽一张、最多留两张。</p><div className="lobby-actions"><button className={self?.ready ? 'secondary-button' : 'primary-button'} onClick={() => action({ type: 'ready', ready: !self?.ready })}>{self?.ready ? '取消准备' : '我准备好了'}</button>{view.hostId === view.selfId && <button className="primary-button" disabled={view.players.length !== 3 || !view.players.every(p => p.ready)} onClick={() => action({ type: 'start' })}>开始这局</button>}</div>{view.hostId === view.selfId && view.players.length < 3 && <button className="text-button practice-button" onClick={() => action({ type: 'fillBots' })}>添加两位陪练，先玩一局</button>}</div> : view.phase === 'bidding' ? <div className="bidding-panel interactive"><div className="bottom-backs"><span className="card-back"/><span className="card-back"/><span className="card-back"/></div><h2>{myTurn ? '这把，你来当地主？' : `等${view.players.find(p => p.id === view.turnId)?.name || '朋友'}叫分`}</h2><p>当前最高 {view.bidMax} 分 · 三张底牌归地主</p>{myTurn && <div className="bid-actions"><button className="secondary-button" onClick={() => action({ type: 'bid', value: 0 })}>不叫</button>{[1, 2, 3].filter(value => value > view.bidMax).map(value => <button className="primary-button" key={value} onClick={() => action({ type: 'bid', value })}>{value} 分</button>)}</div>}</div> : <>
            {view.currentPlay ? <div className="played-group"><span className="played-by">{view.players.find(p => p.id === view.currentPlay?.playerId)?.name} · {view.currentPlay.combination.label}</span><div className="played-cards" style={{ "--played-step": `${Math.min(42, 550 / Math.max(1, view.currentPlay.cards.length))}px` } as CSSProperties}>{view.currentPlay.cards.map(card => <div key={card.id}><PlayingCard card={card} small disabled/>{card.wild && <span className="wild-declaration">当 {rankLabel(view.currentPlay?.wildAs?.[card.id] || 3)}</span>}</div>)}</div></div> : <div className="empty-center"><span>{view.phase.startsWith('skill') ? '✧' : '♠'}</span><h2>{view.phase === 'skill_discard' ? '好东西太多，先挑一挑。' : myTurn ? '这一轮，你先出。' : `等${view.players.find(p => p.id === view.turnId)?.name || '朋友'}领出`}</h2><p>{view.phase === 'skill_discard' ? '弃至上限后继续出牌。技能在自己的回合使用。' : '连续两家不出，清桌并抽取新技能。'}</p></div>}
          </>}
        </section>
        {view.bottom.length > 0 && <div className="bottom-cards"><span>底牌</span>{view.bottom.map(card => <span className={card.suit === 'H' || card.suit === 'D' ? 'red' : ''} key={card.id}>{rankLabel(card.rank)}{suitLabel(card.suit)}</span>)}</div>}
        <section className="own-area"><div className="own-heading"><span className={`self-role ${self?.role === 'landlord' ? 'landlord-role' : ''}`}>{self?.role === 'landlord' ? '地主' : self?.role === 'farmer' ? '农民' : '玩家'}</span><strong>{self?.name}</strong><span>剩余 <b>{view.hand.length}</b> 张</span>{view.paused && <span className="pause-label">朋友掉线中，牌局暂停</span>}</div>
          <div className="play-controls interactive">{view.phase === 'playing' && myTurn && <><button className="secondary-button" disabled={!view.currentPlay || view.paused} onClick={() => { action({ type: 'pass' }); setSelected([]); }}>不出</button><button className="secondary-button" disabled={view.paused} onClick={hint}>提示</button><button className="primary-button" disabled={!selected.length || view.paused || !!chosenSkill} onClick={() => play()}>出牌{selected.length > 0 ? ` · ${selected.length}` : ''}</button></>}{view.phase === 'playing' && !myTurn && <span className="turn-note">等{view.players.find(p => p.id === view.turnId)?.name}出牌</span>}{wildChoices && <aside className="wild-options interactive" aria-label="选择赖子打法"><div className="wild-options-heading"><span>有 {wildChoices.length} 种合法打法，选一种出牌</span><button type="button" className="text-button" aria-label="取消赖子选择" onClick={() => setWildChoices(null)}>×</button></div><div className="wild-options-list">{wildChoices.map(option => { const ranks = Object.values(option.wildAs).sort((a, b) => a - b).map(rankLabel).join('、'); const shape = option.combination; const range = shape.length > 1 ? `${rankLabel(shape.rank - shape.length + 1)}–${rankLabel(shape.rank)}` : rankLabel(shape.rank); return <button type="button" className="wild-option" data-wild-ranks={ranks} key={JSON.stringify(option.wildAs)} aria-label={`${shape.label} ${range}，赖子当${ranks}并出牌`} title={option.effectiveRanks.map(rankLabel).join(' ')} onClick={() => play(option)}><strong>{shape.label} {range}</strong><span>赖子当 {ranks}</span></button>; })}</div></aside>}</div>
          <div className="own-hand interactive" onPointerDown={sweepDown} onPointerMove={sweepMove} onLostPointerCapture={event => { if (sweep.current?.pointerId === event.pointerId) sweep.current = null; }} onContextMenu={quickPlay} style={{ '--hand-step': `${Math.min(58, 920 / Math.max(view.hand.length, 1))}px` } as CSSProperties}>{view.hand.map(card => <PlayingCard key={card.id} card={card} selected={selected.includes(card.id)} dragManaged onClick={() => toggleCard(card.id)}/>)}</div>
        </section>
        <section className="skill-zone interactive"><div className="skill-zone-heading"><strong>技能 <span>{view.skills.length}/{self?.role === 'landlord' ? 3 : 2}</span></strong><span>{view.mustDiscard ? `弃掉 ${view.mustDiscard} 张` : chosenSkill && skillDef ? `${skillDef.select ? `选 ${skillDef.select} 张手牌（已选 ${selected.length}） · ` : ''}${skillDef.target ? target ? `目标：${view.players.find(p => p.id === target)?.name}` : '点对手头像选择目标' : '无需选择目标'} · 使用后仍可出牌` : ''}</span></div>
          <div className="skill-row" style={{ "--skill-count": Math.max(1, view.skills.length) } as CSSProperties}>{view.skills.map(skill => { const def = skillInfo(skill.kind); return <button className={`skill-card ${def.tone} ${discardIds.includes(skill.id) ? 'discard-selected' : ''} ${chosenSkill?.id === skill.id ? 'skill-selected' : ''}`} data-skill-id={skill.id} data-kind={skill.kind} aria-pressed={chosenSkill?.id === skill.id || discardIds.includes(skill.id)} aria-label={def.name} key={skill.id} onClick={() => chooseSkill(skill)}><strong>{def.name}</strong><span className="skill-tooltip" role="tooltip">{def.description}</span>{discardIds.includes(skill.id) && <b className="discard-check">✓</b>}</button>; })}{!view.skills.length && <div className="empty-skills">暂无技能</div>}
            <div className="skill-phase-buttons">{view.mustDiscard > 0 ? <button className="primary-button" disabled={discardIds.length !== view.mustDiscard || view.paused} onClick={() => { action({ type: 'discard', skillIds: discardIds }); setDiscardIds([]); }}>弃掉选中技能</button> : chosenSkill ? <><button className="primary-button use-skill-button" aria-label="使用技能" disabled={!canUseSkill} onClick={useChosenSkill}>{skillPending ? '使用中…' : '使用'}</button><button className="text-button" aria-label="取消技能" onClick={() => { setChosenSkill(null); setTarget(''); setSelected([]); }}>取消</button></> : null}</div>
          </div>
        </section>

      </>}
      {status && status !== '已连接' && <div className={`status-toast interactive ${busy ? 'connecting' : ''}`} role="status"><span>{busy ? '◌' : '·'}</span>{status}<button aria-label="关闭提示" onClick={() => setStatus('')}>×</button></div>}
      <TableEffects view={view}/><ChatBubbles view={view}/>
      {[-1, 1].map(sign => <button key={sign} className={`resize-handle interactive ${sign < 0 ? 'top-left' : 'bottom-right'}`} disabled={locked} aria-label={sign < 0 ? '左上角拖动缩放' : '右下角拖动缩放'} title="按住拖动缩放，双击恢复" onPointerDown={event => resizeDown(event, sign)} onDoubleClick={resetPosition}><span aria-hidden="true"/></button>)}
      <footer className="table-footer"><span>透明桌面 · 三人技能局</span><span>{window.desktop ? '窗口外可操作桌面 · Ctrl+Shift+H 隐藏 / 显示' : '浏览器版可联机 · 透明置顶请打开桌面版'}</span></footer>
      {view?.phase === 'finished' && <div className="modal-backdrop interactive"><section className="modal glass-panel result-panel"><span className="result-suit">{(self?.role === 'landlord' && view.winner === 'landlord') || (self?.role === 'farmer' && view.winner === 'farmers') ? '♛' : '♠'}</span><h2>{view.winner === 'landlord' ? '地主拿下这局。' : '农民一起翻盘。'}</h2><p>{view.players.find(p => p.id === view.winnerId)?.name}率先出完手牌 · 最终倍率 ×{view.multiplier}</p><div className="result-players">{view.players.map(p => <span key={p.id}>{p.name}<b>{p.role === 'landlord' ? '地主' : '农民'}</b><small>剩 {p.cardCount} 张</small></span>)}</div>{view.hostId === view.selfId ? <button className="primary-button" onClick={() => action({ type: 'restart' })}>再来一局</button> : <p>等房主开启下一局</p>}<button className="text-button" onClick={() => network.current!.leave()}>回到入座页</button></section></div>}
      {peekOpen && !!view?.privatePeek.length && <aside className="peek-inline interactive"><div><span>偷看结果 · 仅你可见</span><button className="text-button" aria-label="收起偷看结果" onClick={() => setPeekOpen(false)}>×</button></div><div className="peek-cards">{view.privatePeek.map(card => <PlayingCard card={card} key={card.id} small disabled/>)}</div></aside>}
      {settings && <div className="modal-backdrop interactive"><section className="modal glass-panel settings-panel"><button className="modal-close" aria-label="关闭" onClick={() => setSettings(false)}>×</button><h2>界面设置</h2><label>整体透明度 <b>{100 - opacity}%</b><input aria-label="整体透明度" type="range" min="0" max="85" value={100 - opacity} onChange={e => setOpacity(100 - Number(e.target.value))}/></label><p>牌面、文字和按钮一起变淡。Ctrl+Shift+0 可恢复可见度和布局。</p><label>界面缩放 <b>{Math.round(zoom * 100)}%</b><input type="range" min="35" max="200" value={Math.round(zoom * 100)} onChange={e => setZoom(Number(e.target.value) / 100)}/></label><label className="checkbox-label"><input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)}/>锁定布局，避免误拖</label><label>房间服务地址<input value={address} onChange={e => { setAddress(e.target.value); localStorage.setItem('glass-server', e.target.value); }} placeholder="留空连接默认联机服务" disabled={!!view}/></label><p>默认已配置公网联机服务，朋友们打开新版即可在同一处建房和加入。离线陪练或局域网游玩可切换本机服务。</p>{!view && <div className="server-shortcuts"><button className="text-button" onClick={() => { setAddress(DEFAULT_ROOM_SERVER); localStorage.setItem("glass-server", DEFAULT_ROOM_SERVER); }}>使用默认联机服务</button>{window.desktop && <button className="text-button" onClick={() => { setAddress(location.origin); localStorage.setItem("glass-server", location.origin); }}>使用本机服务（离线 / 局域网）</button>}</div>}{localAddresses.length > 0 && <div className="local-addresses"><strong>本机房间地址 · 同一局域网可用</strong>{localAddresses.map(item => <button className="text-button" key={item} onClick={() => navigator.clipboard.writeText(item).then(() => setStatus("局域网地址已复制。"))}>{item} ⧉</button>)}</div>}<button className="secondary-button" onClick={resetPosition}>恢复位置与大小</button><button className="primary-button" onClick={() => setSettings(false)}>完成</button></section></div>}
      {help && <div className="modal-backdrop interactive"><section className="modal glass-panel help-panel"><button className="modal-close" aria-label="关闭" onClick={() => setHelp(false)}>×</button><h2>打牌认真，捣乱随意。</h2><p>标准三人斗地主：叫分最高者成为地主并获得底牌，地主先出。连续两家不出后清桌，原领出者开启下一轮。</p><div className="rule-facts"><span>地主<b>抽 2 · 留 3</b></span><span>每名农民<b>抽 1 · 留 2</b></span><span>使用时机<b>自己的出牌回合</b></span></div><p>每轮结束抽技能，超出上限先弃牌，然后继续出牌。技能可在自己的出牌回合连续使用，不占出牌机会。点技能、按需选手牌、点对手头像，再点使用。拖过手牌批量选择，右键快速出牌。角落拖动缩放。赖子自动计算，只有多种合法打法时需要选择。合法出完最后一手立即获胜。</p><div className="help-skill-list">{SKILLS.map(skill => <div key={skill.kind}><strong>{skill.name}<small>{skill.weight}%</small></strong><p>{skill.description}</p></div>)}</div><p>赖子只代替3～A，不参与炸弹。生成的普通牌允许重复点数，炸弹仍为四张同点数。身份互换每局一次、全桌洗手每局两次。</p><button className="primary-button" onClick={() => setHelp(false)}>懂了，开整</button></section></div>}
      {history && <div className="modal-backdrop interactive"><section className="modal glass-panel history-panel"><button className="modal-close" aria-label="关闭" onClick={() => setHistory(false)}>×</button><h2>刚才发生了什么</h2><ol className="history-list">{view?.logs.slice().reverse().map((log, i) => <li key={`${i}-${log}`}>{log}</li>)}</ol></section></div>}
    </main>
  </div>;
}
