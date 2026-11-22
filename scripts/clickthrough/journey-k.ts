import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Page } from 'playwright';
import {
  BASE,
  createMeeting,
  enterOwnRoom,
  guestPerson,
  launch,
  ROOT,
  Run,
  signedInPerson,
  stamp,
} from './lib';

const JOURNEY = 'k';

/** Every page the web app serves; anything else redirects to the front page. */
const LIVE_ROUTES = [
  /^\/$/,
  /^\/practice$/,
  /^\/demo$/,
  /^\/signin$/,
  /^\/new$/,
  /^\/workspaces\/[^/]+$/,
  /^\/workspaces\/[^/]+\/meetings\/[^/]+$/,
  /^\/m\/[^/]+$/,
  /^\/m\/[^/]+\/room$/,
];
const REMOVED_ROUTES = ['/join', '/meeting', '/login', '/setup'];

async function step(run: Run, page: Page, where: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const shot = await run.shot(page, `failed-${where.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => '');
    run.finding('ERROR', where, `step threw: ${error instanceof Error ? error.message : String(error)}`, shot);
  }
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

/** Every in-app path written as `to=`, `navigate(`, `href=` or `location.assign(` in web/src. */
function inAppTargets(): Array<{ file: string; target: string }> {
  const found: Array<{ file: string; target: string }> = [];
  const pattern = /(?:\bto=|\bhref=|navigate\(|location\.assign\()\s*\{?\s*[`'"](\/[^`'"?#]*)/g;
  for (const file of sourceFiles(join(ROOT, 'web/src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const target = (match[1] ?? '').replace(/\$\{[^}]*\}/g, 'x').replace(/\/+$/, '') || '/';
      found.push({ file: relative(ROOT, file), target });
    }
  }
  return found;
}

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = stamp();
  try {
    const anon = await guestPerson(browser, run, {
      expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
    });
    const page = anon.page;

    async function landsOnLivePage(what: string, expectedPath: RegExp): Promise<void> {
      await page.waitForLoadState('domcontentloaded');
      const path = new URL(page.url()).pathname;
      const shot = await run.shot(page, what.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
      if (!LIVE_ROUTES.some((route) => route.test(path)) || !expectedPath.test(path)) {
        run.finding('DEAD-END', what, `landed on ${path}, which is not the expected current page`, shot);
        return;
      }
      const body = (await page.locator('body').innerText()).trim();
      if (body === '') run.finding('DEAD-END', what, `${path} rendered blank`, shot);
      else run.pass(`${what} lands on ${path} (${shot}).`);
    }

    await step(run, page, 'front page links', async () => {
      await page.goto(BASE + '/');
      await page.getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
      const hrefs = await page.locator('a[href]').evaluateAll((nodes) =>
        nodes.map((node) => ({ text: (node.textContent ?? '').trim(), href: (node as HTMLAnchorElement).getAttribute('href') ?? '' })),
      );
      run.note(`Front page links: ${hrefs.map((h) => `${h.text} -> ${h.href}`).join('; ')}`);
      for (const link of hrefs) {
        if (/^https?:/.test(link.href) || link.href.startsWith('mailto:')) {
          run.note(`External link left unclicked: ${link.text} -> ${link.href}`);
          continue;
        }
        await page.goto(BASE + '/');
        await page.getByRole('link', { name: link.text, exact: true }).first().click();
        const expected = link.href.split('?')[0] ?? '';
        await landsOnLivePage(`front page link "${link.text}"`, new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`));
      }
      const buttons = await page.getByRole('button').allInnerTexts();
      run.note(`Front page buttons: ${buttons.join(', ')}`);
    });

    await step(run, page, 'team meeting button', async () => {
      await page.goto(BASE + '/');
      await page.getByRole('link', { name: 'Run a team meeting' }).click();
      await page.waitForURL(/\/signin/, { timeout: 10_000 });
      const next = new URL(page.url()).searchParams.get('next');
      if (next !== '/new') run.finding('DEAD-END', 'team meeting button', `sign-in was asked to return to ${String(next)}, not /new`);
      else run.pass('Run a team meeting opens sign-in that returns to New meeting.');
    });

    const owner = await signedInPerson(browser, run, {
      name: `Code Owner ${suffix}`,
      email: `codeowner-${suffix}@clickthrough.test`,
      expected: () => false,
    });
    let code = '';
    let meetingLink = '';
    await step(run, owner.page, 'create a real meeting with a code', async () => {
      meetingLink = await createMeeting(owner.page, `Code lookup ${suffix}`);
      await enterOwnRoom(owner.page, meetingLink);
      const id = new URL(meetingLink).pathname.split('/')[2] ?? '';
      const response = await owner.page.request.get(`${BASE}/api/meetings/${encodeURIComponent(id)}/meeting-code`);
      const body = (await response.json()) as { code?: string };
      if (typeof body.code !== 'string' || body.code === '') throw new Error(`no meeting code (HTTP ${response.status()})`);
      code = body.code;
      run.pass(`A real meeting is open with code ${code}.`);
    });

    await step(run, page, 'right code', async () => {
      await page.goto(BASE + '/');
      await page.getByLabel('Got an invite? Enter the meeting code').fill(code.toLowerCase());
      await page.getByRole('button', { name: 'Join' }).click();
      await page.waitForURL(/\/m\/[^/]+(\?|$)/, { timeout: 15_000 });
      await page.getByText('You are invited').waitFor({ timeout: 15_000 });
      const shot = await run.shot(page, 'code-join-page');
      if (!page.url().startsWith(meetingLink)) run.finding('DEAD-END', 'right code', `went to ${page.url()}, not ${meetingLink}`, shot);
      else run.pass(`The code opens that meeting's join page (${shot}).`);
      const nameBox = page.getByLabel('Your name');
      if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(`Code Guest ${suffix}`);
      await page.getByRole('button', { name: 'Join meeting' }).click();
      await page.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 });
      await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      run.pass('The guest joined the meeting room with the typed code.');
    });

    await step(run, page, 'wrong code', async () => {
      await page.goto(BASE + '/');
      await page.getByLabel('Got an invite? Enter the meeting code').fill('ZZZZZZ');
      await page.getByRole('button', { name: 'Join' }).click();
      const alert = page.getByRole('alert').filter({ hasText: "couldn't find a meeting" });
      await alert.waitFor({ timeout: 10_000 });
      const shot = await run.shot(page, 'wrong-code');
      const text = (await alert.innerText()).trim();
      if (text !== "We couldn't find a meeting with that code. Check it, or open the invite link.") {
        run.finding('CONFUSING', 'wrong code', `message was: ${text}`, shot);
      } else run.pass(`A wrong code shows the plain message and stays on the front page (${shot}).`);
      if (new URL(page.url()).pathname !== '/') run.finding('DEAD-END', 'wrong code', `left the front page for ${page.url()}`, shot);
    });

    await step(run, page, 'old addresses', async () => {
      for (const old of REMOVED_ROUTES) {
        await page.goto(BASE + old + '?code=ABC123');
        await page.getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
        const path = new URL(page.url()).pathname;
        if (path !== '/') run.finding('DEAD-END', old, `stayed on ${path} instead of going to /`);
        else run.pass(`${old} redirects to the front page.`);
      }
    });

    await step(run, page, 'in-app link audit', async () => {
      const targets = inAppTargets();
      const bad = targets.filter(
        ({ target }) =>
          !target.startsWith('/api/') &&
          !LIVE_ROUTES.some((route) => route.test(target)) &&
          !/^\/(kaki-cup\.svg|favicon)/.test(target),
      );
      run.note(`In-app link targets found: ${[...new Set(targets.map((t) => t.target))].sort().join(', ')}`);
      for (const { file, target } of bad) {
        run.finding('DEAD-END', file, `links to ${target}, which is not a current page`);
      }
      if (bad.length === 0) run.pass(`All ${targets.length} in-app link targets point to current pages.`);
    });

    await owner.context.close();
    await anon.context.close();
  } finally {
    run.save();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
