import { randomInt } from 'node:crypto';
import { findHint } from '../src/shared/rules.ts';
import { getSkill } from '../src/shared/skills.ts';
import type { Game } from '../src/shared/game.ts';

export function readyBots(game: Game): void {
  if (game.phase !== 'lobby') return;
  for (const bot of game.players.filter(player => player.id.startsWith('bot-'))) game.act(bot.id, { type: 'ready', ready: true });
}

/** Bot choices use the same private view as a human client, with no access to opponents' cards. */
export function runBotTurn(game: Game, id: string): void {
  if (!id.startsWith('bot-')) return;
  const view = game.view(id);
  if (view.paused) return;
  if (view.phase === 'bidding') {
    game.act(id, { type: 'bid', value: view.bidMax === 0 ? 1 : 0 });
  } else if (view.phase === 'playing') {
    const hint = findHint(view.hand, view.currentPlay?.combination ?? null);
    const self = view.players.find(player => player.id === id)!;
    const last = view.players.find(player => player.id === view.currentPlay?.playerId);
    const yieldToFriend = self.role === 'farmer' && last?.role === 'farmer'
      && hint?.cardIds.length !== view.hand.length && (last.cardCount <= 5 || randomInt(100) < 65);
    game.act(id, hint && !yieldToFriend ? { type: 'play', ...hint } : { type: 'pass' });
  } else if (view.phase === 'skill_discard') {
    game.act(id, { type: 'discard', skillIds: view.skills.slice(0, view.mustDiscard).map(skill => skill.id) });
  } else if (view.phase === 'skill_use') {
    const self = view.players.find(player => player.id === id)!;
    const others = view.players.filter(player => player.id !== id).sort((a, b) => {
      const enemyA = a.role !== self.role ? 1 : 0;
      const enemyB = b.role !== self.role ? 1 : 0;
      return enemyB - enemyA || a.cardCount - b.cardCount;
    });
    const giftCards = view.hand.slice().sort((a, b) => Number(!!a.wild) - Number(!!b.wild) || a.rank - b.rank);
    const priorities: Record<string, number> = { addTwo: 10, trade: 9, three: 8, wild: 7, steal: 6, mutual: 5, reverse: 4, peek: 3, shuffle: 2, gift: 1, identity: 0 };
    const skills = view.skills.slice().sort((a, b) => priorities[b.kind] - priorities[a.kind]);
    for (const skill of skills) {
      const definition = getSkill(skill.kind);
      if (skill.kind === 'wild' && view.hand.some(card => card.wild)) continue;
      if (skill.kind === 'gift' && view.hand.length < 2) continue;
      if (skill.kind === 'trade' && view.hand.length < 2) continue;
      const targets = definition.target ? others : [undefined];
      for (const target of targets) {
        if (skill.kind === 'steal' && target!.cardCount < 2) continue;
        if (skill.kind === 'identity' && target!.role === self.role) continue;
        try {
          game.act(id, { type: 'skill', skillId: skill.id, ...(target ? { targetId: target.id } : {}), ...(definition.select ? { cardIds: giftCards.slice(0, definition.select).map(card => card.id) } : {}) });
          return;
        } catch { /* An expired global skill or illegal target can be replaced by another card. */ }
      }
    }
    game.act(id, { type: 'skillEnd' });
  }
}
