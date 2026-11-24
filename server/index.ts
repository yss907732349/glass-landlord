import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from '../src/shared/game.ts';
import { readyBots, runBotTurn } from './bots.ts';
import type { ClientMessage, ServerMessage } from '../src/shared/types.ts';

const scrypt = promisify(scryptCallback);
const MAX_MESSAGE = 32 * 1024;
const RECONNECT_MS = 180_000;
const EMPTY_ROOM_MS = 30 * 60_000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

interface Seat {
  id: string;
  token: string;
  socket: WebSocket | null;
  disconnectedAt: number | null;
}
interface Room {
  code: string;
  salt: Buffer;
  passwordHash: Buffer;
  game: Game;
  seats: Map<string, Seat>;
  touchedAt: number;
  lastVersion: number;
  botNextAt: number;
}
interface Connection {
  room: Room | null;
  seatId: string | null;
  ip: string;
  windowAt: number;
  messages: number;
  alive: boolean;
  chain: Promise<void>;
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('请输入昵称。');
  const value = name.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!value || value.length > 20) throw new Error('昵称需要为1–20个字符。');
  return value;
}

function validPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 4 || password.length > 32) {
    throw new Error('房间密码需要为4–32个字符。');
  }
  return password;
}

function validCode(code: unknown): string {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('请输入六位房间号。');
  return code;
}

/** One authoritative process owns all rooms. Pass port: 0 for an available local port. */
export async function createGameServer(options: { port?: number; host?: string; staticDir?: string } = {}): Promise<{
  server: Server; port: number; close: () => Promise<void>;
}> {
  const rooms = new Map<string, Room>();
  const connections = new WeakMap<WebSocket, Connection>();
  const attempts = new Map<string, { at: number; count: number }>();
  const publicRoot = resolve(options.staticDir ?? resolve(process.cwd(), 'dist'));
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const trustProxy = process.env.TRUST_PROXY === '1';

  function clientIp(request: IncomingMessage) {
    if (trustProxy) {
      const forwarded = request.headers['x-forwarded-for'];
      if (typeof forwarded === 'string') return forwarded.split(',').at(-1)!.trim();
    }
    return request.socket.remoteAddress ?? 'unknown';
  }

  function originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true; // Native clients do not always attach an Origin header.
    if (origin === 'null') return process.env.ALLOW_FILE_ORIGIN === '1';
    if (allowedOrigins.includes(origin)) return true;
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      // Packaged desktop clients load their trusted UI from an ephemeral loopback port.
      if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return true;
      return parsed.host === request.headers.host;
    } catch { return false; }
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); }
    catch { response.writeHead(400).end('Invalid path'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
    }
    if (pathname === '/health') {
      response.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, service: 'glass-landlord', rooms: rooms.size }));
      return;
    }
    if (pathname.includes('\0') || pathname.includes('\\')) { response.writeHead(400).end(); return; }
    let file = resolve(publicRoot, '.' + pathname);
    if (file !== publicRoot && !file.startsWith(publicRoot + sep)) { response.writeHead(403).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    } catch {
      if (!extname(pathname) && !pathname.startsWith('/src/') && !pathname.startsWith('/server/')) file = resolve(publicRoot, 'index.html');
    }
    try {
      const actual = await realpath(file);
      const actualRoot = await realpath(publicRoot);
      if (!actual.startsWith(actualRoot + sep)) { response.writeHead(403).end(); return; }
      const data = await readFile(actual);
      response.writeHead(200, {
        'Content-Type': MIME[extname(actual)] ?? 'application/octet-stream',
        'Cache-Control': extname(actual) === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('页面不存在，请先完成构建。');
    }
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; } catch { /* rejected below */ }
    if (pathname !== '/ws' || !originAllowed(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws, request));
  });

  function broadcast(room: Room) {
    for (const seat of room.seats.values()) {
      if (seat.socket?.readyState === WebSocket.OPEN) send(seat.socket, { type: 'state', state: room.game.view(seat.id) });
    }
    const anySeat = room.seats.values().next().value as Seat | undefined;
    if (anySeat) room.lastVersion = room.game.view(anySeat.id).version;
  }

  function closeRoom(room: Room, message: string) {
    if (rooms.get(room.code) !== room) return;
    rooms.delete(room.code);
    for (const seat of room.seats.values()) {
      if (!seat.socket) continue;
      send(seat.socket, { type: 'closed', message });
      const connection = connections.get(seat.socket);
      if (connection) { connection.room = null; connection.seatId = null; }
      seat.socket.close(1000, 'Room closed');
      seat.socket = null;
    }
  }

  function attach(room: Room, seat: Seat, socket: WebSocket, connection: Connection) {
    const oldSocket = seat.socket;
    // Set the new owner before closing the previous socket; its close handler must not disconnect us.
    seat.socket = socket;
    seat.disconnectedAt = null;
    connection.room = room;
    connection.seatId = seat.id;
    room.touchedAt = Date.now();
    room.game.setConnected(seat.id, true);
    if (oldSocket && oldSocket !== socket) {
      const previous = connections.get(oldSocket);
      if (previous) { previous.room = null; previous.seatId = null; }
      send(oldSocket, { type: 'closed', message: '此座位已在另一个窗口恢复。' });
      oldSocket.close(1000, 'Session replaced');
    }
    send(socket, { type: 'joined', code: room.code, token: seat.token, playerId: seat.id });
    broadcast(room);
  }

  function checkAttempts(ip: string) {
    const now = Date.now();
    let entry = attempts.get(ip);
    if (!entry || now - entry.at > 60_000) { entry = { at: now, count: 0 }; attempts.set(ip, entry); }
    if (++entry.count > 12) throw new Error('尝试次数过多，请一分钟后再试。');
  }

  async function handle(socket: WebSocket, connection: Connection, raw: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    let message: ClientMessage;
    try { message = JSON.parse(raw); } catch { throw new Error('无法识别消息。'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('无法识别消息。');
    if (message.type === 'ping') {
      if (typeof message.at === 'number' && Number.isFinite(message.at)) send(socket, { type: 'pong', at: message.at });
      return;
    }
    if (message.type === 'create') {
      if (connection.room) throw new Error('请先离开当前房间。');
      checkAttempts(connection.ip);
      if (rooms.size >= 1000) throw new Error('房间服务繁忙，请稍后再试。');
      const name = cleanName(message.name);
      const password = validPassword(message.password);
      const salt = randomBytes(16);
      const passwordHash = await scrypt(password, salt, 32) as Buffer;
      if (socket.readyState !== WebSocket.OPEN) return;
      let code: string;
      do { code = String(randomInt(100_000, 1_000_000)); } while (rooms.has(code));
      const id = randomBytes(12).toString('hex');
      const game = new Game(code);
      game.addPlayer(id, name);
      const seat: Seat = { id, token: randomBytes(32).toString('hex'), socket: null, disconnectedAt: null };
      const room: Room = { code, salt, passwordHash, game, seats: new Map([[id, seat]]), touchedAt: now, lastVersion: -1, botNextAt: now + 1400 };
      rooms.set(code, room);
      attach(room, seat, socket, connection);
      return;
    }
    if (message.type === 'join') {
      if (connection.room) throw new Error('请先离开当前房间。');
      checkAttempts(connection.ip);
      const code = validCode(message.code);
      const name = cleanName(message.name);
      const password = validPassword(message.password);
      const room = rooms.get(code);
      if (!room) throw new Error('房间不存在或已关闭。');
      const candidate = await scrypt(password, room.salt, 32) as Buffer;
      if (!timingSafeEqual(candidate, room.passwordHash)) throw new Error('房间号或密码不正确。');
      if (socket.readyState !== WebSocket.OPEN || rooms.get(code) !== room) return;
      // Recheck after asynchronous hashing so concurrent joins cannot create a fourth seat.
      if (room.game.phase !== 'lobby') throw new Error('本局已经开始，请等待结束后再加入。');
      if (room.seats.size >= 3) throw new Error('房间已满，最多三人。');
      const id = randomBytes(12).toString('hex');
      const seat: Seat = { id, token: randomBytes(32).toString('hex'), socket: null, disconnectedAt: null };
      room.game.addPlayer(id, name);
      room.seats.set(id, seat);
      attach(room, seat, socket, connection);
      return;
    }
    if (message.type === 'resume') {
      if (connection.room) throw new Error('当前窗口已在房间中。');
      checkAttempts(connection.ip);
      const room = rooms.get(validCode(message.code));
      if (!room || typeof message.token !== 'string' || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('重连凭证已失效，请重新加入房间。');
      const token = Buffer.from(message.token, 'hex');
      const seat = [...room.seats.values()].find(item => timingSafeEqual(Buffer.from(item.token, 'hex'), token));
      if (!seat || (seat.disconnectedAt && now - seat.disconnectedAt > RECONNECT_MS)) throw new Error('重连凭证已失效，请重新加入房间。');
      attach(room, seat, socket, connection);
      return;
    }
    const room = connection.room;
    const seat = room?.seats.get(connection.seatId ?? '');
    if (!room || !seat || seat.socket !== socket || rooms.get(room.code) !== room) throw new Error('请先创建或加入房间。');
    room.touchedAt = now;
    if (message.type === 'leave') {
      connection.room = null;
      connection.seatId = null;
      seat.socket = null;
      if (room.game.phase === 'lobby') {
        room.game.removePlayer(seat.id);
        room.seats.delete(seat.id);
        if (!room.seats.size) rooms.delete(room.code);
        else broadcast(room);
      } else closeRoom(room, '有玩家离开，本局已结束，请重新创建房间。');
      send(socket, { type: 'closed', message: '已离开房间。' });
      return;
    }
    if (message.type === 'action') {
      if (!message.action || typeof message.action !== 'object' || Array.isArray(message.action)) throw new Error('无法识别操作。');
      if (message.action.type === 'fillBots') {
        if (room.game.phase !== 'lobby' || room.game.hostId !== seat.id) throw new Error('只有房主可以在准备阶段添加陪练。');
        if (room.seats.size >= 3) throw new Error('房间已经满员。');
        const names = ['小满', '阿七'];
        while (room.seats.size < 3) {
          const id = 'bot-' + randomBytes(12).toString('hex');
          room.game.addPlayer(id, names[room.seats.size - 1] ?? '小满');
          room.game.act(id, { type: 'ready', ready: true });
          room.seats.set(id, { id, token: randomBytes(32).toString('hex'), socket: null, disconnectedAt: null });
        }
        broadcast(room);
        return;
      }
      room.game.act(seat.id, message.action);
      if (message.action.type === 'restart') readyBots(room.game);
      broadcast(room);
      return;
    }
    throw new Error('无法识别操作。');
  }

  sockets.on('connection', (socket, request) => {
    const connection: Connection = {
      room: null, seatId: null, ip: clientIp(request), windowAt: Date.now(), messages: 0, alive: true, chain: Promise.resolve(),
    };
    connections.set(socket, connection);
    socket.on('pong', () => { connection.alive = true; });
    socket.on('message', (data, binary) => {
      const now = Date.now();
      if (now - connection.windowAt > 1000) { connection.windowAt = now; connection.messages = 0; }
      if (++connection.messages > 30) {
        send(socket, { type: 'error', message: '操作太快，请稍后再试。' });
        if (connection.messages > 60) socket.close(1008, 'Rate limit');
        return;
      }
      if (binary) { send(socket, { type: 'error', message: '只支持文字消息。' }); return; }
      connection.chain = connection.chain.then(() => handle(socket, connection, data.toString())).catch(error => {
        send(socket, { type: 'error', message: error instanceof Error ? error.message : '操作未完成，请重试。' });
      });
    });
    socket.on('close', () => {
      const room = connection.room;
      const seat = room?.seats.get(connection.seatId ?? '');
      if (!room || !seat || seat.socket !== socket || rooms.get(room.code) !== room) return;
      seat.socket = null;
      seat.disconnectedAt = Date.now();
      room.game.setConnected(seat.id, false);
      broadcast(room);
    });
    socket.on('error', () => { /* close handler handles room state; no credentials are logged */ });
  });

  const tickTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const expired = [...room.seats.values()].filter(seat => seat.disconnectedAt && now - seat.disconnectedAt > RECONNECT_MS);
      if (expired.length) {
        if (room.game.phase !== 'lobby') { closeRoom(room, '有玩家离线超过三分钟，房间已关闭。'); continue; }
        for (const seat of expired) { room.game.removePlayer(seat.id); room.seats.delete(seat.id); }
        if (!room.seats.size) { rooms.delete(room.code); continue; }
        broadcast(room);
      }
      if (![...room.seats.values()].some(seat => seat.socket) && now - room.touchedAt > EMPTY_ROOM_MS) {
        closeRoom(room, '房间长时间无人，已关闭。'); continue;
      }
      room.game.tick(now);
      if (now >= room.botNextAt) {
        room.botNextAt = now + 1400;
        const firstView = room.game.view(room.seats.keys().next().value!);
        if (!firstView.paused) {
          const bot = [...room.seats.values()].find(seat => {
            if (!seat.id.startsWith('bot-')) return false;
            if (firstView.phase === 'skill_discard') return room.game.view(seat.id).mustDiscard > 0;
            return (firstView.phase === 'skill_use' ? firstView.skillActorId : firstView.turnId) === seat.id;
          });
          if (bot) {
            try { runBotTurn(room.game, bot.id); }
            catch { /* A changed turn is retried on the next scheduled bot action. */ }
          }
        }
      }
      const first = room.seats.values().next().value as Seat | undefined;
      if (first && room.game.view(first.id).version !== room.lastVersion) broadcast(room);
    }
    for (const [ip, entry] of attempts) if (now - entry.at > 60_000) attempts.delete(ip);
  }, 500);
  tickTimer.unref();
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      const connection = connections.get(socket)!;
      if (!connection.alive) { socket.terminate(); continue; }
      connection.alive = false;
      socket.ping();
    }
  }, 20_000);
  heartbeat.unref();

  const requestedPort = options.port ?? Number(process.env.PORT ?? 4317);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(requestedPort, host, () => { server.off('error', reject); resolveListen(); });
    });
  } catch (error) {
    clearInterval(tickTimer); clearInterval(heartbeat); sockets.close(); throw error;
  }
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : requestedPort;
  return {
    server, port,
    async close() {
      clearInterval(tickTimer); clearInterval(heartbeat);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(done => sockets.close(() => done()));
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}

const entry = (process.argv[1] ?? '').replaceAll('\\', '/');
if (entry.endsWith('/server/index.ts') || entry.endsWith('/build/server.cjs')) {
  createGameServer().then(({ port }) => console.log(`玻璃斗地主房间服务已启动：http://127.0.0.1:${port}`)).catch(error => {
    console.error('房间服务启动失败：', error instanceof Error ? error.message : '未知错误');
    process.exitCode = 1;
  });
}
