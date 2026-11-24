import { makeDeck, sortCards } from './cards.ts';
import { beats, classifyAgainst } from './rules.ts';
import { getSkill, SKILLS } from './skills.ts';
import type { Card, GameAction, GameView, Phase, PlayedCards, SkillCard, SkillKind } from './types.ts';

interface Player {
  id: string; name: string; connected: boolean; ready: boolean;
  hand: Card[]; skills: SkillCard[]; peek: Card[]; bid: number | null; plays: number;
}
const DURATIONS = { bidding: 30_000, playing: 45_000, skill_discard: 30_000, skill_use: 25_000 };

export class Game {
  code: string;
  players: Player[] = [];
  phase: Phase = 'lobby';
  hostId = '';
  landlordId: string | null = null;
  turnId: string | null = null;
  direction: 1 | -1 = 1;
  bottom: Card[] = [];
  currentPlay: PlayedCards | null = null;
  lastActorId: string | null = null;
  passCount = 0;
  trick = 1;
  multiplier = 1;
  bidMax = 0;
  bidWinner: string | null = null;
  bidCount = 0;
  skillOrder: string[] = [];
  skillIndex = 0;
  skillBudgets: Record<string, number> = {};
  skillUses: Record<string, number> = {};
  pendingReverse = false;
  identityUses = 0;
  shuffleUses = 0;
  wildCreated = 0;
  logs: string[] = [];
  winner: 'landlord' | 'farmers' | null = null;
  winnerId: string | null = null;
  deadline: number | null = null;
  paused = false;
  version = 0;
  private pausedRemaining = 0;
  private advanceAfterDiscard = false;
  private randomSource?: () => number;
  private clock: () => number;

  constructor(code: string, options: { random?: () => number; now?: () => number } = {}) {
    this.code = code;
    this.randomSource = options.random;
    this.clock = options.now ?? Date.now;
  }

  private rand(max: number): number {
    if (this.randomSource) return Math.min(max - 1, Math.max(0, Math.floor(this.randomSource() * max)));
    const array = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    do { crypto.getRandomValues(array); } while (array[0] >= limit);
    return array[0] % max;
  }
  private shuffled<T>(items: T[]): T[] {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.rand(i + 1); [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  private id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
  private getPlayer(id: string): Player {
    const player = this.players.find(item => item.id === id);
    if (!player) throw new Error('你不在这个房间。');
    return player;
  }
  private log(message: string): void { this.logs = [...this.logs, message].slice(-50); }
  private limit(id: string): number { return id === this.landlordId ? 3 : 2; }
  private excess(player: Player): number { return Math.max(0, player.skills.length - this.limit(player.id)); }
  private timed(phase: Phase): void {
    this.phase = phase;
    this.deadline = phase in DURATIONS ? this.clock() + DURATIONS[phase as keyof typeof DURATIONS] : null;
  }
  private next(id: string, direction = this.direction): string {
    const index = this.players.findIndex(player => player.id === id);
    return this.players[(index + direction + this.players.length) % this.players.length].id;
  }
  private sorted(): void { for (const p of this.players) p.hand = sortCards(p.hand); }
  private selected(player: Player, ids: string[] | undefined, expected?: number): Card[] {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || (expected !== undefined && ids.length !== expected)) throw new Error(`请选择${expected ?? '有效数量的'}张自己的牌。`);
    const cards = ids.map(id => player.hand.find(card => card.id === id));
    if (cards.some(card => !card)) throw new Error('选中的牌不在你的手中。');
    return cards as Card[];
  }
  private take(player: Player, cards: Card[]): void {
    const ids = new Set(cards.map(card => card.id)); player.hand = player.hand.filter(card => !ids.has(card.id));
  }
  private generated(rank?: number, small = false): Card {
    const suits = ['S', 'H', 'C', 'D'] as const;
    return { id: this.id('extra'), rank: rank ?? (3 + this.rand(small ? 5 : 13)), suit: suits[this.rand(4)], generated: true };
  }
  private invalidatePeeks(): void { for (const p of this.players) p.peek = []; }

  addPlayer(id: string, name: string): void {
    if (this.phase !== 'lobby') throw new Error('牌局已经开始，暂时不能加入。');
    if (this.players.some(p => p.id === id)) throw new Error('该座位已经存在。');
    if (this.players.length >= 3) throw new Error('房间已满，最多三人。');
    const clean = name.trim().slice(0, 16);
    if (!clean) throw new Error('请输入昵称。');
    this.players.push({ id, name: clean, connected: true, ready: false, hand: [], skills: [], peek: [], bid: null, plays: 0 });
    if (!this.hostId) this.hostId = id;
    this.log(`${clean} 加入了房间。`); this.version++;
  }

  removePlayer(id: string): void {
    const player = this.getPlayer(id);
    this.players = this.players.filter(item => item.id !== id);
    if (this.hostId === id) this.hostId = this.players[0]?.id ?? '';
    if (this.phase !== 'lobby') { this.reset(); this.log('有人离开，牌局已结束，回到准备房间。'); }
    this.log(`${player.name} 离开了房间。`); this.version++;
  }

  setConnected(id: string, connected: boolean): void {
    const player = this.getPlayer(id);
    if (player.connected === connected) return;
    player.connected = connected;
    const active = !['lobby', 'finished'].includes(this.phase);
    if (active && !connected && !this.paused) {
      this.pausedRemaining = this.deadline ? Math.max(1, this.deadline - this.clock()) : 0;
      this.paused = true; this.deadline = null;
      this.log(`${player.name} 暂时掉线，牌局暂停，等待重连。`);
    } else if (active && this.paused && this.players.every(p => p.connected)) {
      this.paused = false;
      this.deadline = this.pausedRemaining ? this.clock() + this.pausedRemaining : null;
      this.log('玩家已全部回来，牌局继续。');
    }
    this.version++;
  }

  private reset(): void {
    this.phase = 'lobby'; this.landlordId = null; this.turnId = null; this.direction = 1;
    this.bottom = []; this.currentPlay = null; this.lastActorId = null; this.passCount = 0;
    this.trick = 1; this.multiplier = 1; this.bidMax = 0; this.bidWinner = null; this.bidCount = 0;
    this.skillOrder = []; this.skillIndex = 0; this.skillBudgets = {}; this.skillUses = {};
    this.pendingReverse = false; this.identityUses = 0; this.shuffleUses = 0; this.wildCreated = 0;
    this.winner = null; this.winnerId = null; this.deadline = null; this.paused = false;
    this.pausedRemaining = 0; this.advanceAfterDiscard = false;
    for (const p of this.players) { p.hand = []; p.skills = []; p.peek = []; p.ready = false; p.bid = null; p.plays = 0; }
  }

  private deal(): void {
    const deck = this.shuffled(makeDeck());
    this.players.forEach((p, index) => { p.hand = sortCards(deck.slice(index * 17, index * 17 + 17)); p.bid = null; p.plays = 0; });
    this.bottom = deck.slice(51); this.bidMax = 0; this.bidWinner = null; this.bidCount = 0;
    this.turnId = this.players[this.rand(3)].id;
    this.timed('bidding'); this.log('发牌完成，开始叫分。');
  }

  private finishBidding(): void {
    if (!this.bidWinner) { this.log('三家都不叫，重新洗牌。'); this.deal(); return; }
    this.landlordId = this.bidWinner;
    const landlord = this.getPlayer(this.landlordId);
    landlord.hand = sortCards([...landlord.hand, ...this.bottom]);
    this.multiplier = this.bidMax; this.turnId = landlord.id;
    this.timed('playing'); this.log(`${landlord.name} 成为地主，${this.bidMax}分起。`);
  }

  private availablePool(): typeof SKILLS {
    return SKILLS.filter(skill => (skill.kind !== 'identity' || this.identityUses < 1) && (skill.kind !== 'shuffle' || this.shuffleUses < 2) && (skill.kind !== 'wild' || this.wildCreated < 3));
  }
  private drawSkill(): SkillCard {
    const pool = this.availablePool();
    let value = this.rand(pool.reduce((sum, skill) => sum + skill.weight, 0));
    for (const skill of pool) { value -= skill.weight; if (value < 0) return { id: this.id('skill'), kind: skill.kind }; }
    throw new Error('技能牌池为空。');
  }
  private beginSkills(leaderId: string): void {
    this.currentPlay = null; this.passCount = 0; this.turnId = leaderId; this.trick++;
    this.skillOrder = [leaderId, this.next(leaderId), this.next(this.next(leaderId))];
    this.skillIndex = 0; this.pendingReverse = false; this.advanceAfterDiscard = false;
    this.skillBudgets = {}; this.skillUses = {};
    for (const p of this.players) {
      const count = p.id === this.landlordId ? 2 : 1;
      this.skillBudgets[p.id] = count; this.skillUses[p.id] = 0;
      for (let i = 0; i < count; i++) p.skills.push(this.drawSkill());
    }
    this.log('两家不出，本轮清桌。地主抽两张技能，农民各抽一张。');
    if (this.players.some(p => this.excess(p) > 0)) this.timed('skill_discard');
    else this.timed('skill_use');
  }
  private advanceSkills(): void {
    const actor = this.skillOrder[this.skillIndex];
    if (actor) this.skillUses[actor] = this.skillBudgets[actor];
    this.skillIndex++;
    if (this.skillIndex >= this.skillOrder.length) {
      if (this.pendingReverse) { this.direction = this.direction === 1 ? -1 : 1; this.log('出牌方向已反转。'); }
      this.pendingReverse = false; this.skillOrder = []; this.skillIndex = 0;
      this.timed('playing');
    } else this.timed('skill_use');
  }

  private skill(player: Player, action: Extract<GameAction, { type: 'skill' }>): void {
    if (this.phase !== 'skill_use' || this.skillOrder[this.skillIndex] !== player.id) throw new Error('还没轮到你使用技能。');
    if ((this.skillUses[player.id] ?? 0) >= (this.skillBudgets[player.id] ?? 0)) throw new Error('本阶段技能次数已用完。');
    const skill = player.skills.find(card => card.id === action.skillId);
    if (!skill) throw new Error('你没有这张技能牌。');
    const definition = getSkill(skill.kind);
    let target: Player | null = null;
    if (definition.target) {
      if (!action.targetId || action.targetId === player.id) throw new Error('请选择另一名玩家。');
      target = this.getPlayer(action.targetId);
    }
    const cards = definition.select ? this.selected(player, action.cardIds, definition.select) : [];
    if (skill.kind === 'steal' && target!.hand.length < 2) throw new Error('目标至少要保留一张牌，不能偷最后一张。');
    if (skill.kind === 'gift' && player.hand.length < 2) throw new Error('送牌后自己至少保留一张。');
    if (skill.kind === 'trade' && (player.hand.length < 2 || target!.hand.length < 1)) throw new Error('交换需要自己至少两张、目标至少一张。');
    if (skill.kind === 'wild' && (player.hand.some(card => card.wild) || this.wildCreated >= 3)) throw new Error('已有赖子，或本局三张赖子已生成完。');
    if (skill.kind === 'identity' && (this.identityUses >= 1 || ((player.id === this.landlordId) === (target!.id === this.landlordId)))) throw new Error('身份互换只能与相反身份玩家使用，每局限一次。');
    if (skill.kind === 'shuffle' && this.shuffleUses >= 2) throw new Error('本局全桌洗手次数已用完，可以弃掉这张技能。');

    player.skills = player.skills.filter(card => card.id !== skill.id);
    this.skillUses[player.id] = (this.skillUses[player.id] ?? 0) + 1;
    switch (skill.kind) {
      case 'steal': { const card = target!.hand[this.rand(target!.hand.length)]; this.take(target!, [card]); player.hand.push(card); this.invalidatePeeks(); break; }
      case 'gift': this.take(player, cards); target!.hand.push(...cards); this.invalidatePeeks(); break;
      case 'peek': player.peek = this.shuffled(target!.hand).slice(0, 3).map(card => ({ ...card })); break;
      case 'wild': player.hand.push({ id: this.id('wild'), rank: 3, suit: 'W', wild: true, generated: true }); this.wildCreated++; break;
      case 'three': target!.hand.push(this.generated(3)); break;
      case 'addTwo': target!.hand.push(this.generated(), this.generated()); break;
      case 'mutual': for (let i = 0; i < 3; i++) { player.hand.push(this.generated(undefined, true)); target!.hand.push(this.generated(undefined, true)); } break;
      case 'trade': { const received = target!.hand[this.rand(target!.hand.length)]; this.take(player, cards); this.take(target!, [received]); player.hand.push(received); target!.hand.push(...cards); this.invalidatePeeks(); break; }
      case 'shuffle': {
        const pile = this.shuffled(this.players.flatMap(p => p.hand)); let offset = 0;
        for (const p of this.players) { const count = p.hand.length; p.hand = pile.slice(offset, offset + count); offset += count; }
        this.shuffleUses++; this.invalidatePeeks(); break;
      }
      case 'identity': this.landlordId = player.id === this.landlordId ? target!.id : player.id; this.identityUses++; break;
      case 'reverse': this.pendingReverse = !this.pendingReverse; break;
    }
    this.sorted();
    this.log(`${player.name} 使用了「${definition.name}」${target ? `，目标：${target.name}` : ''}。`);
    const done = this.skillUses[player.id] >= this.skillBudgets[player.id] || player.skills.length === 0;
    if (this.players.some(p => this.excess(p) > 0)) {
      this.advanceAfterDiscard = done; this.timed('skill_discard');
    } else if (done) this.advanceSkills();
    else this.timed('skill_use');
  }

  act(id: string, action: GameAction): void {
    const player = this.getPlayer(id);
    if (!action || typeof action.type !== 'string') throw new Error('操作格式不正确。');
    if (this.paused) throw new Error('有人掉线，等待重新连接后继续。');
    switch (action.type) {
      case 'ready':
        if (this.phase !== 'lobby') throw new Error('只能在房间里准备。');
        player.ready = !!action.ready; break;
      case 'start':
        if (id !== this.hostId || this.phase !== 'lobby') throw new Error('只有房主能开始牌局。');
        if (this.players.length !== 3 || this.players.some(p => !p.ready || !p.connected)) throw new Error('需要三名玩家全部准备并在线。');
        this.deal(); break;
      case 'bid':
        if (this.phase !== 'bidding' || this.turnId !== id) throw new Error('还没轮到你叫分。');
        if (!Number.isInteger(action.value) || action.value < 0 || action.value > 3 || (action.value !== 0 && action.value <= this.bidMax)) throw new Error('叫分必须高于当前分数，或选择不叫。');
        player.bid = action.value; this.bidCount++;
        this.log(`${player.name}${action.value ? `叫了${action.value}分` : '不叫'}。`);
        if (action.value > this.bidMax) { this.bidMax = action.value; this.bidWinner = id; }
        if (action.value === 3 || this.bidCount >= 3) this.finishBidding();
        else { this.turnId = this.next(id); this.timed('bidding'); }
        break;
      case 'play': {
        if (this.phase !== 'playing' || this.turnId !== id) throw new Error('还没轮到你出牌。');
        const cards = this.selected(player, action.cardIds);
        if (!cards.length) throw new Error('请先选择要出的牌。');
        const combination = classifyAgainst(cards, this.currentPlay?.combination ?? null, action.wildAs);
        if (!combination) throw new Error('这些牌不能组成合法牌型，请检查赖子点数。');
        if (!beats(combination, this.currentPlay?.combination ?? null)) throw new Error('这手牌压不过上一手。');
        this.take(player, cards); player.plays++;
        this.currentPlay = { playerId: id, cards: cards.map(card => ({ ...card })), combination, ...(action.wildAs ? { wildAs: { ...action.wildAs } } : {}) };
        this.lastActorId = id; this.passCount = 0; this.invalidatePeeks();
        if (['bomb', 'rocket'].includes(combination.type)) this.multiplier *= 2;
        this.log(`${player.name} 打出${combination.label}（${cards.length}张）。`);
        if (!player.hand.length) {
          this.winnerId = id; this.winner = id === this.landlordId ? 'landlord' : 'farmers';
          if (!this.identityUses && ((this.winner === 'landlord' && this.players.filter(p => p.id !== this.landlordId).every(p => p.plays === 0)) || (this.winner === 'farmers' && this.getPlayer(this.landlordId!).plays <= 1))) {
            this.multiplier *= 2; this.log(this.winner === 'landlord' ? '春天！倍率翻倍。' : '反春天！倍率翻倍。');
          }
          this.turnId = null; this.timed('finished'); this.log(`${player.name} 出完手牌，${this.winner === 'landlord' ? '地主' : '农民'}获胜！`);
        } else { this.turnId = this.next(id); this.timed('playing'); }
        break;
      }
      case 'pass':
        if (this.phase !== 'playing' || this.turnId !== id) throw new Error('还没轮到你出牌。');
        if (!this.currentPlay) throw new Error('你是本轮领出者，必须出牌。');
        this.passCount++; this.log(`${player.name} 不出。`);
        if (this.passCount >= 2) this.beginSkills(this.currentPlay.playerId);
        else { this.turnId = this.next(id); this.timed('playing'); }
        break;
      case 'discard': {
        if (this.phase !== 'skill_discard') throw new Error('当前不需要弃技能牌。');
        const excess = this.excess(player);
        if (!excess) throw new Error('你的技能牌没有超出上限。');
        if (!Array.isArray(action.skillIds) || action.skillIds.length !== excess || new Set(action.skillIds).size !== excess || action.skillIds.some(skillId => !player.skills.some(skill => skill.id === skillId))) throw new Error(`请选择${excess}张技能牌弃掉。`);
        const discarded = new Set(action.skillIds); player.skills = player.skills.filter(skill => !discarded.has(skill.id));
        this.log(`${player.name} 弃掉了${excess}张技能牌。`);
        if (this.players.every(p => this.excess(p) === 0)) {
          if (this.advanceAfterDiscard) { this.advanceAfterDiscard = false; this.advanceSkills(); }
          else this.timed('skill_use');
        }
        break;
      }
      case 'skill': this.skill(player, action); break;
      case 'skillEnd':
        if (this.phase !== 'skill_use' || this.skillOrder[this.skillIndex] !== id) throw new Error('还没轮到你的技能阶段。');
        this.log(`${player.name} 保留剩余技能，结束操作。`); this.advanceSkills(); break;
      case 'restart':
        if (id !== this.hostId || this.phase !== 'finished') throw new Error('牌局结束后，由房主开启下一局。');
        this.reset(); this.log('新一局已准备，请三位重新准备。'); break;
      default: throw new Error('不支持的操作。');
    }
    this.version++;
  }

  tick(now = this.clock()): void {
    if (this.paused || this.deadline === null || now < this.deadline) return;
    if (this.phase === 'bidding' && this.turnId) this.act(this.turnId, { type: 'bid', value: 0 });
    else if (this.phase === 'playing' && this.turnId) {
      if (this.currentPlay) this.act(this.turnId, { type: 'pass' });
      else {
        const player = this.getPlayer(this.turnId);
        const card = sortCards(player.hand)[0];
        this.act(player.id, { type: 'play', cardIds: [card.id], ...(card.wild ? { wildAs: { [card.id]: 3 } } : {}) });
      }
    } else if (this.phase === 'skill_discard') {
      const ids = this.players.filter(p => this.excess(p) > 0).map(p => p.id);
      for (const id of ids) {
        const p = this.getPlayer(id); this.act(id, { type: 'discard', skillIds: p.skills.slice(-this.excess(p)).map(skill => skill.id) });
      }
    } else if (this.phase === 'skill_use') {
      const actor = this.skillOrder[this.skillIndex]; if (actor) this.act(actor, { type: 'skillEnd' });
    }
  }

  view(id: string): GameView {
    const self = this.getPlayer(id);
    const actorId = this.phase === 'skill_use' ? this.skillOrder[this.skillIndex] ?? null : null;
    return structuredClone({
      code: this.code, selfId: id, hostId: this.hostId, phase: this.phase,
      players: this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, ready: p.ready, cardCount: p.hand.length, skillCount: p.skills.length, role: this.landlordId ? p.id === this.landlordId ? 'landlord' as const : 'farmer' as const : null, bid: p.bid })),
      hand: self.hand, skills: self.skills, turnId: this.turnId, landlordId: this.landlordId,
      direction: this.direction, bottom: this.landlordId ? this.bottom : [], currentPlay: this.currentPlay,
      lastActorId: this.lastActorId, passCount: this.passCount, trick: this.trick, multiplier: this.multiplier, bidMax: this.bidMax,
      skillActorId: actorId, skillOrder: this.skillOrder, skillUsed: actorId ? this.skillUses[actorId] ?? 0 : 0,
      skillBudget: actorId ? this.skillBudgets[actorId] ?? 0 : 0,
      mustDiscard: this.excess(self), logs: this.logs, privatePeek: self.peek,
      winner: this.winner, winnerId: this.winnerId, deadline: this.deadline, paused: this.paused, version: this.version,
    });
  }
}
