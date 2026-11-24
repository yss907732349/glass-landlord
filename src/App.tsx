import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Card, GameView, PlayerView, SkillCard, SkillDefinition } from './shared/types.ts';
import { rankLabel, suitLabel } from './shared/cards.ts';
import { findHint } from './shared/rules.ts';
import { SKILLS } from './shared/skills.ts';
import { RoomConnection } from './network.ts';

declare global { interface Window { desktop?: { pin: (value: boolean) => void; passthrough: (value: boolean) => void; hide: () => void; minimize: () => void; close: () => void; info: () => Promise<{ addresses: string[] }>; isDesktop: boolean } } }
const skillInfo = (kind: string) => SKILLS.find(skill => skill.kind === kind)!;
const PHASE_NAMES: Record<string, string> = { lobby: '等待朋友入座', bidding: '叫地主', playing: '出牌阶段', skill_discard: '整理技能', skill_use: '捣乱时间', finished: '本局结束' };
function PlayingCard({ card, selected, onClick, small = false, disabled = false }: { card: Card; selected?: boolean; onClick?: () => void; small?: boolean; disabled?: boolean }) {
  const red = card.suit === 'H' || card.suit === 'D';
  const rank = card.wild ? '赖' : card.rank === 16 ? '小' : card.rank === 17 ? '大' : rankLabel(card.rank);
  return <button type="button" className={`playing-card ${red ? 'red' : ''} ${card.wild ? 'wild' : ''} ${selected ? 'selected' : ''} ${small ? 'small' : ''}`} onClick={onClick} disabled={disabled} aria-label={`${card.wild ? '赖子' : `${suitLabel(card.suit)}${rank}`}${selected ? '，已选择' : ''}`} aria-pressed={onClick ? !!selected : undefined}>
    <span className="card-corner"><b>{rank}</b><i>{card.wild ? '✧' : suitLabel(card.suit)}</i></span>
    <span className="card-suit" aria-hidden="true">{card.wild ? '✧' : card.rank >= 16 ? 'J' : suitLabel(card.suit)}</span>
    <span className="card-corner opposite" aria-hidden="true"><b>{rank}</b><i>{card.wild ? '✧' : suitLabel(card.suit)}</i></span>
    {card.generated && <span className="generated-mark" title="技能生成">·</span>}
  </button>;
}
function Opponent({ player, active, side, passed }: { player?: PlayerView; active: boolean; side: string; passed: boolean }) {
  return <section className={`opponent ${side} ${active ? 'active-player' : ''}`} aria-label={player?.name || '空座位'}>
    <div className="player-heading"><span className={`avatar ${player?.role === 'landlord' ? 'landlord-avatar' : ''}`}>{player?.name.slice(0, 1) || '＋'}</span><div><strong>{player?.name || '等一位朋友'}</strong><span>{player ? `${player.role === 'landlord' ? '地主' : player.role === 'farmer' ? '农民' : '已入座'}${!player.connected ? ' · 掉线重连中' : player.ready && !player.role ? ' · 已准备' : ''}` : '通过房间号加入'}</span></div>{player && <b className="remaining">{player.cardCount}<small>张</small></b>}</div>
    <div className="card-backs" aria-label={player ? `剩余${player.cardCount}张隐藏手牌` : '空座'}>{Array.from({ length: Math.min(player?.cardCount || 0, 7) }, (_, i) => <span key={i} className="card-back" style={{ '--i': i } as CSSProperties} />)}</div>
    {player && <div className="opponent-detail"><span>技能 {player.skillCount}/{player.role === 'landlord' ? 3 : 2}</span>{passed && <b>不出</b>}{player.bid !== null && !player.role && <b>{player.bid ? `叫 ${player.bid} 分` : '不叫'}</b>}</div>}
  </section>;
}

export default function App() {
  const [view, setView] = useState<GameView | null>(null);
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(() => localStorage.getItem('glass-name') || '桌边玩家');
  const [password, setPassword] = useState(''); const [roomCode, setRoomCode] = useState('');
  const [address, setAddress] = useState(() => localStorage.getItem('glass-server') || import.meta.env.VITE_ROOM_SERVER || '');
  const [settings, setSettings] = useState(false); const [help, setHelp] = useState(false); const [history, setHistory] = useState(false);
  const [zoom, setZoom] = useState(() => Number(localStorage.getItem('glass-zoom')) || 1);
  const [opacity, setOpacity] = useState(() => Number(localStorage.getItem('glass-opacity')) || 18);
  const [pinned, setPinned] = useState(true); const [locked, setLocked] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 }); const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  const [selected, setSelected] = useState<string[]>([]); const [discardIds, setDiscardIds] = useState<string[]>([]);
  const [chosenSkill, setChosenSkill] = useState<SkillCard | null>(null); const [target, setTarget] = useState('');
  const [wildRanks, setWildRanks] = useState<Record<string, number>>({}); const [peekOpen, setPeekOpen] = useState(false); const lastPeek = useRef('');
  const [now, setNow] = useState(Date.now());
  const [localAddresses, setLocalAddresses] = useState<string[]>([]);
  const network = useRef<RoomConnection | null>(null);
  if (!network.current) network.current = new RoomConnection({
    state: setView, status: (text, waiting) => { setStatus(text); setBusy(waiting); },
    joined: () => { setPassword(''); }, left: () => { setView(null); setSelected([]); setChosenSkill(null); }
  });
  useEffect(() => { network.current!.restore(); window.desktop?.info().then(info => setLocalAddresses(info.addresses)); return () => network.current!.dispose(); }, []);
  useEffect(() => { const update = () => setSize({ w: innerWidth, h: innerHeight }); addEventListener('resize', update); const timer = setInterval(() => setNow(Date.now()), 500); return () => { removeEventListener('resize', update); clearInterval(timer); }; }, []);
  useEffect(() => { const reset = () => { setPosition({ x: 0, y: 0 }); setZoom(1); }; addEventListener('glass-reset-layout', reset); return () => removeEventListener('glass-reset-layout', reset); }, []);
  useEffect(() => { localStorage.setItem('glass-zoom', String(zoom)); }, [zoom]);
  useEffect(() => { localStorage.setItem('glass-opacity', String(opacity)); }, [opacity]);
  useEffect(() => {
    if (!view) return;
    setSelected(ids => ids.filter(id => view.hand.some(card => card.id === id)));
    setDiscardIds(ids => ids.filter(id => view.skills.some(skill => skill.id === id)));
    if (chosenSkill && !view.skills.some(skill => skill.id === chosenSkill.id)) setChosenSkill(null);
    const key = view.privatePeek.map(card => card.id).join(',');
    if (key && key !== lastPeek.current) setPeekOpen(true); lastPeek.current = key;
  }, [view]);
  const self = view?.players.find(player => player.id === view.selfId);
  const selfIndex = view?.players.findIndex(player => player.id === view.selfId) ?? 0;
  const right = view?.players[(selfIndex + 1) % 3], left = view?.players[(selfIndex + 2) % 3];
  const myTurn = view?.turnId === view?.selfId;
  const skillTurn = view?.phase === 'skill_use' && view.skillActorId === view.selfId;
  const fit = Math.min(size.w / 1220, size.h / 820, 1.25); const scale = fit * zoom;
  const action = (value: Parameters<RoomConnection['action']>[0]) => { setStatus(''); if (!network.current!.action(value)) setStatus('尚未连接，请等待恢复或重新进入房间。'); };
  const toggleCard = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  const toggleDiscard = (id: string) => setDiscardIds(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  const remaining = view?.deadline ? Math.max(0, Math.ceil((view.deadline - now) / 1000)) : 0;
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  function startDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (locked) return; event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, startX: position.x, startY: position.y };
  }
  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!drag.current) return;
    setPosition({ x: Math.max(-size.w * .35, Math.min(size.w * .35, drag.current.startX + event.clientX - drag.current.x)), y: Math.max(-size.h * .35, Math.min(size.h * .35, drag.current.startY + event.clientY - drag.current.y)) });
  }
  function enter(event: React.FormEvent) {
    event.preventDefault(); localStorage.setItem('glass-name', name.trim()); localStorage.setItem('glass-server', address.trim());
    try { network.current!.enter(mode, { name: name.trim(), password, code: roomCode }, address.trim()); } catch (error) { setStatus((error as Error).message); }
  }
  function hint() {
    if (!view) return;
    const found = findHint(view.hand, view.currentPlay?.combination || null);
    if (!found) { setSelected([]); setStatus('没有能压过的牌，可以选择不出。'); return; }
    setSelected(found.cardIds); if (found.wildAs) setWildRanks(found.wildAs);
  }
  const hintWildAs = useRef<Record<string, number> | undefined>(undefined);
  function play() {
    if (!view) return;
    const wilds = view.hand.filter(card => selected.includes(card.id) && card.wild);
    const wildAs = wilds.length ? Object.fromEntries(wilds.map(card => [card.id, selected.length === 1 ? 3 : (wildRanks[card.id] || 14)])) : undefined;
    action({ type: 'play', cardIds: selected, wildAs: hintWildAs.current && selected.every(id => !view.hand.find(c => c.id === id)?.wild || hintWildAs.current?.[id]) ? hintWildAs.current : wildAs });
    hintWildAs.current = undefined;
  }
  function smartHint() {
    if (!view) return; const found = findHint(view.hand, view.currentPlay?.combination || null);
    hintWildAs.current = found?.wildAs; hint();
  }
  const skillDef = chosenSkill ? skillInfo(chosenSkill.kind) : null;
  const chosenCards = view?.hand.filter(card => selected.includes(card.id)) || [];
  return <div className={`app-root ${window.desktop ? 'desktop-mode' : 'browser-mode'}`} style={{ '--glass-opacity': opacity / 100 } as CSSProperties}>
    <main className="table-shell" style={{ transform: `translate(calc(-50% + ${position.x}px),calc(-50% + ${position.y}px)) scale(${scale})` }}>
      <header className="topbar interactive"><div className="wordmark"><span className="brand-mark">♠</span><div><strong>玻璃斗地主</strong><span>朋友局，别客气。</span></div></div>
        <div className="window-tools"><button className="icon-button move-handle" title="拖动整套界面" aria-label="拖动整套界面" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>⠿</button><span className="toolbar-divider"/><button className="icon-button" title="缩小" aria-label="缩小" onClick={() => setZoom(v => Math.max(.65, +(v - .05).toFixed(2)))}>−</button><button className="zoom-label" title="重置位置与缩放" onClick={() => { setZoom(1); setPosition({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button><button className="icon-button" title="放大" aria-label="放大" onClick={() => setZoom(v => Math.min(1.5, +(v + .05).toFixed(2)))}>＋</button><span className="toolbar-divider"/><button className={`icon-button ${pinned ? 'toggled' : ''}`} aria-label={pinned ? '取消置顶' : '置顶'} title={window.desktop ? '置顶' : '桌面版支持置顶'} onClick={() => { setPinned(!pinned); window.desktop?.pin(!pinned); }}>♧</button><button className="icon-button" aria-label="玩法说明" onClick={() => setHelp(true)}>?</button><button className={`icon-button ${settings ? 'toggled' : ''}`} aria-label="设置" onClick={() => setSettings(!settings)}>⚙</button>{window.desktop && <><button className="icon-button" aria-label="最小化" onClick={() => window.desktop?.minimize()}>_</button><button className="icon-button close-button" aria-label="关闭" onClick={() => window.desktop?.close()}>×</button></>}</div>
      </header>
      {!view ? <section className="welcome-layout">
        <div className="welcome-art"><span className="welcome-caption">没有桌布，也能开一桌。</span><h1>好牌靠手气。<br/>翻盘靠捣乱。</h1><p>透明的牌，藏不住的坏心思。<br/>叫上两位朋友，把这局摆在桌面上。</p><div className="showcase-cards"><PlayingCard card={{ id: 'show1', rank: 14, suit: 'S' }} disabled/><PlayingCard card={{ id: 'show2', rank: 13, suit: 'H' }} disabled/><PlayingCard card={{ id: 'show3', rank: 3, suit: 'W', wild: true }} disabled/></div><div className="showcase-tag"><span>↶</span><div><strong>下一手，反着来。</strong><small>11 种技能，让朋友重新认识你。</small></div></div></div>
        <form className="room-panel glass-panel interactive" onSubmit={enter}><div className="panel-title"><span className="tiny-suits">♠ <i>♥</i> ♣ <i>♦</i></span><h2>朋友，入座。</h2><p>三人一桌，凭房间号和密码加入。</p></div><div className="segmented"><button type="button" className={mode === 'create' ? 'selected-tab' : ''} onClick={() => setMode('create')}>创建房间</button><button type="button" className={mode === 'join' ? 'selected-tab' : ''} onClick={() => setMode('join')}>加入房间</button></div><label>怎么称呼你<input name="nickname" value={name} onChange={event => setName(event.target.value)} maxLength={12} required placeholder="输入昵称" autoComplete="nickname"/></label>{mode === 'join' && <label>房间号<input name="room" value={roomCode} onChange={event => setRoomCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="[0-9]{6}" required placeholder="6 位房间号"/></label>}<label>房间密码<input name="password" type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={4} maxLength={32} required placeholder="4～32 位，告诉你的朋友" autoComplete={mode === 'create' ? 'new-password' : 'current-password'}/></label><button className="primary-button enter-button" disabled={busy}>{busy ? '正在连接…' : mode === 'create' ? '开一桌' : '入座'}</button><button type="button" className="server-link" onClick={() => setSettings(true)}>连接地址 {address ? '· 已设置' : '· 当前服务'}</button><p className="quiet-note">也可以创建房间后，添加两位陪练先试一局。</p></form>
      </section> : <>
        <div className="room-strip interactive"><button className="room-code" title="复制房间号" onClick={() => navigator.clipboard.writeText(view.code).then(() => setStatus('房间号已复制，记得把密码也告诉朋友。')).catch(() => setStatus(`房间号：${view.code}`))}>房间 <b>{view.code}</b><span>⧉</span></button><span className="phase-label">{PHASE_NAMES[view.phase]}</span><span className="direction-label">{view.direction === 1 ? '↻ 顺时针' : '↺ 逆时针'}</span><button className="text-button" onClick={() => setHistory(true)}>牌局记录</button><button className="text-button" onClick={() => { if (view.phase === 'lobby' || view.phase === 'finished' || confirm('离开会中断本局，确定离开？')) network.current!.leave(); }}>离开</button></div>
        <Opponent player={left} active={view.turnId === left?.id || view.skillActorId === left?.id} side="left-opponent" passed={view.lastActorId === left?.id && view.passCount > 0}/>
        <Opponent player={right} active={view.turnId === right?.id || view.skillActorId === right?.id} side="right-opponent" passed={view.lastActorId === right?.id && view.passCount > 0}/>
        <section className="table-center"><div className="center-context"><span>第 {view.trick || 1} 轮</span><b>×{view.multiplier}</b>{view.deadline && <span className={`countdown ${remaining < 8 ? 'urgent' : ''}`}>{view.paused ? '已暂停' : `${remaining}s`}</span>}</div>
          {view.phase === 'lobby' ? <div className="waiting-panel glass-panel interactive"><span className="waiting-symbol">♣</span><h2>{view.players.length < 3 ? '还差朋友，等你叫人。' : '人齐了，准备开局。'}</h2><p>地主抽两张、最多留三张；农民各抽一张、最多留两张。</p><div className="lobby-actions"><button className={self?.ready ? 'secondary-button' : 'primary-button'} onClick={() => action({ type: 'ready', ready: !self?.ready })}>{self?.ready ? '取消准备' : '我准备好了'}</button>{view.hostId === view.selfId && <button className="primary-button" disabled={view.players.length !== 3 || !view.players.every(p => p.ready)} onClick={() => action({ type: 'start' })}>开始这局</button>}</div>{view.hostId === view.selfId && view.players.length < 3 && <button className="text-button practice-button" onClick={() => action({ type: 'fillBots' })}>添加两位陪练，先玩一局</button>}</div> : view.phase === 'bidding' ? <div className="bidding-panel interactive"><div className="bottom-backs"><span className="card-back"/><span className="card-back"/><span className="card-back"/></div><h2>{myTurn ? '这把，你来当地主？' : `等${view.players.find(p => p.id === view.turnId)?.name || '朋友'}叫分`}</h2><p>当前最高 {view.bidMax} 分 · 三张底牌归地主</p>{myTurn && <div className="bid-actions"><button className="secondary-button" onClick={() => action({ type: 'bid', value: 0 })}>不叫</button>{[1, 2, 3].filter(value => value > view.bidMax).map(value => <button className="primary-button" key={value} onClick={() => action({ type: 'bid', value })}>{value} 分</button>)}</div>}</div> : <>
            {view.currentPlay ? <div className="played-group"><span className="played-by">{view.players.find(p => p.id === view.currentPlay?.playerId)?.name} · {view.currentPlay.combination.label}</span><div className="played-cards" style={{ "--played-step": `${Math.min(42, 550 / Math.max(1, view.currentPlay.cards.length))}px` } as CSSProperties}>{view.currentPlay.cards.map(card => <div key={card.id}><PlayingCard card={card} small disabled/>{card.wild && <span className="wild-declaration">当 {rankLabel(view.currentPlay?.wildAs?.[card.id] || 3)}</span>}</div>)}</div></div> : <div className="empty-center"><span>{view.phase.startsWith('skill') ? '✧' : '♠'}</span><h2>{view.phase === 'skill_discard' ? '好东西太多，先挑一挑。' : view.phase === 'skill_use' ? '轮到技能登场。' : myTurn ? '这一轮，你先出。' : `等${view.players.find(p => p.id === view.turnId)?.name || '朋友'}领出`}</h2><p>{view.phase === 'skill_discard' ? '所有人整理完技能后，开始使用。' : view.phase === 'skill_use' ? `${view.players.find(p => p.id === view.skillActorId)?.name || '朋友'}正在打坏主意` : '连续两家不出，清桌并抽取新技能。'}</p></div>}
          </>}
        </section>
        {view.bottom.length > 0 && <div className="bottom-cards"><span>底牌</span>{view.bottom.map(card => <span className={card.suit === 'H' || card.suit === 'D' ? 'red' : ''} key={card.id}>{rankLabel(card.rank)}{suitLabel(card.suit)}</span>)}</div>}
        <section className="own-area"><div className="own-heading"><span className={`self-role ${self?.role === 'landlord' ? 'landlord-role' : ''}`}>{self?.role === 'landlord' ? '地主' : self?.role === 'farmer' ? '农民' : '玩家'}</span><strong>{self?.name}</strong><span>剩余 <b>{view.hand.length}</b> 张</span>{view.paused && <span className="pause-label">朋友掉线中，牌局暂停</span>}</div>
          <div className="play-controls interactive">{view.phase === 'playing' && myTurn && <><button className="secondary-button" disabled={!view.currentPlay || view.paused} onClick={() => { action({ type: 'pass' }); setSelected([]); }}>不出</button><button className="secondary-button" disabled={view.paused} onClick={smartHint}>提示</button><button className="primary-button" disabled={!selected.length || view.paused} onClick={play}>出牌{selected.length > 0 ? ` · ${selected.length}` : ''}</button></>}{view.phase === 'playing' && !myTurn && <span className="turn-note">等{view.players.find(p => p.id === view.turnId)?.name}出牌</span>}{chosenCards.filter(card => card.wild).map((card, index) => <label className="wild-picker" key={card.id}>赖子{index + 1}当<select disabled={selected.length === 1} value={selected.length === 1 ? 3 : (wildRanks[card.id] || 14)} onChange={event => { setWildRanks(previous => ({ ...previous, [card.id]: Number(event.target.value) })); hintWildAs.current = undefined; }}>{Array.from({ length: 12 }, (_, i) => i + 3).map(rank => <option key={rank} value={rank}>{rankLabel(rank)}</option>)}</select></label>)}</div>
          <div className="own-hand interactive" style={{ '--hand-step': `${Math.min(58, 920 / Math.max(view.hand.length, 1))}px` } as CSSProperties}>{view.hand.map(card => <PlayingCard key={card.id} card={card} selected={selected.includes(card.id)} onClick={() => { hintWildAs.current = undefined; toggleCard(card.id); }}/>)}</div>
        </section>
        <section className="skill-zone interactive"><div className="skill-zone-heading"><strong>你的坏主意 <span>{view.skills.length}/{self?.role === 'landlord' ? 3 : 2}</span></strong><span>{view.mustDiscard ? `需要弃掉 ${view.mustDiscard} 张` : skillTurn ? `本阶段还可用 ${Math.max(0, view.skillBudget - view.skillUsed)} 张` : '技能可以留到下一轮'}</span></div><div className="skill-row" style={{ "--skill-count": Math.max(1, view.skills.length) } as CSSProperties}>{view.skills.map(skill => { const def = skillInfo(skill.kind); return <button className={`skill-card ${def.tone} ${discardIds.includes(skill.id) ? 'discard-selected' : ''}`} key={skill.id} onClick={() => { if (view.mustDiscard > 0) toggleDiscard(skill.id); else if (skillTurn) { setChosenSkill(skill); setTarget(view.players.find(p => p.id !== view.selfId)?.id || ''); } else setStatus(`${def.name}：${def.description}`); }}><span className="skill-symbol">{def.kind === 'reverse' ? '↶' : def.kind === 'identity' ? '♛' : def.kind === 'shuffle' ? '⤨' : '✧'}</span><div><strong>{def.name}</strong><small>{def.description}</small></div>{discardIds.includes(skill.id) && <b className="discard-check">✓</b>}</button>; })}{!view.skills.length && <div className="empty-skills">每轮结束抽取技能。好戏在后面。</div>}<div className="skill-phase-buttons">{view.mustDiscard > 0 ? <button className="primary-button" disabled={discardIds.length !== view.mustDiscard || view.paused} onClick={() => { action({ type: 'discard', skillIds: discardIds }); setDiscardIds([]); }}>弃掉选中技能</button> : skillTurn ? <button className="secondary-button" disabled={view.paused} onClick={() => action({ type: 'skillEnd' })}>留着，下次再用</button> : null}</div></div></section>
      </>}
      {status && status !== '已连接' && <div className={`status-toast interactive ${busy ? 'connecting' : ''}`} role="status"><span>{busy ? '◌' : '·'}</span>{status}<button aria-label="关闭提示" onClick={() => setStatus('')}>×</button></div>}
      <footer className="table-footer"><span>透明桌面 · 三人技能局</span><span>{window.desktop ? '空白处可点击桌面 · Ctrl+Shift+H 隐藏 / 显示' : '浏览器版可联机 · 透明置顶请打开桌面版'}</span></footer>
      {view?.phase === 'finished' && <div className="modal-backdrop interactive"><section className="modal glass-panel result-panel"><span className="result-suit">{(self?.role === 'landlord' && view.winner === 'landlord') || (self?.role === 'farmer' && view.winner === 'farmers') ? '♛' : '♠'}</span><h2>{view.winner === 'landlord' ? '地主拿下这局。' : '农民一起翻盘。'}</h2><p>{view.players.find(p => p.id === view.winnerId)?.name}率先出完手牌 · 最终倍率 ×{view.multiplier}</p><div className="result-players">{view.players.map(p => <span key={p.id}>{p.name}<b>{p.role === 'landlord' ? '地主' : '农民'}</b><small>剩 {p.cardCount} 张</small></span>)}</div>{view.hostId === view.selfId ? <button className="primary-button" onClick={() => action({ type: 'restart' })}>再来一局</button> : <p>等房主开启下一局</p>}<button className="text-button" onClick={() => network.current!.leave()}>回到入座页</button></section></div>}
      {chosenSkill && skillDef && <div className="modal-backdrop interactive"><section className="modal glass-panel"><button className="modal-close" aria-label="关闭" onClick={() => setChosenSkill(null)}>×</button><span className="modal-symbol">✧</span><h2>{skillDef.name}</h2><p>{skillDef.description}</p>{skillDef.target && <fieldset className="target-options"><legend>这次，找谁？</legend>{view?.players.filter(p => p.id !== view.selfId).map(p => <label className={target === p.id ? 'chosen-target' : ''} key={p.id}><input type="radio" name="target" value={p.id} checked={target === p.id} onChange={() => setTarget(p.id)}/>{p.name}<small>{p.role === 'landlord' ? '地主' : '农民'} · {p.cardCount} 张</small></label>)}</fieldset>}{skillDef.select > 0 && <div className="skill-selection-note">先点选下方手牌，需要 {skillDef.select} 张，目前已选 {selected.length} 张。<button className="text-button" onClick={() => setChosenSkill(null)}>返回选牌（选好后再点技能）</button><span>{chosenCards.map(card => `${rankLabel(card.rank)}${suitLabel(card.suit)}`).join('　')}</span></div>}<button className="primary-button" disabled={view?.paused || (!!skillDef.target && !target) || (skillDef.select > 0 && selected.length !== skillDef.select)} onClick={() => { action({ type: 'skill', skillId: chosenSkill.id, targetId: skillDef.target ? target : undefined, cardIds: skillDef.select ? selected : undefined }); setChosenSkill(null); }}>就这么干</button></section></div>}
      {peekOpen && !!view?.privatePeek.length && <div className="modal-backdrop interactive"><section className="modal glass-panel"><button className="modal-close" aria-label="关闭" onClick={() => setPeekOpen(false)}>×</button><h2>嘘，你看到了这些。</h2><p>仅你可见；这是查看那一刻的牌。</p><div className="peek-cards">{view.privatePeek.map(card => <PlayingCard card={card} key={card.id} small disabled/>)}</div><button className="primary-button" onClick={() => setPeekOpen(false)}>记住了</button></section></div>}
      {settings && <div className="modal-backdrop interactive"><section className="modal glass-panel settings-panel"><button className="modal-close" aria-label="关闭" onClick={() => setSettings(false)}>×</button><h2>把桌面调舒服。</h2><label>牌面不透明度 <b>{opacity}%</b><input type="range" min="5" max="75" value={opacity} onChange={e => setOpacity(Number(e.target.value))}/></label><label>界面缩放 <b>{Math.round(zoom * 100)}%</b><input type="range" min="65" max="150" value={Math.round(zoom * 100)} onChange={e => setZoom(Number(e.target.value) / 100)}/></label><label className="checkbox-label"><input type="checkbox" checked={locked} onChange={e => setLocked(e.target.checked)}/>锁定布局，避免误拖</label><label>房间服务地址<input value={address} onChange={e => { setAddress(e.target.value); localStorage.setItem('glass-server', e.target.value); }} placeholder="留空使用当前服务" disabled={!!view}/></label><p>朋友们连接同一个服务，才能找到彼此的房间。桌面版留空即可使用本机服务。</p>{localAddresses.length > 0 && <div className="local-addresses"><strong>本机房间地址 · 同一局域网可用</strong>{localAddresses.map(item => <button className="text-button" key={item} onClick={() => navigator.clipboard.writeText(item).then(() => setStatus("局域网地址已复制。"))}>{item} ⧉</button>)}</div>}<button className="secondary-button" onClick={() => { setPosition({ x: 0, y: 0 }); setZoom(1); }}>恢复位置与大小</button><button className="primary-button" onClick={() => setSettings(false)}>完成</button></section></div>}
      {help && <div className="modal-backdrop interactive"><section className="modal glass-panel help-panel"><button className="modal-close" aria-label="关闭" onClick={() => setHelp(false)}>×</button><h2>打牌认真，捣乱随意。</h2><p>标准三人斗地主：叫分最高者成为地主并获得底牌，地主先出。连续两家不出后清桌，原领出者开启下一轮。</p><div className="rule-facts"><span>地主<b>抽 2 · 留 3</b></span><span>每名农民<b>抽 1 · 留 2</b></span><span>技能阶段<b>地主最多用 2 · 农民用 1</b></span></div><p>每轮结束抽技能，超出上限先弃牌，再依次使用。允许保留技能。合法出完最后一手，立即获胜。</p><div className="help-skill-list">{SKILLS.map(skill => <div key={skill.kind}><strong>{skill.name}<small>{skill.weight}%</small></strong><p>{skill.description}</p></div>)}</div><p>赖子只代替3～A，不参与炸弹。生成的普通牌允许重复点数，炸弹仍为四张同点数。身份互换每局一次、全桌洗手每局两次。</p><button className="primary-button" onClick={() => setHelp(false)}>懂了，开整</button></section></div>}
      {history && <div className="modal-backdrop interactive"><section className="modal glass-panel history-panel"><button className="modal-close" aria-label="关闭" onClick={() => setHistory(false)}>×</button><h2>刚才发生了什么</h2><ol className="history-list">{view?.logs.slice().reverse().map((log, i) => <li key={`${i}-${log}`}>{log}</li>)}</ol></section></div>}
    </main>
  </div>;
}
