import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../server/index.ts';

const phrases = ['快点吧我等到花儿也谢了', '共三小你打的几把牌', '给阿姨倒一杯卡布基诺', '你好机车啊', '你还能13张牌把我秒了？'];
const output = new URL('../artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const server = await createGameServer({ port: 0, host: '127.0.0.1' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const checks = [], errors = [], sent = [], pages = [];
let legacyCapability = false;
const view = page => page.evaluate(() => window.__chatView);
const screenshot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true, omitBackground: true });
const gameFields = state => ({ phase: state.phase, turnId: state.turnId, hand: state.hand, skills: state.skills, currentPlay: state.currentPlay, passCount: state.passCount, deadline: state.deadline, direction: state.direction, landlordId: state.landlordId });
async function action(page, locator) {
  const old = (await view(page))?.version ?? -1;
  await locator.click();
  await page.waitForFunction(version => window.__chatView?.version > version, old);
}
async function allAtLeast(version) { for (const page of pages) await page.waitForFunction(value => window.__chatView?.version >= value, version); }
async function sendPhrase(index, phraseId) {
  const page = pages[index];
  const old = await view(page);
  await page.getByRole('button', { name: '快捷聊天', exact: true }).click();
  const choices = page.locator('.chat-phrase');
  assert.deepEqual(await choices.allTextContents(), phrases);
  assert.equal(await page.locator('.chat-menu input,.chat-menu textarea,.chat-menu [contenteditable=true]').count(), 0);
  await choices.nth(phraseId).click();
  await allAtLeast(old.version + 1);
  const actorId = old.selfId;
  for (const receiver of pages) {
    const bubble = receiver.locator(`.chat-bubble[data-actor-id="${actorId}"][data-phrase-id="${phraseId}"]`);
    await bubble.waitFor({ state: 'visible' });
    assert.equal(await bubble.locator('p').textContent(), phrases[phraseId]);
    const expected = await receiver.evaluate(({ actorId }) => {
      const state = window.__chatView, self = state.players.findIndex(player => player.id === state.selfId), actor = state.players.findIndex(player => player.id === actorId);
      return actorId === state.selfId ? 'self-bubble' : actor === (self + 1) % 3 ? 'right-bubble' : 'left-bubble';
    }, { actorId });
    assert.ok((await bubble.getAttribute('class')).includes(expected));
  }
  sent.push({ actorId, phraseId, at: Date.now() });
}

try {
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.addInitScript(() => {
      try { if (location.protocol === 'http:') localStorage.setItem('glass-server', location.origin); } catch {}
      window.__chatMessages = []; window.__chatSent = [];
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args); window.__chatSocket = this;
          this.addEventListener('message', event => { const message = JSON.parse(event.data); window.__chatMessages.push(message); if (message.type === 'state') window.__chatView = message.state; });
        }
        send(message) { try { window.__chatSent.push(JSON.parse(message)); } catch {} super.send(message); }
      };
    });
    const page = await context.newPage();
    if (index === 2) await page.routeWebSocket('**/ws', route => {
      const upstream = route.connectToServer();
      upstream.onMessage(raw => {
        if (legacyCapability && typeof raw === 'string') {
          const message = JSON.parse(raw);
          if (message.type === 'state') { message.state.capabilities = message.state.capabilities.filter(capability => capability !== 'wild-two-no-single'); route.send(JSON.stringify(message)); return; }
        }
        route.send(raw);
      });
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text()); });
    pages.push(page);
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  }
  await pages[0].locator('input[name=nickname]').fill('聊天甲');
  await pages[0].locator('input[name=password]').fill('chat-test');
  await pages[0].getByRole('button', { name: '开一桌', exact: true }).click();
  await pages[0].waitForFunction(() => window.__chatView?.phase === 'lobby');
  const code = (await view(pages[0])).code;
  for (let index = 1; index < 3; index++) {
    const page = pages[index];
    await page.getByRole('button', { name: '加入房间', exact: true }).click();
    await page.locator('input[name=nickname]').fill(index === 1 ? '聊天乙' : '聊天丙');
    await page.locator('input[name=room]').fill(code); await page.locator('input[name=password]').fill('chat-test');
    await page.getByRole('button', { name: '入座', exact: true }).click();
    await page.waitForFunction(count => window.__chatView?.players.length === count, index + 1);
  }
  await pages[0].waitForFunction(() => window.__chatView?.players.length === 3);
  for (const page of pages) await action(page, page.getByRole('button', { name: '我准备好了', exact: true }));
  await action(pages[0], pages[0].getByRole('button', { name: '开始这局', exact: true }));
  const bidderId = (await view(pages[0])).turnId;
  let leader;
  for (const page of pages) { await page.waitForFunction(() => window.__chatView?.phase === 'bidding'); if ((await view(page)).selfId === bidderId) leader = page; }
  await action(leader, leader.getByRole('button', { name: '3 分', exact: true }));
  await allAtLeast((await view(leader)).version);
  await leader.locator('.own-hand .playing-card').first().click({ position: { x: 5, y: 45 } });
  await action(leader, leader.getByRole('button', { name: /^出牌/ }));
  for (let i = 0; i < 2; i++) {
    const current = await view(leader);
    let passer;
    for (const page of pages) { await page.waitForFunction(version => window.__chatView?.version >= version, current.version); if ((await view(page)).selfId === current.turnId) passer = page; }
    await action(passer, passer.getByRole('button', { name: '不出', exact: true }));
    await allAtLeast((await view(passer)).version);
  }
  assert.equal((await view(leader)).phase, 'playing');
  await leader.locator('.own-hand .playing-card').first().click({ position: { x: 5, y: 45 } });
  await action(leader, leader.getByRole('button', { name: /^出牌/ }));
  await allAtLeast((await view(leader)).version);
  const baseline = await Promise.all(pages.map(async page => gameFields(await view(page))));
  assert.ok(baseline.every(state => state.skills.length >= 1));
  checks.push('three real browser clients joined one password room and reached play with stored skills');

  for (const page of pages) assert.ok((await view(page)).capabilities.includes('quick-chat'));
  await pages[0].getByRole('button', { name: '快捷聊天', exact: true }).click();
  assert.deepEqual(await pages[0].locator('.chat-phrase').allTextContents(), phrases);
  assert.equal(await pages[0].locator('.chat-menu input,.chat-menu textarea,[contenteditable=true]').count(), 0);
  await screenshot(pages[0], 'quick-chat-menu.png');
  await pages[0].getByRole('button', { name: '收起快捷聊天', exact: true }).click();
  checks.push('menu contains exactly the five requested original phrases and no free-text input');

  await sendPhrase(0, 0);
  const beforeCooldown = await view(pages[0]);
  const errorsBefore = await pages[0].evaluate(() => window.__chatMessages.filter(message => message.type === 'error').length);
  await pages[0].evaluate(() => window.__chatSocket.send(JSON.stringify({ type: 'action', action: { type: 'chat', phraseId: 1 } })));
  await pages[0].waitForFunction(count => window.__chatMessages.filter(message => message.type === 'error').length > count, errorsBefore);
  const rejection = await pages[0].evaluate(() => window.__chatMessages.filter(message => message.type === 'error').at(-1).message);
  assert.match(rejection, /3秒|稍等|冷却|频繁/);
  assert.equal((await view(pages[0])).version, beforeCooldown.version);
  checks.push('server rejects another chat from the same sender within three seconds without changing state');

  await sendPhrase(1, 1); await sendPhrase(2, 2);
  const resumeAt = Math.max(sent[0].at, sent[1].at) + 3050;
  await pages[0].waitForTimeout(Math.max(0, resumeAt - Date.now()));
  await sendPhrase(0, 3); await sendPhrase(1, 4);
  await screenshot(pages[0], 'quick-chat-bubbles.png');
  assert.deepEqual([...new Set(sent.map(message => message.phraseId))].sort(), [0, 1, 2, 3, 4]);
  for (let i = 0; i < pages.length; i++) assert.deepEqual(gameFields(await view(pages[i])), baseline[i]);
  assert.ok(sent.some(message => message.actorId !== baseline[0].turnId));
  for (const page of pages) {
    const requests = await page.evaluate(() => window.__chatSent.filter(message => message.type === 'action' && message.action.type === 'chat').map(message => message.action));
    assert.ok(requests.every(request => Object.keys(request).sort().join(',') === 'phraseId,type'));
  }
  checks.push('all five phrases broadcast to all three clients at the correct actor position');
  checks.push('out-of-turn chat consumes no play or skill, changes no hand/table, and never resets the play deadline');

  const restoreId = (await view(pages[2])).selfId;
  await pages[2].reload();
  await pages[2].waitForFunction(id => window.__chatView?.selfId === id && !window.__chatView.paused, restoreId);
  await pages[2].waitForTimeout(200);
  assert.equal(await pages[2].locator('.chat-bubble').count(), 0);
  checks.push('refresh restores the same seat without replaying historical chat bubbles');
  await pages[0].waitForTimeout(Math.max(0, sent.at(-1).at + 5000 - Date.now()));
  for (const page of pages) await page.waitForFunction(() => document.querySelectorAll('.chat-bubble').length === 0);
  checks.push('chat bubbles automatically disappear after their 4.5-second lifetime');

  legacyCapability = true;
  await pages[0].evaluate(() => window.__chatSocket.send(JSON.stringify({ type: 'action', action: { type: 'chat', phraseId: 0 } })));
  await pages[2].getByRole('heading', { name: '朋友，入座。', exact: true }).waitFor();
  await pages[2].getByRole('status').filter({ hasText: '房间服务尚未更新' }).waitFor();
  assert.equal(await pages[2].getByRole('button', { name: '快捷聊天', exact: true }).count(), 0);
  await pages[0].getByRole('heading', { name: '朋友，入座。', exact: true }).waitFor();
  checks.push('a server missing only the latest wildcard capability is rejected with an upgrade explanation; leaving the active room also closes it for the other seats');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', checks, errors }, null, 2));
} catch (error) {
  errors.push(error.stack || String(error)); process.exitCode = 1;
  for (let i = 0; i < pages.length; i++) await screenshot(pages[i], `quick-chat-failure-${i}.png`).catch(() => {});
  console.error(JSON.stringify({ result: 'failed', checks, errors }, null, 2));
} finally {
  await writeFile(new URL('quick-chat-playtest-report.json', output), JSON.stringify({ result: errors.length ? 'failed' : 'passed', checks, errors, sent }, null, 2));
  await browser.close(); await server.close();
}
