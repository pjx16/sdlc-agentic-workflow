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

const CHARTS = ['Usage over time', 'Tokens by stage', 'Pull requests merged', 'Lines changed', 'Tickets by state', 'Findings by severity', 'Stage duration'];
const figure = (page: Page, title: string) => page.locator('figure', { has: page.getByText(title, { exact: true }) });

test('with data: every chart renders, has a text alternative, and its data as a table', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Queue length')).toBeVisible();
  for (const title of CHARTS) {
    const fig = figure(page, title);
    await expect(fig, title).toBeVisible();
    await expect(fig.getByRole('img'), title).toHaveAttribute('aria-label', new RegExp(`^${title}`));
    await expect(fig.locator('svg').first(), title).toBeVisible();
    await fig.getByRole('button', { name: 'View data' }).click();
    await expect(fig.getByRole('table'), title).toBeVisible();
    await expect(fig.getByRole('table').locator('tbody tr').first(), title).toBeVisible();
    await fig.getByRole('button', { name: 'View chart' }).click();
  }
});

test('the range switch changes every chart, and tokens can be grouped by model', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: '24h' }).click();
  await expect(page).toHaveURL(/range=24h/);
  await expect(page.getByText('Tickets done (24h)')).toBeVisible();
  await page.getByRole('link', { name: 'By model' }).click();
  await expect(page.getByText('Tokens by model')).toBeVisible();
});

test('the ticket timeline shows one bar per run, and its data', async ({ page }) => {
  await login(page);
  const id = (await withDb((c) => c.query(`SELECT id FROM "Ticket" WHERE key = $1`, [SEED.review.key]))).rows[0].id as string;
  await page.goto(`/tickets/${id}?tab=runs`);
  const fig = figure(page, 'Timeline');
  await expect(fig.getByRole('link')).toHaveCount(4);
  await fig.getByRole('button', { name: 'View data' }).click();
  await expect(fig.getByRole('cell', { name: 'failed' })).toBeVisible();
});

test('the usage page lists the snapshots', async ({ page }) => {
  await login(page);
  await page.goto('/usage');
  await expect(page.getByRole('table').first()).toContainText('allowed_warning');
});

test('without data: every chart shows an empty state instead of a chart', async ({ page }) => {
  await withDb(async (c) => {
    await c.query('DELETE FROM "ReviewFinding"');
    await c.query('DELETE FROM "SupportTicket"');
    await c.query('DELETE FROM "StageRun"');
    await c.query('DELETE FROM "UsageSnapshot"');
    await c.query(`DELETE FROM "Event"`);
    await c.query('DELETE FROM "StateTransition"');
    await c.query('DELETE FROM "Ticket"');
  });
  await login(page);
  const expected: Record<string, RegExp> = {
    'Usage over time': /No usage recorded/, 'Tokens by stage': /No tokens used/, 'Pull requests merged': /No pull request was merged/, 'Lines changed': /No merged pull request with line counts/, 'Tickets by state': /No tickets yet/, 'Findings by severity': /No review findings/, 'Stage duration': /No stage has finished/,
  };
  for (const title of CHARTS) {
    const fig = figure(page, title);
    await expect(fig, title).toContainText(expected[title] as RegExp);
    await expect(fig.getByRole('button', { name: 'View data' }), title).toHaveCount(0);
  }
  await expect(page.getByText('No ticket is waiting for a stage.')).toBeVisible();
});
