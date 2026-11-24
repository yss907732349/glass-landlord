export interface Card { id: string; rank: number; suit: 'S' | 'H' | 'C' | 'D' | 'J' | 'W'; wild?: boolean; generated?: boolean }
export type SkillKind = 'steal' | 'gift' | 'peek' | 'wild' | 'three' | 'trade' | 'shuffle' | 'mutual' | 'identity' | 'addTwo' | 'reverse';
export interface SkillCard { id: string; kind: SkillKind }
export interface SkillDefinition { kind: SkillKind; name: string; description: string; weight: number; target: boolean; select: number; tone: 'normal' | 'rare' | 'epic' }
export type Phase = 'lobby' | 'bidding' | 'playing' | 'skill_discard' | 'skill_use' | 'finished';
export interface PlayerView { id: string; name: string; connected: boolean; ready: boolean; cardCount: number; skillCount: number; role: 'landlord' | 'farmer' | null; bid: number | null }
export interface Combination { type: string; rank: number; length: number; size: number; label: string }
export interface PlayedCards { playerId: string; cards: Card[]; combination: Combination; wildAs?: Record<string, number> }
export interface GameView {
  code: string; selfId: string; hostId: string; phase: Phase; players: PlayerView[];
  hand: Card[]; skills: SkillCard[]; turnId: string | null; landlordId: string | null;
  direction: 1 | -1; bottom: Card[]; currentPlay: PlayedCards | null; lastActorId: string | null;
  passCount: number; trick: number; multiplier: number; bidMax: number;
  skillActorId: string | null; skillOrder: string[]; skillUsed: number; skillBudget: number;
  mustDiscard: number; logs: string[]; privatePeek: Card[];
  winner: 'landlord' | 'farmers' | null; winnerId: string | null;
  deadline: number | null; paused: boolean; version: number;
}
export type GameAction =
  | { type: 'fillBots' }
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'bid'; value: number }
  | { type: 'play'; cardIds: string[]; wildAs?: Record<string, number> }
  | { type: 'pass' }
  | { type: 'discard'; skillIds: string[] }
  | { type: 'skill'; skillId: string; targetId?: string; cardIds?: string[] }
  | { type: 'skillEnd' }
  | { type: 'restart' };
export type ClientMessage =
  | { type: 'create'; name: string; password: string }
  | { type: 'join'; code: string; name: string; password: string }
  | { type: 'resume'; code: string; token: string }
  | { type: 'action'; action: GameAction }
  | { type: 'ping'; at: number }
  | { type: 'leave' };
export type ServerMessage =
  | { type: 'joined'; code: string; token: string; playerId: string }
  | { type: 'state'; state: GameView }
  | { type: 'error'; message: string }
  | { type: 'pong'; at: number }
  | { type: 'closed'; message: string };
