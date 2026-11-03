const path = require('node:path');
const { test, expect, devices } = require('@playwright/test');

const screenshotDirectory = process.env.STATIC_ARTIFACT_SCREENSHOTS;
const expectedDigest = process.env.STATIC_ARTIFACT_DIGEST;
const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { ...devices['Pixel 7'] },
};

function observeSameOriginFailures(page, baseURL) {
  const failures = [];
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.url().startsWith(baseURL) && response.status() >= 400) {
      failures.push(`${response.status()} ${response.url()}`);
    }
  });
  return failures;
}

async function capture(page, testInfo, name) {
  const target = screenshotDirectory
    ? path.join(screenshotDirectory, `sentrydigest-${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: target, fullPage: true });
}

async function datedIssues(request) {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  return [...sitemap.matchAll(/\/archive\/(\d{4}-\d{2}-\d{2})\/<\/loc>/g)].map((match) => match[1]).sort();
}

test('the listener serves this SentryDigest artifact', async ({ request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBeTruthy();
  const identity = response.headers()['x-static-artifact'] || '';
  expect(identity).toMatch(/^SentryDigest [0-9a-f]{64}$/);
  if (expectedDigest) expect(identity).toBe(`SentryDigest ${expectedDigest}`);
  expect(await response.text()).toContain('SentryDigest');
});

for (const [name, options] of Object.entries(viewports)) {
  test(`current and archived issues render from the artifact on ${name}`, async ({ browser, request, baseURL }, testInfo) => {
    const context = await browser.newContext({ ...options, locale: 'en-US', timezoneId: 'UTC' });
    const page = await context.newPage();
    const failures = observeSameOriginFailures(page, baseURL);
    const issues = await datedIssues(request);

    await page.goto('/');
    await expect(page.locator('h1')).toContainText('SentryDigest');
    await expect(page.locator('article.news-item').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await capture(page, testInfo, `current-${name}`);

    await page.goto(`/archive/${issues.at(-1)}/`);
    await expect(page.locator('article.news-item').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await capture(page, testInfo, `archive-${issues.at(-1)}-${name}`);

    expect(failures).toEqual([]);
    await context.close();
  });
}

test('the current digest is readable without JavaScript', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const response = await page.goto('/');

  expect(response?.ok()).toBeTruthy();
  expect(await page.locator('article.news-item').count()).toBeGreaterThan(0);
  await expect(page.locator('article.news-item').first()).toBeVisible();
  await expect(page.locator('article.news-item .news-title a').first()).toHaveAttribute('href', /^https?:\/\//);
  await capture(page, testInfo, 'current-no-js');
  await context.close();
});

test('source filtering and archive navigation work from the artifact', async ({ page, baseURL }) => {
  const failures = observeSameOriginFailures(page, baseURL);
  await page.goto('/');
  const totalCards = await page.locator('article.news-item').count();

  await page.locator('.source-coverage-summary').click();
  const sourceShortcut = page.locator('[data-source-filter]').first();
  const sourceName = await sourceShortcut.getAttribute('data-source-filter');
  await sourceShortcut.click();
  await expect(sourceShortcut).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('source')).toBe(sourceName);
  expect(await page.locator('article.news-item:visible').count()).toBeLessThanOrEqual(totalCards);

  await page.locator('a.previous-issues').click();
  await expect(page.locator('h1')).toHaveText('Previous issues');
  await page.locator('ol.archive-issues a').first().click();
  await expect(page).toHaveURL(/\/archive\/\d{4}-\d{2}-\d{2}\/$/);
  await expect(page.locator('article.news-item').first()).toBeVisible();
  expect(failures).toEqual([]);
});

test('reporting deep links land on the oldest and newest issues', async ({ page, request }) => {
  const issues = await datedIssues(request);
  for (const issueDate of [issues[0], issues.at(-1)]) {
    const issue = await (await request.get(`/archive/${issueDate}/index.json`)).json();
    const { id } = issue.articles.at(-1);
    expect(id).toMatch(/^reporting-[0-9a-f]{12}$/);
    await page.goto(`/archive/${issueDate}/#${id}`);
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
    await expect(page.locator(`[id="${id}"]`)).toBeInViewport();
  }
});
