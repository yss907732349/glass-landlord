import { useEffect, useRef, useState } from 'react';
import type { GameEvent, GameView } from './shared/types.ts';
import { QUICK_CHATS } from './shared/chat.ts';

export function QuickChat({ view, onSend }: { view: GameView; onSend: (phraseId: number) => void }) {
  const [open, setOpen] = useState(false);
  const available = view.capabilities?.includes('quick-chat');
  return <div className="quick-chat interactive">
    <button type="button" className="text-button" aria-label="快捷聊天" aria-expanded={open} disabled={!available} title={available ? '发送固定短句' : '房间服务更新后可使用快捷聊天'} onClick={() => setOpen(value => !value)}>聊天</button>
    {open && <div className="chat-menu" aria-label="快捷聊天短句"><div className="chat-menu-heading"><span>快捷聊天</span><button type="button" className="text-button" aria-label="收起快捷聊天" onClick={() => setOpen(false)}>×</button></div>{QUICK_CHATS.map((text, index) => <button type="button" className="chat-phrase" key={text} onClick={() => { onSend(index); setOpen(false); }}>{text}</button>)}</div>}
  </div>;
}

type Bubble = { event: GameEvent; expires: number };
export function ChatBubbles({ view }: { view: GameView | null }) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const seen = useRef(new Set<string>());
  const room = useRef('');
  const baseline = useRef(false);
  useEffect(() => {
    const resume = () => { baseline.current = true; setBubbles([]); };
    window.addEventListener('glass-effects-resume', resume);
    return () => window.removeEventListener('glass-effects-resume', resume);
  }, []);
  useEffect(() => {
    if (!view) { room.current = ''; seen.current.clear(); setBubbles(previous => previous.length ? [] : previous); return; }
    const key = `${view.code}:${view.selfId}`;
    const events = view.events ?? [];
    if (key !== room.current || baseline.current) {
      room.current = key; baseline.current = false; seen.current = new Set(events.map(event => event.id)); setBubbles([]); return;
    }
    const fresh = events.filter(event => !seen.current.has(event.id) && event.type === 'chat' && Number.isInteger(event.phraseId) && QUICK_CHATS[event.phraseId!] !== undefined);
    for (const event of events) seen.current.add(event.id);
    if (seen.current.size > 100) seen.current = new Set(events.map(event => event.id));
    if (!fresh.length) return;
    const now = Date.now();
    setBubbles(previous => {
      const next = new Map(previous.filter(bubble => bubble.expires > now).map(bubble => [bubble.event.actorId, bubble]));
      for (const event of fresh) next.set(event.actorId, { event, expires: now + 4500 });
      return [...next.values()];
    });
  }, [view]);
  useEffect(() => {
    if (!bubbles.length) return;
    const timer = setTimeout(() => setBubbles(previous => previous.filter(bubble => bubble.expires > Date.now())), Math.max(0, Math.min(...bubbles.map(bubble => bubble.expires)) - Date.now()));
    return () => clearTimeout(timer);
  }, [bubbles]);
  if (!view) return null;
  const selfIndex = view.players.findIndex(player => player.id === view.selfId);
  return <div className="chat-bubbles" aria-live="polite">{bubbles.map(({ event }) => {
    const index = view.players.findIndex(player => player.id === event.actorId);
    if (index < 0) return null;
    const side = event.actorId === view.selfId ? 'self-bubble' : index === (selfIndex + 1) % 3 ? 'right-bubble' : 'left-bubble';
    return <div className={`chat-bubble ${side}`} data-actor-id={event.actorId} data-phrase-id={event.phraseId} key={event.id}><small>{view.players[index].name}</small><p>{QUICK_CHATS[event.phraseId!]}</p></div>;
  })}</div>;
}
