import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, rankLabel, sortCards, suitLabel } from '../src/shared/cards.ts';
import { beats, classify, classifyAgainst, classifyAll, findHint } from '../src/shared/rules.ts';
import type { Card, Combination } from '../src/shared/types.ts';

let sequence = 0;
function cards(ranks: number[]): Card[] {
  return ranks.map(rank => ({ id: `test-${sequence++}`, rank, suit: rank >= 16 ? 'J' : 'S' }));
}
function wild(): Card { return { id: `wild-${sequence++}`, rank: 3, suit: 'W', wild: true, generated: true }; }
function shape(ranks: number[]): Combination {
  const found = classify(cards(ranks));
  assert.ok(found, `Expected legal ranks: ${ranks}`);
  return found;
}

test('54 physical cards have distinct IDs; sorting does not mutate the caller', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 54);
  assert.equal(new Set(deck.map(c => c.id)).size, 54);
  for (let rank = 3; rank <= 15; rank++) assert.equal(deck.filter(c => c.rank === rank).length, 4);
  const hand = [deck[53], deck[0], wild()];
  const sorted = sortCards(hand);
  assert.equal(hand[0].rank, 17);
  assert.equal(sorted[0].rank, 3);
  assert.equal(sorted[2].wild, true);
  assert.equal(rankLabel(15), '2');
  assert.equal(suitLabel('H'), '♥');
});

test('all ordinary shapes are identified using their body rank', () => {
  const cases: [number[], string, number, number][] = [
    [[3], 'single', 3, 1], [[15, 15], 'pair', 15, 1], [[7, 7, 7], 'triple', 7, 1],
    [[4, 4, 4, 12], 'triple_single', 4, 1], [[8, 8, 8, 5, 5], 'triple_pair', 8, 1],
    [[10, 11, 12, 13, 14], 'straight', 14, 5], [[3, 3, 4, 4, 5, 5], 'pair_straight', 5, 3],
    [[6, 6, 6, 7, 7, 7], 'plane', 7, 2],
    [[3, 3, 3, 4, 4, 4, 9, 10], 'plane_single', 4, 2],
    [[3, 3, 3, 4, 4, 4, 9, 9], 'plane_single', 4, 2],
    [[7, 7, 7, 8, 8, 8, 3, 3, 15, 15], 'plane_pair', 8, 2],
    [[6, 6, 6, 6, 3, 3], 'four_two', 6, 1],
    [[6, 6, 6, 6, 3, 3, 15, 15], 'four_pairs', 6, 1],
    [[15, 15, 15, 15], 'bomb', 15, 1], [[16, 17], 'rocket', 17, 1],
  ];
  for (const [ranks, type, rank, length] of cases) {
    const actual = shape(ranks);
    assert.equal(actual.type, type, ranks.join(','));
    assert.equal(actual.rank, rank);
    assert.equal(actual.length, length);
    assert.equal(actual.size, ranks.length);
  }
});

test('invalid groups reject 2/king sequences, missing wings, oversized bombs and repeated IDs', () => {
  for (const ranks of [[], [3, 4], [3, 3, 4], [11, 12, 13, 14, 15], [14, 14, 15, 15, 16, 16],
    [14, 14, 14, 15, 15, 15], [3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3], [16, 16],
    [3, 3, 3, 4, 4, 4, 4, 5], [3, 3, 3, 3, 4, 4, 4, 4]]) {
    assert.equal(classify(cards(ranks)), null, ranks.join(','));
  }
  const same = cards([8])[0];
  assert.equal(classify([same, same]), null);
});

test('comparison requires the same body length, while bombs and rockets override ordinary types', () => {
  assert.equal(beats(shape([4]), shape([3])), true);
  assert.equal(beats(shape([4, 4]), shape([3])), false);
  assert.equal(beats(shape([3, 4, 5, 6, 7, 8]), shape([3, 4, 5, 6, 7])), false);
  assert.equal(beats(shape([4, 4, 4, 3]), shape([3, 3, 3, 17])), true);
  assert.equal(beats(shape([3, 3, 3, 3]), shape([17])), true);
  assert.equal(beats(shape([4, 4, 4, 4]), shape([3, 3, 3, 3])), true);
  assert.equal(beats(shape([16, 17]), shape([15, 15, 15, 15])), true);
  assert.equal(beats(shape([15, 15, 15, 15]), shape([16, 17])), false);
  assert.equal(beats(shape([16, 17]), shape([16, 17])), false);
});

test('wildcard declarations support 3 to A, single 3, and never a bomb or rocket', () => {
  const w = wild();
  assert.equal(classify([w])?.rank, 3);
  assert.equal(classify([w], { [w.id]: 4 }), null);
  assert.equal(classify([...cards([14]), w], { [w.id]: 14 })?.type, 'pair');
  assert.equal(classify([...cards([15]), w], { [w.id]: 15 }), null);
  assert.equal(classify([...cards([16]), w], { [w.id]: 17 }), null);
  assert.equal(classify([...cards([7, 7, 7]), w], { [w.id]: 7 }), null);
  assert.equal(classify([...cards([3, 4, 6, 7]), w], { [w.id]: 5 })?.type, 'straight');
  assert.equal(classify([...cards([9]), w], { [w.id]: 9.5 }), null);
  assert.equal(classify(cards([3]), { fake: 3 }), null);
  assert.equal(classify(cards([3]), {})?.type, 'single');
});

test('multiple wildcards work in ordinary combinations including four-with-wings', () => {
  const w1 = wild(); const w2 = wild();
  const trio = classify([...cards([10]), w1, w2], { [w1.id]: 10, [w2.id]: 10 });
  assert.equal(trio?.type, 'triple');
  assert.equal(classify([...cards([7, 7, 7, 3, 4]), w1], { [w1.id]: 7 })?.type, 'four_two');
});

test('ambiguous airplane bodies select a legal response instead of rejecting a valid play', () => {
  const hand = cards([4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 7]);
  const previous = shape([3, 3, 3, 4, 4, 4, 5, 5, 5, 8, 9, 10]);
  assert.equal(previous.type, 'plane_single');
  assert.equal(classify(hand)?.type, 'plane');
  assert.ok(classifyAll(hand).some(c => c.type === 'plane_single'));
  assert.equal(classifyAgainst(hand, previous)?.type, 'plane_single');
});

test('hints respond to all standard shapes and prefer ordinary responses before bombs', () => {
  const examples: [number[], number[]][] = [
    [[3], [4, 5]], [[3, 3], [4, 4, 9]], [[3, 3, 3], [4, 4, 4, 9]],
    [[3, 3, 3, 9], [4, 4, 4, 5, 10]], [[3, 3, 3, 9, 9], [4, 4, 4, 5, 5, 10]],
    [[3, 4, 5, 6, 7], [4, 5, 6, 7, 8, 13]],
    [[3, 3, 4, 4, 5, 5], [4, 4, 5, 5, 6, 6, 15]],
    [[3, 3, 3, 4, 4, 4], [4, 4, 4, 5, 5, 5, 15]],
    [[3, 3, 3, 4, 4, 4, 8, 9], [4, 4, 4, 5, 5, 5, 7, 7, 15]],
    [[3, 3, 3, 4, 4, 4, 8, 8, 9, 9], [4, 4, 4, 5, 5, 5, 7, 7, 10, 10, 15]],
    [[3, 3, 3, 3, 8, 9], [4, 4, 4, 4, 7, 7, 15]],
    [[3, 3, 3, 3, 8, 8, 9, 9], [4, 4, 4, 4, 7, 7, 10, 10, 15]],
  ];
  for (const [before, available] of examples) {
    const previous = shape(before);
    const hand = cards(available);
    const hint = findHint(hand, previous);
    assert.ok(hint, `${previous.type} should have a response`);
    const selected = hand.filter(c => hint.cardIds.includes(c.id));
    assert.ok(classifyAgainst(selected, previous, hint.wildAs));
  }
  const hand = cards([4, 3, 3, 3, 3]);
  const hint = findHint(hand, shape([3]));
  assert.equal(hint?.cardIds.length, 1);
});

test('hints use declared wildcard replacements and extract four cards from extra duplicates', () => {
  const w = wild();
  const hand = [...cards([7]), w];
  const previous = shape([6, 6]);
  const hint = findHint(hand, previous);
  assert.ok(hint);
  assert.equal(hint.wildAs?.[w.id], 7);
  assert.ok(classifyAgainst(hand.filter(c => hint.cardIds.includes(c.id)), previous, hint.wildAs));
  const extra = cards([8, 8, 8, 8, 8, 3]);
  const bombHint = findHint(extra, shape([7, 7, 7, 7]));
  assert.equal(bombHint?.cardIds.length, 4);
  assert.equal(findHint(cards([3, 4]), shape([17])), null);
  assert.equal(findHint(cards([16, 17]), shape([15, 15, 15, 15]))?.cardIds.length, 2);
});

test('deterministic randomized hands never produce illegal or non-owned hints', () => {
  let state = 1947;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const previous = [null, shape([9]), shape([8, 8]), shape([7, 7, 7, 6]), shape([3, 4, 5, 6, 7]), shape([5, 5, 5, 5])];
  for (let i = 0; i < 150; i++) {
    const deck = makeDeck();
    for (let j = deck.length - 1; j > 0; j--) {
      const k = Math.floor(random() * (j + 1)); [deck[j], deck[k]] = [deck[k], deck[j]];
    }
    const hand = [...deck.slice(0, 20), ...(i % 3 === 0 ? [wild()] : [])];
    const before = previous[i % previous.length];
    const hint = findHint(hand, before);
    if (!hint) continue;
    assert.equal(new Set(hint.cardIds).size, hint.cardIds.length);
    assert.ok(hint.cardIds.every(id => hand.some(c => c.id === id)));
    const selected = hand.filter(c => hint.cardIds.includes(c.id));
    assert.ok(classifyAgainst(selected, before, hint.wildAs));
  }
});
