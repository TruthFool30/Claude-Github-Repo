// Playwright smoke test for the messages module.
//   BASE=http://localhost:4204 SHOTS=/tmp/shots node scripts/e2e-messages.mjs
// Expects a freshly seeded instance (npm run seed) with HEARTH_RATE_LIMITS=off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:4204';
const SHOTS = process.env.SHOTS || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'e2e-messages');
fs.mkdirSync(SHOTS, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
const errors = [];
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message.split('\n').slice(0, 4).join('\n    ')}`);
    await browser.close();
    process.exit(1);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function session(email, { width = 1280, height = 800, theme = 'light' } = {}) {
  const mobile = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  await ctx.addInitScript((t) => localStorage.setItem('hearth-theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${email}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${email}: ${m.text()}`);
  });
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password: 'hearth123' } });
  assert(res.ok(), `login ${email} failed`);
  return { ctx, page };
}
const noOverflow = async (page, label) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(over <= 1, `${label}: horizontal overflow of ${over}px`);
};
const familyId = async (page) => (await (await page.request.get(`${BASE}/api/messages/conversations`)).json()).find((c) => c.kind === 'family').id;

console.log(`messages e2e against ${BASE}`);
const alex = await session('alex@hearth.test');
const sam = await session('sam@hearth.test');
const famId = await familyId(alex.page);
const stamp = Date.now().toString(36);
const SAM_MSG = `Sam says hi ${stamp}`;
// Our own fixtures (works on non-fresh data): Sam posts in Family so Alex has something unread.
await sam.page.request.post(`${BASE}/api/messages/conversations/${famId}/messages`, { data: { body: SAM_MSG } });

await step('conversation list renders with unread badges and nav badge', async () => {
  await alex.page.goto(`${BASE}/messages`);
  await alex.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /Family/ }).waitFor();
  const items = await alex.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link').count();
  assert(items >= 5, `expected ≥5 conversations, got ${items}`);
  assert(await alex.page.getByText('Pick a conversation').isVisible(), 'empty chat pane');
  await alex.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Messages\s*,\s*\d+ new/ }).waitFor({ timeout: 5000 });
  await noOverflow(alex.page, 'desktop list');
});

await step('opening Family shows history, unread divider and clears unread', async () => {
  await alex.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Family, \d+ unread/ }).click();
  await alex.page.waitForURL(`**/messages/${famId}`);
  await alex.page.getByRole('log', { name: 'Messages' }).getByText(SAM_MSG).waitFor();
  assert(await alex.page.getByRole('separator', { name: 'New messages' }).count(), 'new messages divider');
  await alex.page.waitForFunction(async (id) => {
    const r = await fetch('/api/messages/unread');
    const j = await r.json();
    return !j.conversations[id];
  }, famId, { timeout: 5000 });
});

await step('sending a message appears live for a second user', async () => {
  await sam.page.goto(`${BASE}/messages/${famId}`);
  await sam.page.getByRole('log', { name: 'Messages' }).waitFor();
  const text = `Hello from e2e ${stamp}`;
  const box = alex.page.getByRole('textbox', { name: 'Message' });
  await box.fill(text);
  await box.press('Enter');
  await alex.page.getByRole('log').getByText(text).waitFor();
  assert((await box.inputValue()) === '', 'composer cleared');
  await sam.page.getByRole('log').getByText(text).waitFor({ timeout: 5000 });
});

await step('typing indicator is shown to the other participant', async () => {
  await sam.page.getByRole('textbox', { name: 'Message' }).pressSequentially('typing…', { delay: 30 });
  await alex.page.getByText(/Sam is typing/).first().waitFor({ timeout: 5000 });
  await sam.page.getByRole('textbox', { name: 'Message' }).fill('');
});

await step('read receipts: "Seen by" updates when Sam has read', async () => {
  await alex.page.getByText(/Seen by .*Sam|Seen by everyone/).first().waitFor({ timeout: 6000 });
});

await step('react to a message and the other user sees it live', async () => {
  const bubble = alex.page.locator('[data-message-id]').filter({ hasText: SAM_MSG }).first();
  await bubble.hover();
  await bubble.getByRole('button', { name: 'React 😂' }).click();
  await bubble.getByRole('button', { name: /^😂 1/ }).waitFor();
  await sam.page.locator('[data-message-id]').filter({ hasText: SAM_MSG }).first().getByRole('button', { name: /^😂 1/ }).waitFor({ timeout: 5000 });
});

await step('reply to a message shows the quoted original', async () => {
  const bubble = alex.page.locator('[data-message-id]').filter({ hasText: SAM_MSG }).first();
  await bubble.hover();
  await bubble.getByRole('button', { name: /Reply to/ }).click();
  await alex.page.getByText('Replying to Sam').waitFor();
  const box = alex.page.getByRole('textbox', { name: 'Message' });
  await box.fill(`Of course buddy ${stamp}`);
  await box.press('Enter');
  const mine = alex.page.locator('[data-message-id]').filter({ hasText: `Of course buddy ${stamp}` });
  await mine.getByRole('button', { name: /Reply to Sam/ }).waitFor();
  await sam.page.locator('[data-message-id]').filter({ hasText: `Of course buddy ${stamp}` }).waitFor({ timeout: 5000 });
});

await step('edit and delete my own message', async () => {
  const box = alex.page.getByRole('textbox', { name: 'Message' });
  await box.fill(`Typo mesage ${stamp}`);
  await box.press('Enter');
  const bubble = alex.page.locator('[data-message-id]').filter({ hasText: `Typo mesage ${stamp}` });
  await bubble.waitFor();
  await alex.page.waitForFunction((s) => [...document.querySelectorAll('[data-message-id]')].some((el) => el.textContent.includes(s) && Number(el.getAttribute('data-message-id')) > 0), `Typo mesage ${stamp}`);
  await bubble.hover();
  await bubble.getByRole('button', { name: 'Message actions' }).click();
  await alex.page.getByRole('menuitem', { name: 'Edit' }).click();
  await alex.page.getByText('Editing message').waitFor();
  const edit = alex.page.getByRole('textbox', { name: 'Edit message' });
  await edit.fill(`Fixed message ${stamp}`);
  await edit.press('Enter');
  const fixed = alex.page.locator('[data-message-id]').filter({ hasText: `Fixed message ${stamp}` });
  await fixed.getByText('edited').waitFor();
  await sam.page.getByRole('log').getByText(`Fixed message ${stamp}`).waitFor({ timeout: 5000 });
  await fixed.hover();
  await fixed.getByRole('button', { name: 'Message actions' }).click();
  await alex.page.getByRole('menuitem', { name: 'Delete' }).click();
  await alex.page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await alex.page.getByRole('log').getByText('You deleted this message').waitFor();
  await sam.page.getByRole('log').getByText('This message was deleted').first().waitFor({ timeout: 5000 });
});

await step('attach a photo, send it and open it in the lightbox', async () => {
  await alex.page.locator('input[type=file][accept="image/*"]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG });
  await alex.page.getByRole('button', { name: 'Remove attachment 1' }).waitFor();
  const box = alex.page.getByRole('textbox', { name: 'Message' });
  await box.fill(`Photo ${stamp}`);
  await box.press('Enter');
  const bubble = alex.page.locator('[data-message-id]').filter({ hasText: `Photo ${stamp}` });
  await bubble.getByRole('button', { name: /Open photo 1/ }).waitFor();
  await alex.page.waitForFunction((s) => [...document.querySelectorAll('[data-message-id]')].some((el) => el.textContent.includes(s) && Number(el.getAttribute('data-message-id')) > 0 && el.querySelector('img[src^="/api/messages/attachments/"]')), `Photo ${stamp}`, { timeout: 8000 });
  await sam.page.locator('[data-message-id]').filter({ hasText: `Photo ${stamp}` }).locator('img').waitFor({ timeout: 5000 });
  await bubble.getByRole('button', { name: /Open photo 1/ }).click();
  await alex.page.getByRole('dialog', { name: 'Image viewer' }).waitFor();
  await alex.page.keyboard.press('Escape');
  await alex.page.getByRole('dialog', { name: 'Image viewer' }).waitFor({ state: 'detached' });
});

await step('older history loads when scrolling up', async () => {
  // Push enough messages via the API to need a second page, then check the top loads.
  for (let i = 0; i < 45; i++) await alex.page.request.post(`${BASE}/api/messages/conversations/${famId}/messages`, { data: { body: `bulk ${i} ${stamp}` } });
  await alex.page.reload();
  await alex.page.getByRole('log').getByText(`bulk 44 ${stamp}`).waitFor();
  const log = alex.page.getByRole('log', { name: 'Messages' });
  for (let i = 0; i < 6; i++) {
    await log.evaluate((el) => el.scrollTo({ top: 0 }));
    await alex.page.waitForTimeout(400);
  }
  await alex.page.getByRole('log').getByText(SAM_MSG, { exact: true }).first().waitFor({ timeout: 6000 });
});

await step('search finds a message and jumps to it', async () => {
  const res = await (await alex.page.request.get(`${BASE}/api/search?q=${encodeURIComponent(SAM_MSG)}`)).json();
  const hit = res.results.find((r) => r.module === 'messages');
  assert(hit, 'search result for messages');
  await alex.page.goto(`${BASE}${hit.link}`);
  await alex.page.locator('[data-message-id]').filter({ hasText: SAM_MSG }).first().waitFor();
  await alex.page.waitForFunction(() => !location.search.includes('m='), null, { timeout: 6000 });
});

let groupId;
await step('create a group; the invited member sees it live', async () => {
  await sam.page.goto(`${BASE}/messages`);
  await sam.page.getByRole('navigation', { name: 'Conversations' }).waitFor();
  await alex.page.goto(`${BASE}/messages`);
  await alex.page.getByRole('button', { name: 'New chat' }).first().click();
  const dlg = alex.page.getByRole('dialog', { name: 'New conversation' });
  await dlg.getByRole('radio', { name: /New group/ }).click();
  await dlg.getByLabel('Group name').fill(`Movie night ${stamp}`);
  await dlg.getByRole('radio', { name: '🎮' }).click();
  await dlg.getByRole('group', { name: 'Group members' }).getByRole('button', { name: 'Sam' }).click();
  await alex.page.getByRole('button', { name: 'Create group' }).click();
  await alex.page.waitForURL(/\/messages\/\d+$/);
  groupId = Number(alex.page.url().split('/').pop());
  await alex.page.getByRole('log').getByText(/You created the group/).waitFor();
  await sam.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(`Movie night ${stamp}`) }).waitFor({ timeout: 5000 });
});

await step('group details: rename, mute, and the member list', async () => {
  await alex.page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  const panel = alex.page.getByRole('complementary', { name: 'Conversation details' });
  await panel.getByText('Sam Rivera').waitFor();
  await panel.getByRole('button', { name: 'Edit group' }).click();
  await panel.getByLabel('Group name').fill(`Film club ${stamp}`);
  await panel.getByRole('button', { name: 'Save' }).click();
  await alex.page.getByRole('log').getByText(`renamed the group to “Film club ${stamp}”`).waitFor();
  await sam.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(`Film club ${stamp}`) }).waitFor({ timeout: 5000 });
  await panel.getByRole('switch').click();
  await alex.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: new RegExp(`Film club ${stamp}.*muted`) }).waitFor();
  await panel.getByRole('button', { name: 'Close details' }).click();
});

await step('unread badge updates live for a DM on another page', async () => {
  await sam.page.goto(`${BASE}/calendar`);
  await sam.page.waitForTimeout(600);
  const before = (await (await sam.page.request.get(`${BASE}/api/messages/unread`)).json()).total;
  const dm = await (await alex.page.request.post(`${BASE}/api/messages/conversations`, { data: { kind: 'direct', user_id: (await (await sam.page.request.get(`${BASE}/api/auth/me`)).json()).user.id } })).json();
  await alex.page.request.post(`${BASE}/api/messages/conversations/${dm.id}/messages`, { data: { body: 'badge check' } });
  await sam.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: new RegExp(`Messages\\s*,\\s*${before + 1} new`) }).waitFor({ timeout: 5000 });
});

await step('group creator deletes the group; member is moved away', async () => {
  await sam.page.goto(`${BASE}/messages/${groupId}`);
  await sam.page.getByRole('log', { name: 'Messages' }).waitFor();
  await alex.page.goto(`${BASE}/messages/${groupId}`);
  await alex.page.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await alex.page.getByRole('button', { name: 'Delete group' }).click();
  await alex.page.getByRole('dialog').getByRole('button', { name: 'Delete group' }).click();
  await alex.page.waitForURL(/\/messages$/);
  await sam.page.waitForURL(/\/messages$/, { timeout: 5000 });
});

await step('keyboard: ArrowUp in an empty composer edits the last message; Esc cancels', async () => {
  await alex.page.goto(`${BASE}/messages/${famId}`);
  const box = alex.page.getByRole('textbox', { name: 'Message' });
  await box.fill(`kbd ${stamp}`);
  await box.press('Enter');
  await alex.page.waitForFunction((s) => [...document.querySelectorAll('[data-message-id]')].some((el) => el.textContent.includes(s) && Number(el.getAttribute('data-message-id')) > 0), `kbd ${stamp}`);
  await box.press('ArrowUp');
  await alex.page.getByText('Editing message').waitFor();
  await alex.page.getByRole('textbox', { name: 'Edit message' }).press('Escape');
  await alex.page.getByText('Editing message').waitFor({ state: 'detached' });
});

await step('people who left a group still show their name and avatar on past messages', async () => {
  const samId = (await (await sam.page.request.get(`${BASE}/api/auth/me`)).json()).user.id;
  const g = await (await alex.page.request.post(`${BASE}/api/messages/conversations`, { data: { kind: 'group', name: `Leavers ${stamp}`, member_ids: [samId] } })).json();
  await sam.page.request.post(`${BASE}/api/messages/conversations/${g.id}/messages`, { data: { body: `Bye for now ${stamp}` } });
  await sam.page.request.delete(`${BASE}/api/messages/conversations/${g.id}/members/${samId}`);
  await alex.page.goto(`${BASE}/messages/${g.id}`);
  const bubble = alex.page.locator('[data-message-id]').filter({ hasText: `Bye for now ${stamp}` });
  await bubble.waitFor();
  assert((await bubble.getByText('Sam', { exact: true }).count()) > 0, 'author name shown');
  assert((await bubble.getByText('Former member').count()) === 0, 'not "Former member"');
  assert((await bubble.locator('[title="Sam Rivera"]').count()) > 0, 'author avatar shown');
});

await step('drafts survive navigation and reload, and show in the list', async () => {
  const draft = `Unsent draft ${stamp}`;
  await alex.page.goto(`${BASE}/messages/${famId}`);
  await alex.page.getByRole('textbox', { name: 'Message' }).fill(draft);
  const lake = (await (await alex.page.request.get(`${BASE}/api/messages/conversations`)).json()).find((c) => c.id !== famId);
  await alex.page.getByRole('navigation', { name: 'Conversations' }).getByRole('link').filter({ hasText: lake.title }).first().click();
  await alex.page.getByRole('navigation', { name: 'Conversations' }).getByText(`Draft:`).waitFor();
  await alex.page.reload();
  await alex.page.getByRole('navigation', { name: 'Conversations' }).getByText(draft).waitFor();
  await alex.page.goto(`${BASE}/messages/${famId}`);
  const box = alex.page.getByRole('textbox', { name: 'Message' });
  await box.waitFor();
  assert((await box.inputValue()) === draft, 'draft restored in composer');
  await box.fill('');
});

// ---------------- mobile flows ----------------
const mob = await session('sam@hearth.test', { width: 390, height: 844 });
await step('mobile: list → chat → back, long-press action sheet, no overflow', async () => {
  const p = mob.page;
  await p.goto(`${BASE}/messages`);
  await p.getByRole('button', { name: 'New chat' }).waitFor(); // FAB
  await noOverflow(p, 'mobile list');
  await p.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Family/ }).click();
  await p.getByRole('log', { name: 'Messages' }).waitFor();
  await noOverflow(p, 'mobile chat');
  // Full-screen chat: bottom tab bar hidden, composer flush with the bottom, no page scroll.
  assert((await p.getByRole('navigation', { name: 'Main' }).count()) === 0, 'bottom tab bar hidden inside a chat');
  const send = await p.getByRole('button', { name: 'Send message' }).boundingBox();
  const vh = p.viewportSize().height;
  assert(send && send.y + send.height <= vh && send.y + send.height > vh - 40, `composer flush at bottom (send button bottom ${send?.y + send?.height} of ${vh})`);
  const pageScroll = await p.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  assert(pageScroll <= 1, `chat page should not scroll (${pageScroll}px)`);
  await p.request.post(`${BASE}/api/messages/conversations/${famId}/messages`, { data: { body: `Long press me ${stamp}` } });
  await p.getByRole('log').getByText(`Long press me ${stamp}`).waitFor();
  const target = p.getByRole('log').getByText(`Long press me ${stamp}`, { exact: true }).first();
  const box = await target.boundingBox();
  await p.touchscreen.tap(box.x + 20, box.y + 10); // warm up
  await target.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: box.x + 20, clientY: box.y + 10 }] });
  await p.waitForTimeout(600);
  await target.dispatchEvent('touchend');
  const sheet = p.getByRole('dialog', { name: 'Message' });
  await sheet.waitFor();
  await sheet.getByRole('button', { name: 'React 🎉' }).click();
  await sheet.waitFor({ state: 'detached' });
  await p.locator('[data-message-id]').filter({ hasText: `Long press me ${stamp}` }).getByRole('button', { name: /^🎉 1/ }).waitFor();
  await p.getByRole('link', { name: 'Back to conversations' }).click();
  await p.waitForURL(/\/messages$/);
  await p.getByRole('navigation', { name: 'Main' }).waitFor();
});
await mob.ctx.close();

// ---------------- screenshots ----------------
async function shots(theme, width, height) {
  const tag = `${width}-${theme}`;
  const s = await session('alex@hearth.test', { width, height, theme });
  const p = s.page;
  const shot = async (name) => {
    await p.waitForTimeout(450);
    await noOverflow(p, `${name} ${tag}`);
    await p.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });
  };
  await p.goto(`${BASE}/messages`);
  await p.getByRole('navigation', { name: 'Conversations' }).getByRole('link').first().waitFor();
  await shot('01-list');
  await p.goto(`${BASE}/messages/${famId}`);
  await p.getByRole('log', { name: 'Messages' }).locator('[data-message-id]').first().waitFor();
  await p.getByRole('log').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot('02-chat-family');
  const img = p.getByRole('button', { name: /Open photo 1/ }).last();
  if (await img.count()) {
    await img.click();
    await p.getByRole('dialog', { name: 'Image viewer' }).waitFor();
    await shot('05-lightbox');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
  }
  const lastBubble = p.getByRole('log').locator('[data-message-id]').filter({ has: p.locator('.whitespace-pre-wrap') }).last();
  if (width < 600) {
    const t = lastBubble.locator('.whitespace-pre-wrap');
    const b = await t.boundingBox();
    await t.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: b.x + 10, clientY: b.y + 10 }] });
    await p.waitForTimeout(600);
    await t.dispatchEvent('touchend');
    await p.getByRole('dialog', { name: 'Message' }).waitFor();
    await shot('06-action-sheet');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
  } else {
    await lastBubble.hover();
    await lastBubble.getByRole('button', { name: 'Message actions' }).click();
    await shot('06-message-menu');
    await p.keyboard.press('Escape');
  }
  const group = (await (await p.request.get(`${BASE}/api/messages/conversations`)).json()).find((c) => c.kind === 'group') ?? { id: famId };
  await p.goto(`${BASE}/messages/${group.id}`);
  await p.getByRole('log').locator('[data-message-id]').first().waitFor();
  await shot('03-chat-group');
  await p.getByRole('button', { name: 'Conversation details', exact: true }).click();
  await shot('04-details');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  if (width < 600) await p.goto(`${BASE}/messages`);
  await p.getByRole('button', { name: 'New chat' }).first().click();
  await p.getByRole('dialog', { name: 'New conversation' }).waitFor();
  await shot('07-new-direct');
  await p.getByRole('dialog').getByRole('radio', { name: /New group/ }).click();
  await p.getByRole('dialog').getByLabel('Group name').fill('Game night');
  await shot('08-new-group');
  await s.ctx.close();
}
await step('screenshots 1280 light/dark, 390 light/dark', async () => {
  for (const theme of ['light', 'dark']) {
    await shots(theme, 1280, 800);
    await shots(theme, 390, 844);
  }
});

await step('no console errors', async () => {
  assert(!errors.length, `console errors:\n${errors.join('\n')}`);
});

await browser.close();
console.log(`\n${passed} checks passed · screenshots in ${SHOTS}`);
