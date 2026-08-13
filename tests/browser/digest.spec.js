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

  const disclosures = page.locator('details.summary-disclosure:visible');
  const disclosureCount = await disclosures.count();
  if (disclosureCount > 0) {
    const disclosure = disclosures.first();
    await disclosure.locator('summary').click();
    await expect(disclosure).toHaveAttribute('open', '');
    const remainder = await disclosure.locator('.summary-full').innerText();
    expect(remainder.trim().split(/\s+/).length).toBeGreaterThanOrEqual(6);
  } else {
    const plainSummaries = page.locator('article.news-item:visible p.news-summary');
    const plainSummaryCount = await plainSummaries.count();
    expect(plainSummaryCount).toBeGreaterThan(0);
    await expect(plainSummaries.first()).toBeVisible();
    expect((await plainSummaries.first().innerText()).trim().length).toBeGreaterThan(0);
  }

  const continuations = page.locator('a.summary-continuation:visible');
  expect(await continuations.count()).toBeGreaterThan(0);
  const continuation = continuations.first();
  const continuationCard = continuation.locator('xpath=ancestor::article[1]');
  await expect(continuation).toHaveAttribute('href', await continuationCard.locator('.news-title a').getAttribute('href'));
  await expect(continuation).toHaveAccessibleName(/^Continue reading at /);
  await continuation.evaluate((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      link.dataset.exercised = 'true';
    }, { once: true });
  });
  await continuation.click();
  await expect(continuation).toHaveAttribute('data-exercised', 'true');

  await expect(page.locator('a.handoff-cue').first()).toHaveAttribute('href', /SentryInsight|GRCInsight/);
  await expect(page.locator('a.handoff-cue[href*="#cve-"]').first()).toHaveAttribute('href', /SentryInsight\/#cve-\d{4}-\d{4,}$/);
  await expect(page.locator('.source-health-note[data-health-status="quiet"]').first()).toContainText(/quiet since .* UTC/);
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
