import type { Card, Combination } from './types.ts';
import { sortCards } from './cards.ts';

const LABELS: Record<string, string> = {
  single: '单张', pair: '对子', triple: '三张', bomb: '炸弹', rocket: '王炸',
  triple_single: '三带一', triple_pair: '三带二', straight: '顺子', pair_straight: '连对',
  plane: '飞机', plane_single: '飞机带单', plane_pair: '飞机带对', four_two: '四带二', four_pairs: '四带两对',
};
function combination(type: string, rank: number, size: number, length = 1): Combination {
  return { type, rank, size, length, label: LABELS[type] };
}

/** Reject unknown declarations as well as duplicates before comparing any ranks. */
function effectiveRanks(cards: Card[], wildAs: Record<string, number> = {}): number[] | null {
  if (!cards.length || new Set(cards.map(c => c.id)).size !== cards.length) return null;
  const wildIds = new Set(cards.filter(c => c.wild).map(c => c.id));
  if (Object.keys(wildAs).some(id => !wildIds.has(id))) return null;
  const ranks: number[] = [];
  for (const card of cards) {
    if (card.wild) {
      const rank = wildAs[card.id] ?? 3;
      if (!Number.isInteger(rank) || rank < 3 || rank > 14 || (cards.length === 1 && rank !== 3)) return null;
      ranks.push(rank);
    } else {
      if (!Number.isInteger(card.rank) || card.rank < 3 || card.rank > 17) return null;
      ranks.push(card.rank);
    }
  }
  return ranks.sort((a, b) => a - b);
}

/** All legal readings are retained because an airplane may have multiple bodies. */
export function classifyAll(cards: Card[], wildAs: Record<string, number> = {}): Combination[] {
  const ranks = effectiveRanks(cards, wildAs);
  if (!ranks) return [];
  const n = ranks.length;
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  const keys = [...counts.keys()];
  const hasWild = cards.some(c => c.wild);
  const result: Combination[] = [];
  const push = (type: string, rank: number, length = 1) => result.push(combination(type, rank, n, length));
  const consecutive = keys.every((rank, i) => i === 0 || rank === keys[i - 1] + 1);

  if (n === 1) push('single', ranks[0]);
  if (n === 2 && ranks[0] === 16 && ranks[1] === 17 && !hasWild) push('rocket', 17);
  if (keys.length === 1 && ranks[0] <= 15) {
    if (n === 2) push('pair', ranks[0]);
    if (n === 3) push('triple', ranks[0]);
    if (n === 4 && (!hasWild || cards.some(card => !card.wild))) {
      result.push({ ...combination('bomb', ranks[0], n), ...(hasWild ? { bombKind: 'soft' as const, label: '软炸弹' } : {}) });
    }
  }
  if (n === 4 && keys.length === 2) {
    const core = keys.find(rank => counts.get(rank) === 3 && rank <= 15);
    if (core !== undefined) push('triple_single', core);
  }
  if (n === 5 && keys.length === 2) {
    const core = keys.find(rank => counts.get(rank) === 3 && rank <= 15);
    const wing = keys.find(rank => counts.get(rank) === 2 && rank <= 15);
    if (core !== undefined && wing !== undefined) push('triple_pair', core);
  }
  if (keys[keys.length - 1] <= 14 && consecutive) {
    if (n >= 5 && keys.length === n) push('straight', keys[keys.length - 1], keys.length);
    if (keys.length >= 3 && n === keys.length * 2 && keys.every(rank => counts.get(rank) === 2)) push('pair_straight', keys[keys.length - 1], keys.length);
    if (keys.length >= 2 && n === keys.length * 3 && keys.every(rank => counts.get(rank) === 3)) push('plane', keys[keys.length - 1], keys.length);
  }
  // Body ranks must have exactly three selected cards. A fourth card of that
  // rank cannot double as a wing; the player can instead leave it in their hand.
  for (const [type, unit] of [['plane_single', 4], ['plane_pair', 5]] as const) {
    if (n % unit !== 0 || n / unit < 2 || n / unit > 12) continue;
    const length = n / unit;
    for (let start = 3; start + length - 1 <= 14; start++) {
      const body = Array.from({ length }, (_, i) => start + i);
      if (!body.every(rank => counts.get(rank) === 3)) continue;
      const wings = keys.filter(rank => !body.includes(rank));
      if (type === 'plane_single') {
        if (wings.reduce((sum, rank) => sum + counts.get(rank)!, 0) === length) push(type, start + length - 1, length);
      } else if (wings.length === length && wings.every(rank => rank <= 15 && counts.get(rank) === 2)) {
        push(type, start + length - 1, length);
      }
    }
  }
  if (n === 6 || n === 8) {
    for (const core of keys.filter(rank => rank <= 15 && counts.get(rank) === 4)) {
      const wings = keys.filter(rank => rank !== core);
      // Adding wings makes this an ordinary combination, even with wildcards.
      if (n === 6 && wings.reduce((sum, rank) => sum + counts.get(rank)!, 0) === 2) push('four_two', core);
      if (n === 8 && wings.length === 2 && wings.every(rank => rank <= 15 && counts.get(rank) === 2)) push('four_pairs', core);
    }
  }
  return result;
}

export function classify(cards: Card[], wildAs: Record<string, number> = {}): Combination | null {
  return classifyAll(cards, wildAs)[0] ?? null;
}

export function beats(next: Combination, previous: Combination | null): boolean {
  if (!previous) return true;
  if (previous.type === 'rocket') return false;
  if (next.type === 'rocket') return true;
  if (next.type === 'bomb') {
    if (previous.type !== 'bomb') return true;
    const nextSoft = next.bombKind === 'soft', previousSoft = previous.bombKind === 'soft';
    if (nextSoft !== previousSoft) return !nextSoft;
    return next.rank > previous.rank;
  }
  if (previous.type === 'bomb') return false;
  return next.type === previous.type && next.size === previous.size && next.length === previous.length && next.rank > previous.rank;
}

/** Match the previous shape before falling back to a bomb/rocket. */
export function classifyAgainst(cards: Card[], previous: Combination | null, wildAs: Record<string, number> = {}): Combination | null {
  const choices = classifyAll(cards, wildAs);
  return choices.find(next => beats(next, previous)) ?? null;
}

export interface WildPlayOption {
  combination: Combination;
  wildAs: Record<string, number>;
  /** Sorted point values for the entire selected play, after substitutions. */
  effectiveRanks: number[];
}

/**
 * Resolve a selected physical hand before asking the player to choose a shape.
 * Wildcard identity does not affect strength, so assignments are nondecreasing
 * over sorted wildcard IDs. Three wildcards require only C(14, 3) = 364
 * assignments instead of all 12^3 identity permutations.
 */
export function resolveWildPlays(cards: Card[], previous: Combination | null): WildPlayOption[] {
  if (!cards.length || new Set(cards.map(card => card.id)).size !== cards.length) return [];
  const wildcards = cards.filter(card => card.wild).sort((a, b) => a.id.localeCompare(b.id));
  if (wildcards.length > 3) return [];
  const options: WildPlayOption[] = [];
  const seen = new Set<string>();
  const declarations: Record<string, number> = {};
  const collect = () => {
    const ranks = effectiveRanks(cards, declarations);
    if (!ranks) return;
    // The wire protocol sends substitutions, not an explicit shape. Retain the
    // same reading the server will choose for this declaration, rather than
    // presenting another airplane interpretation it cannot select explicitly.
    const candidate = classifyAgainst(cards, previous, declarations);
    if (!candidate) return;
    const key = `${candidate.type}:${candidate.rank}:${candidate.length}:${candidate.size}:${ranks.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({ combination: candidate, wildAs: { ...declarations }, effectiveRanks: ranks });
  };
  const assign = (index: number, minimum: number): void => {
    if (index === wildcards.length) { collect(); return; }
    for (let rank = minimum; rank <= 14; rank++) {
      declarations[wildcards[index].id] = rank;
      assign(index + 1, rank);
    }
  };
  if (cards.length === 1 && wildcards.length === 1) {
    declarations[wildcards[0].id] = 3;
    collect();
  } else assign(0, 3);
  return options;
}

interface Selection { cards: Card[]; wildAs: Record<string, number> }

/**
 * Construct rank patterns rather than enumerating every physical subset.
 * Generated duplicates and multiple wildcards therefore remain tractable.
 */
export function findHint(hand: Card[], previous: Combination | null): { cardIds: string[]; wildAs?: Record<string, number> } | null {
  const sorted = sortCards(hand);
  if (!sorted.length) return null;
  let attempts = 0;
  const maxAttempts = 12000;
  const natural = new Map<number, Card[]>();
  const wild = sorted.filter(c => c.wild);
  for (const card of sorted.filter(c => !c.wild)) natural.set(card.rank, [...(natural.get(card.rank) ?? []), card]);
  const finish = (selection: Selection) => {
    const found = classifyAgainst(selection.cards, previous, selection.wildAs);
    return found ? { cardIds: selection.cards.map(c => c.id), ...(Object.keys(selection.wildAs).length ? { wildAs: selection.wildAs } : {}) } : null;
  };
  // Finishing the entire hand has priority, including the unambiguous all-natural
  // case. Wildcard combinations are explored by the patterns below.
  const all = finish({ cards: sorted, wildAs: {} });
  if (all) return all;
  function take(selection: Selection, rank: number, count: number, allowWild = true): Selection | null {
    const used = new Set(selection.cards.map(c => c.id));
    const cards = (natural.get(rank) ?? []).filter(c => !used.has(c.id)).slice(0, count);
    const missing = count - cards.length;
    if (missing) {
      if (!allowWild || rank < 3 || rank > 14) return null;
      const available = wild.filter(c => !used.has(c.id));
      if (available.length < missing) return null;
      cards.push(...available.slice(0, missing));
    }
    const wildAs = { ...selection.wildAs };
    for (const card of cards) if (card.wild) wildAs[card.id] = rank;
    return { cards: [...selection.cards, ...cards], wildAs };
  }
  function pattern(core: number[], count: number, wings = 0, wingSize = 1, allowWild = true): ReturnType<typeof finish> {
    let selection: Selection = { cards: [], wildAs: {} };
    for (const rank of core) {
      const next = take(selection, rank, count, allowWild);
      if (!next) return null;
      selection = next;
    }
    if (!wings) return finish(selection);
    const visit = (current: Selection, left: number, from: number): ReturnType<typeof finish> => {
      if (++attempts > maxAttempts) return null;
      if (!left) return finish(current);
      for (let rank = from; rank <= (wingSize === 2 ? 15 : 17); rank++) {
        if (core.includes(rank)) continue;
        const next = take(current, rank, wingSize);
        if (!next) continue;
        const found = visit(next, left - 1, wingSize === 2 ? rank + 1 : rank);
        if (found) return found;
      }
      return null;
    };
    return visit(selection, wings, 3);
  }
  const types = previous ? [previous.type] : ['straight', 'pair_straight', 'plane', 'triple_pair', 'triple_single', 'triple', 'pair', 'single'];
  for (const type of types) {
    if (['bomb', 'rocket'].includes(type)) continue;
    const minRank = previous ? previous.rank + 1 : 3;
    if (['single', 'pair', 'triple', 'triple_single', 'triple_pair', 'four_two', 'four_pairs'].includes(type)) {
      const count = type === 'single' ? 1 : type === 'pair' ? 2 : type.startsWith('four') ? 4 : 3;
      for (let rank = minRank; rank <= (type === 'single' ? 17 : 15); rank++) {
        const wings = type === 'triple_single' || type === 'triple_pair' ? 1 : type.startsWith('four') ? 2 : 0;
        const wingSize = type === 'triple_pair' || type === 'four_pairs' ? 2 : 1;
        const found = pattern([rank], count, wings, wingSize);
        if (found) return found;
      }
    } else if (['straight', 'pair_straight', 'plane', 'plane_single', 'plane_pair'].includes(type)) {
      const minimum = type === 'straight' ? 5 : type === 'pair_straight' ? 3 : 2;
      const lengths = previous ? [previous.length] : Array.from({ length: 13 - minimum }, (_, i) => 12 - i);
      const count = type === 'straight' ? 1 : type === 'pair_straight' ? 2 : 3;
      for (const length of lengths) {
        if (length * count > hand.length) continue;
        for (let last = Math.max(minRank, 3 + length - 1); last <= 14; last++) {
          const core = Array.from({ length }, (_, i) => last - length + 1 + i);
          const wings = type === 'plane_single' || type === 'plane_pair' ? length : 0;
          const found = pattern(core, count, wings, type === 'plane_pair' ? 2 : 1);
          if (found) return found;
        }
      }
    }
  }
  // A lower hard bomb beats any soft bomb; let beats() check the hierarchy.
  // Prefer a soft bomb over spending a hard bomb when an ordinary reply fails.
  for (const allowWild of [true, false]) {
    for (let rank = 3; rank <= 15; rank++) {
      const naturals = natural.get(rank)?.length ?? 0;
      if (allowWild && (naturals === 0 || naturals >= 4)) continue;
      const found = pattern([rank], 4, 0, 1, allowWild);
      if (found) return found;
    }
  }
  const small = natural.get(16)?.[0];
  const big = natural.get(17)?.[0];
  return small && big ? finish({ cards: [small, big], wildAs: {} }) : null;
}
