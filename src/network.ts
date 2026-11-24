import type { ClientMessage, GameAction, GameView, ServerMessage } from './shared/types.ts';
import { DEFAULT_ROOM_SERVER } from './config.ts';
export type Session = { code: string; token: string; playerId: string; endpoint: string };
const sessionStore = () => window.desktop ? localStorage : sessionStorage;
export class RoomConnection {
  socket: WebSocket | null = null;
  session: Session | null = null;
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectUntil = 0;
  constructor(private callbacks: { state: (state: GameView) => void; status: (text: string, busy: boolean) => void; joined: (s: Session) => void; left: () => void }) {}
  static endpoint(address: string): string {
    const fallback = location.protocol === 'file:' ? 'http://127.0.0.1:4317' : location.origin;
    const url = new URL(address || DEFAULT_ROOM_SERVER || fallback);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写完整的房间服务地址，例如 https://你的服务.onrender.com');
    if (location.protocol === 'https:' && ['http:', 'ws:'].includes(url.protocol)) throw new Error('这个页面需要连接 https 房间服务。');
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = '/ws'; return url.href;
  }
  enter(type: 'create' | 'join', data: { name: string; password: string; code?: string }, address: string) {
    this.forget(false); this.connect(RoomConnection.endpoint(address), { type, ...data } as ClientMessage);
  }
  private connect(endpoint: string, request: ClientMessage) {
    const generation = ++this.generation;
    let accepted = false;
    this.callbacks.status(request.type === 'resume' ? '连接中断，正在恢复座位…' : '正在连接；免费服务首次唤醒可能需要一分钟…', true);
    const socket = new WebSocket(endpoint); this.socket = socket;
    const timeout = setTimeout(() => { if (generation !== this.generation) return; socket.close(); if (!this.session) this.callbacks.status('连接超时，请检查服务地址后重试。', false); }, 75000);
    socket.onopen = () => {
      socket.send(JSON.stringify(request));
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: 'ping', at: Date.now() }), 10000);
    };
    socket.onmessage = event => {
      if (generation !== this.generation) return;
      let message: ServerMessage; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'joined') {
        if (request.type === 'resume') window.dispatchEvent(new Event('glass-effects-resume'));
        clearTimeout(timeout); this.reconnectUntil = 0; accepted = true;
        this.session = { code: message.code, token: message.token, playerId: message.playerId, endpoint };
        sessionStore().setItem('glass-room', JSON.stringify(this.session)); this.callbacks.joined(this.session); this.callbacks.status('已连接', false);
      } else if (message.type === 'state') this.callbacks.state(message.state);
      else if (message.type === 'error') { clearTimeout(timeout); if (request.type === 'resume' && !accepted) this.forget(); this.callbacks.status(message.message, false); }
      else if (message.type === 'closed') { this.forget(); this.callbacks.status(message.message, false); }
    };
    socket.onclose = () => {
      clearTimeout(timeout); if (generation !== this.generation) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.session) { this.callbacks.status('未连接房间服务，请确认地址后重试。', false); return; }
      this.reconnectUntil ||= Date.now() + 175000;
      if (Date.now() > this.reconnectUntil) { this.forget(); this.callbacks.status('座位恢复超时，请重新加入房间。', false); return; }
      this.callbacks.status('连接中断，正在恢复座位…', true);
      this.retry = setTimeout(() => { if (this.session) this.connect(endpoint, { type: 'resume', code: this.session.code, token: this.session.token }); }, 1800);
    };
    socket.onerror = () => {};
  }
  send(message: ClientMessage) { if (this.socket?.readyState === WebSocket.OPEN) { this.socket.send(JSON.stringify(message)); return true; } return false; }
  action(action: GameAction) { return this.send({ type: 'action', action }); }
  restore() {
    try { const saved = JSON.parse(sessionStore().getItem('glass-room') || 'null') as Session | null; if (saved?.code && saved.token && saved.endpoint) { RoomConnection.endpoint(saved.endpoint); this.session = saved; this.connect(saved.endpoint, { type: 'resume', code: saved.code, token: saved.token }); } } catch { sessionStore().removeItem('glass-room'); }
  }
  forget(notify = true) {
    this.generation++; if (this.retry) clearTimeout(this.retry); if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(); this.socket = null; this.session = null; this.reconnectUntil = 0;
    sessionStore().removeItem('glass-room'); if (notify) this.callbacks.left();
  }
  leave() { this.send({ type: 'leave' }); this.forget(); }
  dispose() {
    this.generation++; if (this.retry) clearTimeout(this.retry); if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close(); this.socket = null;
  }
}
