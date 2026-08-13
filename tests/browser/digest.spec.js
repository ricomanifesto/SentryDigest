const fs = require('node:fs');
const path = require('node:path');
const { expect, test } = require('@playwright/test');

const screenshotDirectory = path.join(process.cwd(), 'test-results/screenshots');

function observeRuntimeFailures(page) {
  const failures = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => failures.push(`request: ${request.url()} ${request.failure()?.errorText || ''}`));
  return failures;
}

test.beforeAll(() => {
  fs.mkdirSync(screenshotDirectory, { recursive: true });
});

test('rendered digest shows cards and preserves its core interactions', async ({ page }) => {
  const runtimeFailures = observeRuntimeFailures(page);
  const response = await page.goto('/');

  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('h1')).toContainText('SentryDigest');
  const cards = page.locator('article.news-item');
  const totalCards = await cards.count();
  expect(totalCards).toBeGreaterThan(0);
  await expect(cards.first()).toBeVisible();
  await expect(cards.first().locator('time')).toContainText('UTC');

  const themeToggle = page.locator('#themeToggle');
  await themeToggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/);

  const sourceShortcut = page.locator('[data-source-filter]').first();
  const sourceName = await sourceShortcut.getAttribute('data-source-filter');
  await sourceShortcut.click();
  await expect(sourceShortcut).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('source')).toBe(sourceName);
  expect(await page.locator('article.news-item:visible').count()).toBeLessThanOrEqual(totalCards);

  await expect(page.locator('a.handoff-cue').first()).toHaveAttribute('href', /SentryInsight|GRCInsight/);
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-desktop.png'), fullPage: true });
});

test('mobile digest has no horizontal overflow', async ({ page }) => {
  const runtimeFailures = observeRuntimeFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto('/');

  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('article.news-item').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-mobile.png'), fullPage: true });
});

test('pre-rendered cards remain readable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const response = await page.goto('http://127.0.0.1:4173/');

  expect(response?.ok()).toBeTruthy();
  expect(await page.locator('article.news-item').count()).toBeGreaterThan(0);
  await expect(page.locator('article.news-item').first()).toBeVisible();
  await context.close();
});
