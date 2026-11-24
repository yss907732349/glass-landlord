import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameEvent, GameView, PlayerView } from './shared/types.ts';
import { SKILLS } from './shared/skills.ts';
import './effects.css';

type Point = { x: number; y: number };
type Effect = { event: GameEvent; selfId: string; players: PlayerView[]; direction: 1 | -1; expires: number };
const CENTER: Point = { x: 540, y: 210 };
const LIFETIME = 1800;
const MAX_EFFECTS = 5;
const css = (values: Record<string, string | number>): CSSProperties => values as CSSProperties;
const place = (point: Point): CSSProperties => ({ left: point.x, top: point.y });

function playerPoint(effect: Effect, id: string | undefined, area: 'hand' | 'skill' = 'hand'): Point {
  const self = effect.players.findIndex(player => player.id === effect.selfId);
  const index = effect.players.findIndex(player => player.id === id);
  if (index < 0 || index === self) return area === 'skill' ? { x: 540, y: 515 } : { x: 540, y: 410 };
  const right = index === (self + 1) % 3;
  return { x: right ? 940 : 140, y: area === 'skill' ? 125 : 155 };
}

/** Neutral backs only: flights never contain card rank/suit or hidden hand data. */
function Flight({ from, to, index = 0, delay = 0, duration = .88, gold = false, skill = false, returnPath = false }: {
  from: Point; to: Point; index?: number; delay?: number; duration?: number; gold?: boolean; skill?: boolean; returnPath?: boolean;
}) {
  const offset = (index % 3 - 1) * 12;
  const sx = from.x + offset;
  const sy = from.y + (index % 2) * 8;
  const tx = to.x + offset;
  const ty = to.y + (index % 2) * 6;
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2 - (returnPath ? -44 : 55);
  return <span className={`fx-flight ${gold ? 'fx-gold-flight' : ''} ${skill ? 'fx-skill-flight' : ''}`} style={css({
    '--sx': `${sx}px`, '--sy': `${sy}px`, '--tx': `${tx}px`, '--ty': `${ty}px`, '--mx': `${mx}px`, '--my': `${my}px`,
    '--tilt': `${(index % 2 ? 1 : -1) * 13}deg`, '--delay': `${delay}s`, '--flight-time': `${duration}s`,
  })} aria-hidden="true"><i className="fx-flight-tail"/><i className="fx-flight-card"><i/>{skill && <b>✧</b>}</i><i className="fx-flight-glint"/></span>;
}

function Flights({ from, to, count, delay = .12, duration = .88, gold = false, skill = false, returnPath = false }: {
  from: Point; to: Point; count: number; delay?: number; duration?: number; gold?: boolean; skill?: boolean; returnPath?: boolean;
}) {
  return <>{Array.from({ length: Math.max(0, Math.min(count, 6)) }, (_, index) => <Flight key={index} from={from} to={to} index={index} delay={delay + index * .085} duration={duration} gold={gold} skill={skill} returnPath={returnPath}/>)}</>;
}

function FloatCount({ point, text, gain = false, delay = .55 }: { point: Point; text: string; gain?: boolean; delay?: number }) {
  return <span className={`fx-count ${gain ? 'fx-count-gain' : ''}`} style={{ ...place({ x: point.x, y: point.y - 67 }), animationDelay: `${delay}s` }} aria-hidden="true">{text}</span>;
}

function Halo({ point, gold = false }: { point: Point; gold?: boolean }) {
  return <span className={`fx-target-halo ${gold ? 'fx-gold-halo' : ''}`} style={place(point)} aria-hidden="true"><i/><i/></span>;
}

function Peek({ point, count }: { point: Point; count: number }) {
  return <div className="fx-peek" style={place(point)} aria-hidden="true">
    <span className="fx-peek-fan">{Array.from({ length: Math.min(3, count) }, (_, index) => <i className="fx-peek-card" key={index} style={css({ '--peek-i': index })}><b/></i>)}</span>
    <span className="fx-peek-scanner"/>
    <svg className="fx-eye" viewBox="0 0 80 48"><path d="M6 24C20 4 60 4 74 24C60 44 20 44 6 24Z"/><circle cx="40" cy="24" r="10"/><circle cx="42" cy="21" r="3"/></svg>
    <span className="fx-peek-caption">查看 {Math.min(3, count)} 张</span>
  </div>;
}

function IdentityBadge({ from, to, role }: { from: Point; to: Point; role: 'landlord' | 'farmer' }) {
  return <span className={`fx-identity-flight ${role === 'landlord' ? 'fx-landlord-badge' : ''}`} style={css({
    '--sx': `${from.x}px`, '--sy': `${from.y - 40}px`, '--tx': `${to.x}px`, '--ty': `${to.y - 40}px`,
    '--mx': `${(from.x + to.x) / 2}px`, '--my': `${(from.y + to.y) / 2 - 110}px`, '--tilt': '0deg', '--delay': '.12s', '--flight-time': '1.1s',
  })} aria-hidden="true"><b>{role === 'landlord' ? '♛' : '♧'}</b>{role === 'landlord' ? '地主' : '农民'}</span>;
}

function SkillVisual({ effect }: { effect: Effect }) {
  const { event } = effect;
  const actor = playerPoint(effect, event.actorId);
  const target = playerPoint(effect, event.targetId);
  const kind = event.skillKind;
  const targetPlayer = effect.players.find(player => player.id === event.targetId);
  switch (kind) {
    case 'steal': return <><Flights from={target} to={actor} count={1}/><Halo point={target}/><FloatCount point={target} text="−1 张"/><FloatCount point={actor} text="＋1 张" gain/></>;
    case 'gift': return <><Flights from={actor} to={target} count={1}/><Halo point={target}/><FloatCount point={actor} text="−1 张"/><FloatCount point={target} text="＋1 张" gain/></>;
    case 'trade': return <><Flights from={actor} to={target} count={2}/><Flights from={target} to={actor} count={1} delay={.29} returnPath/><Halo point={target}/><FloatCount point={actor} text="−1 张"/><FloatCount point={target} text="＋1 张" gain/></>;
    case 'three':
    case 'addTwo': {
      const count = kind === 'three' ? 1 : 2;
      return <><span className="fx-spawn-burst" style={place(CENTER)} aria-hidden="true">✧</span><Flights from={CENTER} to={target} count={count}/><Halo point={target}/><FloatCount point={target} text={`＋${count} 张`} gain/></>;
    }
    case 'wild': return <><span className="fx-wild-bloom" style={place(CENTER)} aria-hidden="true"><i/><i/><b>✧</b></span><Flights from={CENTER} to={actor} count={1} gold/><Halo point={actor} gold/><FloatCount point={actor} text="赖子 ＋1" gain/></>;
    case 'mutual': return <><span className="fx-spawn-burst" style={place(CENTER)} aria-hidden="true">✧</span><Flights from={CENTER} to={actor} count={3}/><Flights from={CENTER} to={target} count={3} delay={.19}/><Halo point={actor}/><Halo point={target}/><FloatCount point={actor} text="＋3 张" gain/><FloatCount point={target} text="＋3 张" gain/></>;
    case 'peek': return <><Halo point={target}/><Peek point={target} count={targetPlayer?.cardCount ?? 3}/></>;
    case 'shuffle': return <>
      {effect.players.map(player => <span key={player.id}><Flights from={playerPoint(effect, player.id)} to={CENTER} count={3} delay={0} duration={.62}/><Flights from={CENTER} to={playerPoint(effect, player.id)} count={3} delay={.73} duration={.65} returnPath/></span>)}
      <span className="fx-shuffle-vortex" style={place(CENTER)} aria-hidden="true"><i/><i/><b>⤨</b><span>重新洗手</span></span>
    </>;
    case 'identity': {
      const actorRole = targetPlayer?.role === 'landlord' ? 'landlord' : 'farmer';
      const targetRole = actorRole === 'landlord' ? 'farmer' : 'landlord';
      return <><IdentityBadge from={actor} to={target} role={actorRole}/><IdentityBadge from={target} to={actor} role={targetRole}/><Halo point={actor} gold/><Halo point={target} gold/></>;
    }
    case 'reverse': return <div className={`fx-reverse ${effect.direction === -1 ? 'fx-counterclockwise' : ''}`} style={place(CENTER)} aria-hidden="true"><svg viewBox="0 0 180 180"><circle className="fx-reverse-track" cx="90" cy="90" r="64"/><g className="fx-reverse-arrows"><path d="M31 69A63 63 0 0 1 145 53"/><path d="M145 53L145 30M145 53L123 49"/><path d="M149 111A63 63 0 0 1 35 127"/><path d="M35 127L35 150M35 127L57 131"/></g></svg><strong>{effect.direction === 1 ? '顺时针' : '逆时针'}</strong><span>方向反转</span></div>;
    default: return null;
  }
}

function EventVisual({ effect }: { effect: Effect }) {
  const { event } = effect;
  const actor = playerPoint(effect, event.actorId);
  const skillPoint = playerPoint(effect, event.actorId, 'skill');
  const actorName = effect.players.find(player => player.id === event.actorId)?.name ?? '朋友';
  const skillName = SKILLS.find(skill => skill.kind === event.skillKind)?.name ?? '技能';
  const targetName = effect.players.find(player => player.id === event.targetId)?.name;
  const announcementPoint = { x: actor.x, y: event.actorId === effect.selfId ? 325 : 245 };
  return <div className={`skill-fx fx-event-${event.type} ${event.skillKind ? `fx-kind-${event.skillKind}` : ''}`} data-event-id={event.id} data-kind={event.skillKind ?? event.type}>
    {event.type === 'skill' && <><div className="fx-announcement" style={place(announcementPoint)} role="status"><span className="fx-announcement-symbol">{event.skillKind === 'reverse' ? '↶' : event.skillKind === 'identity' ? '♛' : '✧'}</span><div><strong>{actorName} · {skillName}</strong><small>{targetName ? `对 ${targetName} 使用` : event.skillKind === 'shuffle' ? '全桌手牌重新分配' : event.skillKind === 'reverse' ? '接牌顺序已经改变' : '技能已生效'}</small></div></div><SkillVisual effect={effect}/></>}
    {event.type === 'drawSkills' && <><Flights from={CENTER} to={skillPoint} count={event.count ?? 1} skill delay={.05}/><FloatCount point={skillPoint} text={`技能 ＋${event.count ?? 1}`} gain delay={.55}/></>}
    {event.type === 'discardSkills' && <><div className="fx-discard-drift" style={place(skillPoint)} aria-hidden="true">{Array.from({ length: Math.min(event.count ?? 1, 5) }, (_, index) => <i key={index} style={css({ '--discard-i': index })}>✧</i>)}</div><FloatCount point={skillPoint} text={`弃技能 ${event.count ?? 1}`} delay={.15}/></>}
    {event.type === 'play' && <Flights from={actor} to={CENTER} count={Math.min(event.count ?? 1, 4)} delay={0} duration={.52}/>}
    {event.type === 'pass' && <span className="fx-pass" style={place({ x: actor.x, y: event.actorId === effect.selfId ? 325 : 245 })}>不出</span>}
  </div>;
}

export function TableEffects({ view }: { view: GameView | null }) {
  const [active, setActive] = useState<Effect[]>([]);
  const seen = useRef(new Set<string>());
  const identity = useRef('');
  const needsBaseline = useRef(false);
  const wasPaused = useRef(false);
  useEffect(() => {
    if (!view) {
      seen.current.clear(); identity.current = ''; needsBaseline.current = false; wasPaused.current = false;
      setActive(previous => previous.length ? [] : previous);
      return;
    }
    const key = `${view.code}:${view.selfId}`;
    const now = Date.now();
    const events = view.events ?? [];
    const reset = identity.current !== key || needsBaseline.current || (wasPaused.current && !view.paused);
    identity.current = key; needsBaseline.current = false; wasPaused.current = view.paused;
    if (reset) {
      seen.current = new Set(events.map(event => event.id));
      setActive(previous => previous.length ? [] : previous);
      return;
    }
    const fresh = events.filter(event => !seen.current.has(event.id));
    for (const event of events) seen.current.add(event.id);
    if (seen.current.size > 120) seen.current = new Set(events.map(event => event.id));
    if (!fresh.length || view.paused) return;
    const batch = fresh.filter(event => event.type !== 'chat').slice(-MAX_EFFECTS).map(event => ({ event, selfId: view.selfId, players: view.players, direction: view.direction, expires: now + LIFETIME }));
    if (!batch.length) return;
    setActive(previous => [...previous.filter(effect => effect.expires > now), ...batch].slice(-MAX_EFFECTS));
  }, [view]);
  useEffect(() => {
    const resume = () => { needsBaseline.current = true; setActive(previous => previous.length ? [] : previous); };
    window.addEventListener('glass-effects-resume', resume);
    return () => window.removeEventListener('glass-effects-resume', resume);
  }, []);
  useEffect(() => {
    if (!active.length) return;
    const timer = setTimeout(() => setActive(previous => previous.filter(effect => effect.expires > Date.now())), Math.max(0, Math.min(...active.map(effect => effect.expires)) - Date.now()));
    return () => clearTimeout(timer);
  }, [active]);
  return <div className="table-effects" aria-live="polite" aria-atomic="false">{active.map(effect => <EventVisual effect={effect} key={effect.event.id}/>)}</div>;
}
