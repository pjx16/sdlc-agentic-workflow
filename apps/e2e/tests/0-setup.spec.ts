import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, SETUP_CODE } from './constants.ts';

// Runs first, against a stack that starts without DASHBOARD_PASSWORD, with a fixed SETUP_CODE and a fake GitHub.
// It creates the admin account the other specs sign in with, and leaves the credentials complete.
test.describe.configure({ mode: 'serial' });

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

const card = (page: Page, id: string) => page.getByTestId(`card-${id}`);

/** Fills the given fields of a card and saves them with the card's single Save button. */
async function saveCard(page: Page, id: string, values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) await card(page, id).getByLabel(label, { exact: true }).fill(value);
  await card(page, id).getByRole('button', { name: 'Save' }).click();
  await expect(card(page, id).getByText('Saved', { exact: true }).first()).toBeVisible();
}

test('a first visit goes to the setup wizard; a wrong code is refused; the right one creates the admin', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByLabel('Setup code').fill('WRONG-CODE-0000');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create admin' }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText('Wrong setup code');

  await page.getByLabel('Setup code').fill(SETUP_CODE);
  await page.getByRole('button', { name: 'Create admin' }).click();
  await expect(page).toHaveURL(/\/setup\/connections$/);

  await page.goto('/setup');
  await expect(page).not.toHaveURL(/\/setup$/); // the wizard closes once an admin exists (this session is signed in, so it lands on the overview)
});

test('save and test the GitHub token; the banner stays until every required credential is set', async ({ page }) => {
  await login(page);
  await page.goto('/setup/connections');

  // One Save and one Test per card, not per field.
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Test' })).toHaveCount(3);

  await saveCard(page, 'github', { 'GitHub token': 'ghp_e2eFakeTokenForTheSetupSpec1234' });
  await expect(card(page, 'github')).toContainText('••••1234');
  await expect(page.locator('body')).not.toContainText('ghp_e2eFakeToken'); // the secret is never rendered back
  await card(page, 'github').getByRole('button', { name: 'Test' }).click();
  await expect(card(page, 'github')).toContainText('Connected as octo-e2e');

  // The Claude token (and the git identity) are still missing.
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'Setup incomplete' })).toContainText('the Claude token');
});

test('finishing the setup removes the banner', async ({ page }) => {
  await login(page);
  await page.goto('/setup/connections');
  await saveCard(page, 'claude', { 'Claude token': 'sk-ant-oat01-e2eFakeClaudeToken' });
  await saveCard(page, 'github', { 'Git author name': 'E2E Bot', 'Git author email': 'e2e@example.com' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Setup incomplete')).toHaveCount(0);
});
