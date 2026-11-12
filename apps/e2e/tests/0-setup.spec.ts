import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, SETUP_CODE } from './constants.ts';

// Runs first, against a stack that starts without DASHBOARD_PASSWORD, with a fixed SETUP_CODE and a fake GitHub.
// It creates the admin account the other specs sign in with, and leaves the credentials complete.
test.describe.configure({ mode: 'serial' });

const field = (page: Page, key: string) => page.getByTestId(`field-${key}`);

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

async function save(page: Page, key: string, label: string, value: string) {
  await field(page, key).getByLabel(label, { exact: true }).fill(value);
  await field(page, key).getByRole('button', { name: 'Save' }).click();
  await expect(field(page, key).getByText('Saved', { exact: true })).toBeVisible();
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

  await save(page, 'github_token', 'GitHub token', 'ghp_e2eFakeTokenForTheSetupSpec1234');
  await expect(field(page, 'github_token')).toContainText('••••1234');
  await expect(page.locator('body')).not.toContainText('ghp_e2eFakeToken'); // the secret is never rendered back
  await field(page, 'github_token').getByRole('button', { name: 'Test' }).click();
  await expect(field(page, 'github_token').getByRole('status')).toContainText('Connected as octo-e2e');

  // The Claude token (and the git identity) are still missing.
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'Setup incomplete' })).toContainText('the Claude token');
});

test('finishing the setup removes the banner', async ({ page }) => {
  await login(page);
  await page.goto('/setup/connections');
  await save(page, 'claude_token', 'Claude token', 'sk-ant-oat01-e2eFakeClaudeToken');
  await save(page, 'git_author_name', 'Git author name', 'E2E Bot');
  await save(page, 'git_author_email', 'Git author email', 'e2e@example.com');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Setup incomplete')).toHaveCount(0);
});
