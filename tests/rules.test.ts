import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, rankLabel, sortCards, suitLabel } from '../src/shared/cards.ts';
import { beats, classify, classifyAgainst, classifyAll, findHint, resolveWildPlays } from '../src/shared/rules.ts';
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

test('wildcard declarations support 3 through 2 in combinations but never a single or a rocket', () => {
  const w = wild();
  assert.equal(classify([w]), null);
  assert.equal(classify([w], { [w.id]: 3 }), null);
  assert.equal(classify([w], { [w.id]: 15 }), null);
  assert.equal(classify([w], { [w.id]: 4 }), null);
  assert.equal(classify([...cards([14]), w], { [w.id]: 14 })?.type, 'pair');
  assert.equal(classify([...cards([15]), w], { [w.id]: 15 })?.type, 'pair');
  assert.equal(classify([...cards([16]), w], { [w.id]: 17 }), null);
  assert.equal(classify([...cards([7, 7, 7]), w], { [w.id]: 7 })?.bombKind, 'soft');
  assert.equal(classify([...cards([3, 4, 6, 7]), w], { [w.id]: 5 })?.type, 'straight');
  assert.equal(classify([...cards([9]), w], { [w.id]: 9.5 }), null);
  assert.equal(classify(cards([3]), { fake: 3 }), null);
  assert.equal(classify(cards([3]), {})?.type, 'single');
});

test('three matching cards plus a wildcard form a soft bomb, including multiple wildcard transfers', () => {
  for (let rank = 3; rank <= 15; rank++) {
    for (let count = 1; count <= 3; count++) {
      const wilds = Array.from({ length: count }, wild);
      const selected = [...cards(Array(4 - count).fill(rank)), ...wilds];
      const declarations = Object.fromEntries(wilds.map(card => [card.id, rank]));
      const result = classify(selected, declarations);
      assert.equal(result?.type, 'bomb'); assert.equal(result?.bombKind, 'soft');
      assert.equal(result?.label, '软炸弹'); assert.equal(result?.rank, rank);
      assert.ok(resolveWildPlays(selected, null).some(option => option.combination.bombKind === 'soft' && option.combination.rank === rank));
    }
  }
  const wilds = Array.from({ length: 4 }, wild);
  assert.equal(classify(wilds, Object.fromEntries(wilds.map(card => [card.id, 7]))), null);
  const w = wild();
  assert.equal(classify([...cards([15, 15, 15]), w], { [w.id]: 15 })?.bombKind, 'soft');
  assert.equal(classify([...cards([7, 7, 7, 7]), w], { [w.id]: 7 }), null);
});

test('bomb comparison ranks rocket above hard bombs above soft bombs, then compares rank within each kind', () => {
  const soft = (rank: number) => {
    const w = wild(); return classify([...cards([rank, rank, rank]), w], { [w.id]: rank })!;
  };
  const low = soft(3), high = soft(14), hard = shape([3, 3, 3, 3]);
  assert.ok(low && high);
  assert.equal(beats(low, shape([15])), true);
  assert.equal(beats(high, low), true); assert.equal(beats(low, high), false);
  assert.equal(beats(hard, high), true); assert.equal(beats(high, hard), false);
  assert.equal(beats(soft(7), soft(7)), false);
  assert.equal(beats(shape([16, 17]), high), true); assert.equal(beats(high, shape([16, 17])), false);
});

test('automatic choices and hints find soft bombs and lower hard bombs that beat a high soft bomb', () => {
  const w = wild(), hand = [...cards([7, 7, 7]), w, ...cards([3])];
  const options = resolveWildPlays(hand.slice(0, 4), shape([15]));
  assert.equal(options.length, 1); assert.equal(options[0].combination.bombKind, 'soft');
  assert.equal(options[0].wildAs[w.id], 7);
  const hint = findHint(hand, shape([15])); assert.ok(hint);
  assert.equal(classifyAgainst(hand.filter(card => hint.cardIds.includes(card.id)), shape([15]), hint.wildAs)?.bombKind, 'soft');
  const hardHand = cards([3, 3, 3, 3, 4]);
  const previous = options[0].combination;
  const hardHint = findHint(hardHand, previous); assert.ok(hardHint);
  assert.equal(classifyAgainst(hardHand.filter(card => hardHint.cardIds.includes(card.id)), previous, hardHint.wildAs)?.rank, 3);
  assert.equal(findHint(hand, shape([3, 3, 3, 3])), null);
});

test('wildcards can form twos in ordinary groups and soft bombs while sequence bodies still stop at ace', () => {
  const w = wild();
  assert.equal(classify([...cards([15, 15]), w], { [w.id]: 15 })?.type, 'triple');
  assert.equal(classify([...cards([15, 15, 7]), w], { [w.id]: 15 })?.type, 'triple_single');
  assert.equal(classify([...cards([7, 7, 7, 15]), w], { [w.id]: 15 })?.type, 'triple_pair');
  assert.equal(classify([...cards([11, 12, 13, 14]), w], { [w.id]: 15 }), null);
  assert.equal(classify([...cards([13, 13, 14, 14, 15]), w], { [w.id]: 15 }), null);
  assert.equal(classify([...cards([14, 14, 14, 15, 15]), w], { [w.id]: 15 }), null);
  const pairCards = [...cards([15]), w];
  const pair = resolveWildPlays(pairCards, shape([14, 14]));
  assert.equal(pair.length, 1); assert.equal(pair[0].combination.type, 'pair'); assert.equal(pair[0].wildAs[w.id], 15);
  const pairHint = findHint(pairCards, shape([14, 14])); assert.ok(pairHint);
  assert.equal(pairHint.wildAs?.[w.id], 15);
  const bombHand = [...cards([15, 15, 15, 4]), w];
  const previousWild = wild();
  const previous = classify([...cards([14, 14, 14]), previousWild], { [previousWild.id]: 14 })!;
  const bombHint = findHint(bombHand, previous); assert.ok(bombHint);
  assert.equal(bombHint.wildAs?.[w.id], 15);
  assert.equal(classifyAgainst(bombHand.filter(card => bombHint.cardIds.includes(card.id)), previous, bombHint.wildAs)?.rank, 15);
});

test('hints never offer a lone wildcard, including when it is the only card or a following single', () => {
  const w = wild();
  assert.equal(findHint([w], null), null); assert.equal(findHint([w], shape([3])), null);
  const hand = [...cards([15]), w];
  const hint = findHint(hand, shape([14])); assert.ok(hint);
  assert.equal(hint.cardIds.length, 1); assert.equal(hint.cardIds[0], hand[0].id);
  assert.equal(hint.wildAs, undefined);
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

test('automatic wildcard resolution returns a unique forced replacement and rejects single wildcards', () => {
  const w = wild();
  const unique = resolveWildPlays([...cards([3, 4, 6, 7]), w], null);
  assert.equal(unique.length, 1); assert.equal(unique[0].wildAs[w.id], 5);
  assert.equal(unique[0].combination.type, 'straight'); assert.deepEqual(unique[0].effectiveRanks, [3, 4, 5, 6, 7]);
  const single = resolveWildPlays([w], null);
  assert.deepEqual(single, []);
  assert.deepEqual(resolveWildPlays([w], shape([3])), []);
});

test('4567 plus wildcard offers both straight endpoints, filtering before prompting when following', () => {
  const w = wild(); const selection = [...cards([4, 5, 6, 7]), w];
  const choices = resolveWildPlays(selection, null);
  assert.equal(choices.length, 2);
  assert.deepEqual(choices.map(option => option.effectiveRanks), [[3, 4, 5, 6, 7], [4, 5, 6, 7, 8]]);
  const follows = resolveWildPlays(selection, shape([3, 4, 5, 6, 7]));
  assert.equal(follows.length, 1); assert.equal(follows[0].wildAs[w.id], 8);
  assert.deepEqual(resolveWildPlays(selection, shape([4, 5, 6, 7, 8])), []);
  assert.deepEqual(resolveWildPlays(selection, shape([3, 4, 5, 6, 7, 8])), []);
});

test('multiple wildcard identity permutations collapse but genuinely different wing values remain selectable', () => {
  const w1 = wild(); const w2 = wild();
  const selection = [...cards([3, 3]), w2, w1];
  const choices = resolveWildPlays(selection, null);
  assert.equal(choices.length, 13);
  assert.equal(choices.filter(option => option.combination.bombKind === 'soft').length, 1);
  assert.ok(choices.every(option => ['triple_single', 'bomb'].includes(option.combination.type) && option.combination.rank === 3));
  assert.deepEqual(choices.filter(option => option.combination.type === 'triple_single').map(option => option.effectiveRanks.at(-1)), Array.from({ length: 12 }, (_, i) => i + 4));
  const keys = choices.map(option => `${option.combination.type}:${option.effectiveRanks.join(',')}`);
  assert.equal(new Set(keys).size, keys.length);
  const wildcardIds = [w1.id, w2.id].sort((a, b) => a.localeCompare(b));
  assert.ok(choices.every(option => option.wildAs[wildcardIds[0]] <= option.wildAs[wildcardIds[1]]));
  assert.deepEqual(resolveWildPlays([...selection].reverse(), null), choices);
});

test('one selected group can resolve to different legal combination types, each remaining server-verifiable', () => {
  const w1 = wild(); const w2 = wild(); const selection = [...cards([3, 3, 4, 4]), w1, w2];
  const choices = resolveWildPlays(selection, null);
  assert.ok(choices.some(option => option.combination.type === 'pair_straight' && option.effectiveRanks.join(',') === '3,3,4,4,5,5'));
  assert.ok(choices.some(option => option.combination.type === 'four_two' && option.combination.rank === 3));
  assert.ok(choices.some(option => option.combination.type === 'four_two' && option.combination.rank === 4));
  for (const option of choices) assert.deepEqual(classifyAgainst(selection, null, option.wildAs), option.combination);
  const follows = resolveWildPlays(selection, shape([3, 3, 3, 3, 5, 6]));
  assert.ok(follows.length > 0); assert.ok(follows.every(option => option.combination.type === 'four_two' && option.combination.rank > 3));
});

test('automatic choices match the exact server interpretation when one declaration has ambiguous airplane shapes', () => {
  const w = wild(); const selection = [...cards([4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7]), w];
  const options = resolveWildPlays(selection, null);
  const asSeven = options.filter(option => option.wildAs[w.id] === 7);
  assert.equal(asSeven.length, 1); assert.equal(asSeven[0].combination.type, 'plane');
  const previous = shape([3, 3, 3, 4, 4, 4, 5, 5, 5, 8, 9, 10]);
  const follows = resolveWildPlays(selection, previous);
  assert.ok(follows.length > 0);
  for (const option of follows) assert.deepEqual(option.combination, classifyAgainst(selection, previous, option.wildAs));
  assert.equal(follows.find(option => option.wildAs[w.id] === 7)?.combination.type, 'plane_single');
});

test('automatic resolution preserves forbidden substitutions, bomb restrictions and invalid-input rejection', () => {
  const twoWild = wild();
  const pairTwo = resolveWildPlays([...cards([15]), twoWild], null);
  assert.equal(pairTwo.length, 1); assert.equal(pairTwo[0].combination.rank, 15); assert.equal(pairTwo[0].wildAs[twoWild.id], 15);
  assert.deepEqual(resolveWildPlays([...cards([16]), wild()], null), []);
  assert.deepEqual(resolveWildPlays([...cards([7, 7, 7]), wild()], shape([6, 6, 6, 6])), []);
  assert.deepEqual(resolveWildPlays([...cards([11, 12, 13, 14]), wild()], null).map(option => option.effectiveRanks), [[10, 11, 12, 13, 14]]);
  assert.deepEqual(resolveWildPlays([], null), []);
  const same = wild(); assert.deepEqual(resolveWildPlays([same, same], null), []);
  assert.deepEqual(resolveWildPlays([wild(), wild(), wild(), wild()], null), []);
  const natural = resolveWildPlays(cards([8, 8, 8, 8]), shape([7, 7, 7, 7]));
  assert.equal(natural.length, 1); assert.equal(natural[0].combination.type, 'bomb'); assert.deepEqual(natural[0].wildAs, {});
  assert.deepEqual(resolveWildPlays(cards([3, 4]), null), []);
});

test('three wildcard resolutions stay bounded and preserve every legal distinct rank multiset', () => {
  const selection = [wild(), wild(), wild()];
  const options = resolveWildPlays(selection, null);
  assert.equal(options.length, 13); assert.ok(options.every(option => option.combination.type === 'triple'));
  assert.deepEqual(options.map(option => option.combination.rank), Array.from({ length: 13 }, (_, i) => i + 3));
  const larger = [...cards([3, 3, 4, 4, 5, 6, 7]), ...selection];
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const result = resolveWildPlays(larger, null);
    for (const option of result) assert.ok(classifyAgainst(larger, null, option.wildAs));
  }
  assert.ok(performance.now() - start < 3000, '100 worst-supported wildcard resolutions should finish within three seconds');
});
