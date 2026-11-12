import { expect, test, type Page } from '@playwright/test';
import { withDb } from '../db.ts';
import { SEED } from '../seed.ts';
import { PASSWORD } from './constants.ts';

test.describe.configure({ mode: 'serial' });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /log in|sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

const ticketLink = (page: Page, key: string) => page.getByRole('link', { name: new RegExp(`\\b${key}\\b`) }).first();

test('pages need a session; a wrong password is refused; the right one logs in', async ({ page }) => {
  await page.goto('/tickets');
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: /log in|sign in/i }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await login(page);
});

test('create a project', async ({ page }) => {
  await login(page);
  await page.goto('/projects/new');
  await page.getByLabel('Name', { exact: true }).fill('Shipping');
  await page.getByLabel('Repository URL').fill('https://github.com/acme/shipping');
  await page.getByLabel('Local ticket prefix').fill('SHIP');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+/);
  await page.goto('/projects');
  await expect(page.getByRole('link', { name: 'Shipping' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: SEED.project }).first()).toBeVisible();
});

test('paste a ticket into a ready project', async ({ page }) => {
  await login(page);
  await page.goto('/tickets/new');
  await page.getByLabel('Project').selectOption({ label: SEED.project });
  await page.getByLabel('Title').fill('Pasted from the browser');
  await page.getByLabel('Description').fill('A ticket that was typed in.');
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await page.waitForURL(/\/tickets\/[0-9a-f-]+/);
  await expect(page.getByRole('heading', { name: 'Pasted from the browser' })).toBeVisible();
  await expect(page.getByText('BIL-10')).toBeVisible();
});

test('approve a plan', async ({ page }) => {
  await login(page);
  await page.goto('/tickets');
  await ticketLink(page, SEED.plan.key).click();
  await expect(page.getByLabel('Plan')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toContainText('Plan approved');
  await page.reload();
  await expect(page.getByText(/Breakdown/i).first()).toBeVisible();
});

test('approve a breakdown', async ({ page }) => {
  await login(page);
  await page.goto('/tickets');
  await ticketLink(page, SEED.breakdown.key).click();
  await expect(page.locator('input[value="Add the counter"], textarea').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(/approved/i);
});

test('answer a support query, which resumes the ticket', async ({ page }) => {
  await login(page);
  await page.goto('/support');
  await expect(page.getByText(SEED.question)).toBeVisible();
  await page.getByLabel('Your answer').fill('EUR');
  await page.getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByText('Answer: EUR')).toBeVisible();
  await page.goto('/tickets');
  await ticketLink(page, 'BIL-4').click();
  await expect(page.getByText('Planning').first()).toBeVisible();
  await expect(page.getByText(/On hold:/)).toHaveCount(0);
});

test('pause banner: shows why, Ignore clears it', async ({ page }) => {
  await withDb((c) => c.query(`UPDATE "GlobalSettings" SET "pipelinePaused" = true, "pausedReason" = '5-hour usage is at 55% (threshold 50%)', "resetsAt" = now() + interval '3 hours' WHERE id = 'global'`));
  await login(page);
  const banner = page.getByRole('alert').filter({ hasText: 'Pipeline paused' });
  await expect(banner).toContainText('5-hour usage is at 55%');
  await expect(page.getByText('Paused', { exact: true })).toBeVisible();
  await banner.getByRole('button', { name: 'Ignore usage for this window' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByText('Idle', { exact: true })).toBeVisible();
  expect((await withDb((c) => c.query(`SELECT "usageIgnoredUntil" FROM "GlobalSettings"`))).rows[0].usageIgnoredUntil).not.toBeNull();
});

test('pause banner: Resume clears a pause', async ({ page }) => {
  await withDb((c) => c.query(`UPDATE "GlobalSettings" SET "pipelinePaused" = true, "pausedReason" = 'manual' WHERE id = 'global'`));
  await login(page);
  await page.getByRole('alert').filter({ hasText: 'Pipeline paused' }).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pipeline paused' })).toHaveCount(0);
});

test('every dashboard page opens', async ({ page }) => {
  await login(page);
  const ticket = (await withDb((c) => c.query(`SELECT id FROM "Ticket" WHERE key = $1`, [SEED.review.key]))).rows[0].id as string;
  const pages: [string, string | RegExp][] = [
    ['/', 'Overview'], ['/tickets', 'Tickets'], [`/tickets/${ticket}`, SEED.review.title], [`/tickets/${ticket}?tab=runs`, SEED.review.title], [`/tickets/${ticket}?tab=history`, SEED.review.title],
    ['/support', 'Support queries'], ['/projects', 'Projects'], ['/projects/new', 'New project'], ['/guidelines', 'Guidelines'], ['/usage', 'Usage'], ['/settings', 'Settings'], ['/tickets/new', 'New ticket'],
  ];
  for (const [url, heading] of pages) {
    const res = await page.goto(url);
    expect(res?.status(), url).toBeLessThan(400);
    await expect(page.getByRole('heading', { name: heading }).first(), url).toBeVisible();
  }
});
