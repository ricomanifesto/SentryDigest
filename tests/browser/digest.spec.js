const fs = require('node:fs');
const path = require('node:path');
const { expect, test } = require('@playwright/test');
const { generateHTML } = require('../../scripts/render-news-html');

const screenshotDirectory = path.join(process.cwd(), 'test-results/screenshots');
const retainedContextFixture = path.join(process.cwd(), 'test-results/retained-context.html');
const staleContextFixture = path.join(process.cwd(), 'test-results/stale-context.html');
const cadenceFixture = path.join(process.cwd(), 'test-results/cadence.html');
const cveHandoffFixture = path.join(process.cwd(), 'test-results/cve-handoff.html');
const summaryBehaviorFixture = path.join(process.cwd(), 'test-results/summary-behavior.html');
const sourceHealthFixture = path.join(process.cwd(), 'test-results/source-health.html');

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
  const newsItems = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'news-data.json'), 'utf8'));
  const baseContext = {
    schema_version: 2,
    checked_at: '2026-08-14T02:20:21.072Z',
    report_date: '2026-08-13',
    manifest_generated_at: '2026-08-13T21:54:18Z',
    report_url: 'https://ricomanifesto.github.io/SentryInsight/',
  };
  const renderFixture = (mode) => generateHTML(newsItems, {
    generatedAt: new Date('2026-08-14T02:20:21.072Z'),
    insightContext: { ...baseContext, mode },
    retainedIssueDates: ['2026-08-13', '2026-08-14'],
  }).replace('<head>', '<head>\n  <base href="../">');
  fs.writeFileSync(retainedContextFixture, renderFixture('retained'));
  fs.writeFileSync(staleContextFixture, renderFixture('stale'));
  fs.writeFileSync(cadenceFixture, generateHTML(newsItems, {
    generatedAt: new Date('2026-08-14T10:00:00.000Z'),
    retainedIssueDates: ['2026-08-13', '2026-08-14'],
  }).replace('<head>', '<head>\n  <base href="../">'));
  fs.writeFileSync(cveHandoffFixture, generateHTML([{
    ...newsItems[0],
    title: 'CVE-2026-59310 exploited in active intrusions',
    link: 'https://publisher.example/cve-2026-59310',
    source: 'Publisher Example',
    summary: 'Incident response teams are investigating active exploitation and stolen credentials.',
  }], {
    generatedAt: new Date('2026-08-14T10:00:00.000Z'),
    currentInsightCves: ['CVE-2026-59310'],
    retainedIssueDates: ['2026-08-13', '2026-08-14'],
  }).replace('<head>', '<head>\n  <base href="../">'));
  fs.writeFileSync(summaryBehaviorFixture, generateHTML([{
    ...newsItems[0],
    link: 'https://publisher.example/security-story',
    source: 'Publisher Example',
    summary: 'Responders are still tracing the campaign across affected organizations…',
  }], {
    generatedAt: new Date('2026-08-14T10:00:00.000Z'),
    retainedIssueDates: ['2026-08-13', '2026-08-14'],
  }).replace('<head>', '<head>\n  <base href="../">'));
  fs.writeFileSync(sourceHealthFixture, generateHTML([newsItems[0]], {
    generatedAt: new Date('2026-08-14T10:00:00.000Z'),
    sourceHealth: [
      {
        name: newsItems[0].source,
        itemCount: 1,
        lastContributedAt: '2026-08-14T09:00:00.000Z',
      },
      {
        name: 'Quiet Source',
        itemCount: 0,
        lastContributedAt: '2026-08-10T10:00:00.000Z',
      },
    ],
    retainedIssueDates: ['2026-08-13', '2026-08-14'],
  }).replace('<head>', '<head>\n  <base href="../">'));
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
  const firstCardId = await cards.first().getAttribute('id');
  const permalink = cards.first().locator('a.item-permalink');
  await expect(permalink).toBeVisible();
  await expect(permalink).toHaveAccessibleName('Permalink to this reporting item');
  await expect(permalink).toHaveAttribute('href', `#${firstCardId}`);
  await permalink.click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#${firstCardId}`);

  const themeToggle = page.locator('#themeToggle');
  await themeToggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/);

  await page.locator('.source-coverage-summary').click();
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
  if ((await continuations.count()) > 0) {
    const continuation = continuations.first();
    const continuationCard = continuation.locator('xpath=ancestor::article[1]');
    await expect(continuation).toHaveAttribute('href', await continuationCard.locator('.news-title a').getAttribute('href'));
    await expect(continuation).toHaveAccessibleName(/^Continue reading at /);
  }

  await expect(page.locator('a.handoff-cue').first()).toHaveAttribute('href', /SentryInsight|GRCInsight/);
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-desktop.png'), fullPage: true });
});

test('defaults to light when the operating system prefers dark', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.goto('/');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-desktop-light.png'), fullPage: true });
  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await context.close();
});

test('default digest avoids the generic dashboard visual tells', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const response = await page.goto('/');

  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('#advancedFilters')).not.toHaveAttribute('open', '');
  await expect(page.locator('.source-coverage-details')).not.toHaveAttribute('open', '');
  await expect(page.locator('#filterInsights')).toBeHidden();
  const visualSignals = await page.evaluate(() => {
    const visibleElements = Array.from(document.querySelectorAll('body *')).filter((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    });
    return {
      bodyBackgroundImage: getComputedStyle(document.body).backgroundImage,
      headerBackgroundImage: getComputedStyle(document.querySelector('header')).backgroundImage,
      fontFamilies: Array.from(new Set(visibleElements.map((element) => getComputedStyle(element).fontFamily))),
      fontSizes: Array.from(new Set(visibleElements.map((element) => getComputedStyle(element).fontSize))),
      borderedElements: visibleElements.filter((element) => {
        const style = getComputedStyle(element);
        return style.borderTopStyle !== 'none' && Number.parseFloat(style.borderTopWidth) > 0;
      }).length,
    };
  });

  expect(visualSignals.bodyBackgroundImage).toBe('none');
  expect(visualSignals.headerBackgroundImage).toBe('none');
  expect(visualSignals.fontFamilies).toHaveLength(1);
  expect(visualSignals.fontSizes.length).toBeLessThanOrEqual(3);
  expect(visualSignals.borderedElements).toBeLessThanOrEqual(20);
  const sourceChips = await page.locator('article.news-item .source-chip').allTextContents();
  expect(sourceChips.length).toBeGreaterThan(0);
  expect(sourceChips.every((label) => !label.includes('.com'))).toBe(true);

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const darkLaneHeading = await page.locator('.operator-lane-heading').first().evaluate((element) => {
    const headingColor = getComputedStyle(element).color;
    const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const textTransform = getComputedStyle(element).textTransform;
    return { accentColor, headingColor, textTransform };
  });
  expect(darkLaneHeading.headingColor).toBe('rgb(96, 165, 250)');
  expect(darkLaneHeading.accentColor).toBe('#60a5fa');
  expect(darkLaneHeading.textTransform).toBe('none');
});

test('CVE handoff links do not depend on the daily feed mix', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const response = await page.goto('http://127.0.0.1:4173/test-results/cve-handoff.html');

  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('a.handoff-cue[href*="#cve-"]')).toHaveAttribute(
    'href',
    /SentryInsight\/#cve-2026-59310$/,
  );
  await context.close();
});

test('quiet-source behavior does not depend on the daily feed mix', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  const response = await page.goto('http://127.0.0.1:4173/test-results/source-health.html');

  expect(response?.ok()).toBeTruthy();
  const coverage = page.locator('.source-health-summary');
  await expect(coverage).toHaveAttribute('data-active-sources', '1');
  await expect(coverage).toHaveAttribute('data-quiet-sources', '1');
  const quietSource = page.locator('.source-health-note[data-health-status="quiet"]');
  await expect(quietSource).toContainText(/Quiet Source quiet since .* UTC/);
  await expect(page.locator('[data-source-filter="Quiet Source"]')).toHaveCount(0);
  expect(runtimeFailures).toEqual([]);
  await context.close();
});

test('mobile digest has no horizontal overflow', async ({ page }) => {
  const runtimeFailures = observeRuntimeFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const response = await page.goto('/');

  expect(response?.ok()).toBeTruthy();
  await expect(page.locator('article.news-item').first()).toBeVisible();
  const firstCard = page.locator('article.news-item').first();
  const firstCardId = await firstCard.getAttribute('id');
  await expect(firstCard.locator('a.item-permalink')).toHaveAttribute('href', `#${firstCardId}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const firstCardTop = await firstCard.evaluate((element) => element.getBoundingClientRect().top);
  expect(firstCardTop).toBeLessThan(844);
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-mobile.png'), fullPage: true });
});

test('pre-rendered cards remain readable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  const response = await page.goto('http://127.0.0.1:4173/');

  expect(response?.ok()).toBeTruthy();
  expect(await page.locator('article.news-item').count()).toBeGreaterThan(0);
  await expect(page.locator('article.news-item').first()).toBeVisible();
  const firstCard = page.locator('article.news-item').first();
  const firstCardId = await firstCard.getAttribute('id');
  await expect(firstCard.locator('a.item-permalink')).toHaveAttribute('href', `#${firstCardId}`);
  await expect(page.locator('.issue-trail-cadence')).toHaveAttribute('data-cadence-state', 'scheduled');
  await expect(page.locator('[data-cadence-label]')).toHaveText('3h cadence');
  const previousIssues = page.locator('a.previous-issues');
  await expect(previousIssues).toBeVisible();
  await previousIssues.click();
  await expect(page.locator('h1')).toHaveText('Previous issues');
  await expect(page.locator('main ol a').first()).toBeVisible();
  expect(runtimeFailures).toEqual([]);
  await context.close();
});

test('summary continuation behavior does not depend on the daily feed mix', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  await context.route('https://publisher.example/security-story', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Publisher story</title>' });
  });
  const response = await page.goto('http://127.0.0.1:4173/test-results/summary-behavior.html');

  expect(response?.ok()).toBeTruthy();
  const continuation = page.locator('a.summary-continuation');
  await expect(continuation).toBeVisible();
  await expect(continuation).toHaveAccessibleName('Continue reading at Publisher Example');
  await expect(continuation).toHaveAttribute('href', 'https://publisher.example/security-story');
  const destinationPromise = context.waitForEvent('page');
  await continuation.click();
  const destination = await destinationPromise;
  await expect(destination).toHaveURL('https://publisher.example/security-story');
  await destination.close();
  expect(runtimeFailures).toEqual([]);
  await context.close();
});

test('cadence stays current at the exact schedule boundary', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  await page.clock.setFixedTime('2026-08-14T13:00:00.000Z');
  const response = await page.goto('http://127.0.0.1:4173/test-results/cadence.html');

  expect(response?.ok()).toBeTruthy();
  const cadence = page.locator('.issue-trail-cadence');
  await expect(cadence).toHaveAttribute('data-cadence-state', 'current');
  await expect(cadence.locator('[data-cadence-label]')).toHaveText('3h cadence');
  expect(runtimeFailures).toEqual([]);
  await context.close();
});

test('an open digest names when its cadence falls behind', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  await page.clock.install({ time: '2026-08-14T12:59:30.000Z' });
  const response = await page.goto('http://127.0.0.1:4173/test-results/cadence.html');

  expect(response?.ok()).toBeTruthy();
  const cadence = page.locator('.issue-trail-cadence');
  await expect(cadence).toHaveAttribute('data-cadence-state', 'current');
  await page.clock.runFor('01:30');
  await expect(cadence).toHaveAttribute('data-cadence-state', 'overdue');
  await expect(cadence.locator('[data-cadence-label]')).toHaveText('running behind its 3h cadence');
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-overdue-cadence.png'), fullPage: true });
  await context.close();
});

test('retained upstream context stays visible without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  const response = await page.goto('http://127.0.0.1:4173/test-results/retained-context.html');

  expect(response?.ok()).toBeTruthy();
  const contextLine = page.locator('.insight-context[data-context-mode="retained"]');
  await expect(contextLine).toBeVisible();
  await expect(contextLine).toContainText('SentryInsight context retained as of');
  await expect(contextLine.locator('time')).toContainText('UTC');
  const reportLink = contextLine.locator('a.insight-context-link');
  await expect(reportLink).toHaveAttribute('href', 'https://ricomanifesto.github.io/SentryInsight/');
  await expect(reportLink).toHaveAttribute('rel', 'noopener noreferrer');
  expect(runtimeFailures).toEqual([]);
  await context.close();
});

test('first degraded day stays actionable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US', timezoneId: 'UTC' });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  const response = await page.goto('http://127.0.0.1:4173/test-results/stale-context.html');

  expect(response?.ok()).toBeTruthy();
  const contextLine = page.locator('.insight-context[data-context-mode="stale"]');
  await expect(contextLine).toBeVisible();
  await expect(contextLine).toContainText('is stale; CVE handoffs use the first-mentioned CVE');
  await expect(contextLine.locator('a.insight-context-link')).toHaveAttribute(
    'href',
    'https://ricomanifesto.github.io/SentryInsight/',
  );
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({ path: path.join(screenshotDirectory, 'digest-stale-context.png'), fullPage: true });
  await context.close();
});

test('dated digest context resolves stable item links without JavaScript', async ({ browser }) => {
  const archiveRoot = path.join(process.cwd(), 'archive');
  const issueDate = fs.readdirSync(archiveRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .at(-1);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(archiveRoot, issueDate, 'index.json'), 'utf8')
  );
  const article = manifest.articles[0];
  expect(manifest.schema_version).toBe(2);
  expect(manifest.insight_context).toMatchObject({
    schema_version: 2,
  });
  const insightMode = manifest.insight_context.mode;
  expect(['current', 'retained', 'stale', 'unavailable']).toContain(insightMode);
  expect(manifest.insight_context.report_url).toBe(
    insightMode === 'unavailable'
      ? null
      : 'https://ricomanifesto.github.io/SentryInsight/',
  );
  const context = await browser.newContext({
    javaScriptEnabled: false,
    locale: 'en-US',
    timezoneId: 'UTC',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const runtimeFailures = observeRuntimeFailures(page);
  const response = await page.goto(
    `http://127.0.0.1:4173/archive/${issueDate}/#${article.id}`
  );

  expect(response?.ok()).toBeTruthy();
  await expect(page.locator(`#${article.id}`)).toBeVisible();
  await expect(page.locator(`#${article.id} a`).first()).toHaveAttribute('href', article.link);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(runtimeFailures).toEqual([]);
  await page.screenshot({
    path: path.join(screenshotDirectory, 'digest-archive-mobile.png'),
    fullPage: true,
  });
  await context.close();
});
