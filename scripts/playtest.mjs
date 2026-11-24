import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../server/index.ts';

const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createGameServer({ port: 0, host: '127.0.0.1' });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const errors = [];
const checks = [];
const bounds = [];
const contexts = [];
const pages = [];
const url = `http://127.0.0.1:${server.port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const view = page => page.evaluate(() => window.__roomView);
async function waitVersion(page, old) { await page.waitForFunction(version => window.__roomView?.version > version, old); }
async function clickAction(page, locator, options) {
  const old = (await view(page))?.version ?? -1;
  await locator.click(options);
  await waitVersion(page, old);
}
async function screen(page, name) { await page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true }); }
async function recordBounds(page, label) {
  bounds.push({ label, ...(await page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const selectors = ['.table-shell', '.own-hand', '.skill-row', '.skill-phase-buttons', '.modal', '.room-panel'];
    return { viewport, boxes: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
      const r = element.getBoundingClientRect();
      return { selector, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    })) };
  })) });
}
async function cardClick(page, index) {
  await page.locator('.own-hand .playing-card').nth(index).click({ position: { x: 5, y: 65 } });
}
try {
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    contexts.push(context);
    await context.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.__messages = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          window.__testSocket = this;
          this.addEventListener('message', event => {
            try {
              const message = JSON.parse(event.data);
              window.__messages.push(message);
              if (message.type === 'state') window.__roomView = message.state;
            } catch {}
          });
        }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ player: i, message: error.message }));
    page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push({ player: i, message: message.text() }); });
    pages.push(page);
    await page.goto(url);
    await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  }
  await screen(pages[0], 'lobby-1366x768.png');
  await recordBounds(pages[0], 'welcome-wide');
  await pages[0].locator('input[name=nickname]').fill('阿和');
  await pages[0].locator('input[name=password]').fill('friends-2026');
  await pages[0].getByRole('button', { name: '开一桌', exact: true }).click();
  await pages[0].waitForFunction(() => window.__roomView?.phase === 'lobby');
  const code = (await view(pages[0])).code;
  checks.push('created password room');
  for (let i = 1; i < 3; i++) {
    await pages[i].getByRole('button', { name: '加入房间', exact: true }).click();
    await pages[i].locator('input[name=nickname]').fill(i === 1 ? '小满' : '阿七');
    await pages[i].locator('input[name=room]').fill(code);
    await pages[i].locator('input[name=password]').fill('friends-2026');
    await pages[i].getByRole('button', { name: '入座', exact: true }).click();
    await pages[i].waitForFunction(count => window.__roomView?.players.length === count, i + 1);
  }
  await pages[0].waitForFunction(() => window.__roomView?.players.length === 3);
  checks.push('three independent browser contexts joined');
  await screen(pages[0], 'room-waiting-1366x768.png');
  for (const page of pages) await clickAction(page, page.getByRole('button', { name: '我准备好了', exact: true }));
  await clickAction(pages[0], pages[0].getByRole('button', { name: '开始这局', exact: true }));
  await pages[0].waitForFunction(() => window.__roomView?.phase === 'bidding');
  const byId = async id => {
    for (const page of pages) if ((await view(page))?.selfId === id) return page;
    throw new Error('Unknown player');
  };
  let current = await view(pages[0]);
  const landlordPage = await byId(current.turnId);
  await clickAction(landlordPage, landlordPage.getByRole('button', { name: '3 分', exact: true }));
  await pages[0].waitForFunction(() => window.__roomView?.phase === 'playing');
  checks.push('all players ready, host started, bid 3 established landlord');
  assert.equal((await view(landlordPage)).hand.length, 20);
  await screen(landlordPage, 'playing-20cards-1366x768.png');
  await recordBounds(landlordPage, 'playing-wide');
  for (let i = 0; i < 20; i++) await cardClick(landlordPage, i);
  assert.equal(await landlordPage.locator('.own-hand .playing-card.selected').count(), 20);
  for (let i = 0; i < 20; i++) await cardClick(landlordPage, i);
  assert.equal(await landlordPage.locator('.own-hand .playing-card.selected').count(), 0);
  checks.push('all 20 overlapping cards individually clickable and deselectable');
  assert.equal(await landlordPage.locator('.card-backs .card-back').allTextContents().then(items => items.join('')), '');
  checks.push('opponent backs contain no points or suit text');
  await landlordPage.setViewportSize({ width: 960, height: 640 });
  await screen(landlordPage, 'playing-960x640.png');
  await recordBounds(landlordPage, 'playing-small');
  await landlordPage.setViewportSize({ width: 1366, height: 768 });
  const restoredId = (await view(pages[2])).selfId;
  await pages[2].reload();
  await pages[2].waitForFunction(id => window.__roomView?.selfId === id && !window.__roomView.paused, restoredId);
  await pages[0].waitForFunction(() => window.__roomView && !window.__roomView.paused);
  checks.push('refresh resumed original seat and unpaused all three clients');

  let selectedSkillUsed = false;
  let targetSkillUsed = false;
  let discarded = false;
  let fiveSkillCaptured = false;
  let firstSkillCapture = false;
  for (let round = 0; round < 12; round++) {
    current = await view(pages[0]);
    assert.equal(current.phase, 'playing');
    const leader = await byId(current.turnId);
    await cardClick(leader, 0);
    await clickAction(leader, leader.getByRole('button', { name: /^出牌 · 1$/ }));
    for (let pass = 0; pass < 2; pass++) {
      current = await view(pages[0]);
      const passer = await byId(current.turnId);
      await clickAction(passer, passer.getByRole('button', { name: '不出', exact: true }));
    }
    await pages[0].waitForFunction(() => window.__roomView?.phase.startsWith('skill'));
    assert.equal((await view(pages[0])).currentPlay, null);
    if (!firstSkillCapture) { await screen(landlordPage, 'skills-1366x768.png'); firstSkillCapture = true; }
    while ((await view(pages[0])).phase === 'skill_discard') {
      for (const page of pages) {
        const state = await view(page);
        if (!state.mustDiscard) continue;
        if (!discarded) {
          await screen(page, 'skill-discard-overflow-1366x768.png');
          await recordBounds(page, 'skill-discard');
        }
        if (state.skills.length === 5 && !fiveSkillCaptured) {
          await screen(page, 'skill-discard-five-1366x768.png');
          await recordBounds(page, 'skill-discard-five');
          await page.setViewportSize({ width: 800, height: 600 });
          await screen(page, 'skill-discard-five-800x600.png');
          await recordBounds(page, 'skill-discard-five-small');
          await page.setViewportSize({ width: 1366, height: 768 });
          fiveSkillCaptured = true;
        }
        for (let i = 0; i < state.mustDiscard; i++) await page.locator('.skill-card').nth(i).click();
        await clickAction(page, page.getByRole('button', { name: '弃掉选中技能', exact: true }));
        discarded = true;
      }
    }
    let guard = 0;
    while ((await view(pages[0])).phase === 'skill_use' && guard++ < 12) {
      current = await view(pages[0]);
      const actor = await byId(current.skillActorId);
      const state = await view(actor);
      const selectable = state.skills.find(skill => ['gift', 'trade'].includes(skill.kind));
      const basic = state.skills.find(skill => ['steal', 'three', 'addTwo'].includes(skill.kind));
      const skill = !selectedSkillUsed ? selectable : !targetSkillUsed ? basic : null;
      if (skill) {
        const skillIndex = state.skills.findIndex(item => item.id === skill.id);
        await actor.locator('.skill-card').nth(skillIndex).click();
        await actor.locator('.target-options').waitFor();
        if (selectable && skill === selectable) {
          await actor.getByRole('button', { name: '返回选牌（选好后再点技能）', exact: true }).click();
          await actor.locator('.modal').waitFor({ state: 'hidden' });
          const selected = await actor.locator('.own-hand .playing-card.selected').count();
          if (selected) {
            for (const button of await actor.locator('.own-hand .playing-card.selected').all()) await button.click({ position: { x: 5, y: 65 } });
          }
          for (let i = 0; i < (skill.kind === 'trade' ? 2 : 1); i++) await cardClick(actor, i);
          await actor.locator('.skill-card').nth(skillIndex).click();
          await screen(actor, 'skill-target-modal-1366x768.png');
          assert.equal(await actor.locator('.skill-selection-note').count(), 1);
          selectedSkillUsed = true;
        }
        await actor.locator('.target-options label').last().click();
        await clickAction(actor, actor.getByRole('button', { name: '就这么干', exact: true }));
        targetSkillUsed = true;
        if (await actor.getByRole('button', { name: '记住了', exact: true }).isVisible()) await actor.getByRole('button', { name: '记住了', exact: true }).click();
      } else {
        await clickAction(actor, actor.getByRole('button', { name: '留着，下次再用', exact: true }));
      }
    }
    if (selectedSkillUsed && targetSkillUsed && discarded && fiveSkillCaptured && round >= 3) break;
  }
  assert.ok(selectedSkillUsed, 'Need a gift/trade to test return-to-hand selection');
  assert.ok(targetSkillUsed);
  assert.ok(discarded);
  assert.ok(fiveSkillCaptured, 'Need landlord holding 5 skills to exercise maximum discard layout');
  checks.push('played a card; two passes cleared table and drew skills');
  checks.push('selected and discarded excess skills through UI');
  checks.push('five landlord skill cards and discard button remained usable at wide and small sizes');
  checks.push('opened target skill, returned to hand selection, re-opened and successfully used');
  await landlordPage.setViewportSize({ width: 800, height: 600 });
  await screen(landlordPage, 'table-800x600.png');
  await recordBounds(landlordPage, 'table-smaller');
  await landlordPage.setViewportSize({ width: 1366, height: 768 });
  await landlordPage.getByRole('button', { name: '玩法说明', exact: true }).click();
  await screen(landlordPage, 'help-1366x768.png');
  await recordBounds(landlordPage, 'help');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  checks.push('no browser JavaScript or console errors');
  await writeFile(new URL('playtest-report.json', output), JSON.stringify({ checks, errors, bounds }, null, 2));
  console.log(JSON.stringify({ checks, errors, bounds }, null, 2));
} catch (error) {
  for (let i = 0; i < pages.length; i++) await screen(pages[i], `failure-player-${i}.png`).catch(() => {});
  await writeFile(new URL('playtest-report.json', output), JSON.stringify({ checks, errors, bounds, failure: String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
