import type { Card } from './types.ts';

/** Physical identity is separate from rank: generated cards may repeat a suit/rank. */
export function makeDeck(): Card[] {
  const cards: Card[] = [];
  for (const suit of ['S', 'H', 'C', 'D'] as const) {
    for (let rank = 3; rank <= 15; rank++) cards.push({ id: `${suit}${rank}`, rank, suit });
  }
  cards.push({ id: 'J16', rank: 16, suit: 'J' }, { id: 'J17', rank: 17, suit: 'J' });
  return cards;
}

export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => (a.wild ? 18 : a.rank) - (b.wild ? 18 : b.rank)
    || a.suit.localeCompare(b.suit) || a.id.localeCompare(b.id));
}

export function rankLabel(rank: number): string {
  return ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' } as Record<number, string>)[rank] ?? String(rank);
}

export function suitLabel(suit: Card['suit']): string {
  return ({ S: '♠', H: '♥', C: '♣', D: '♦', J: '★', W: '✦' } as const)[suit];
}
