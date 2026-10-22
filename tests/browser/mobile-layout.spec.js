const fs = require('node:fs');
const path = require('node:path');
const { expect, test } = require('@playwright/test');
const { generateHTML } = require('../../scripts/render-news-html');

const generatedAt = new Date('2026-10-19T12:26:18.010Z');
const retainedIssueDates = ['2026-10-18', '2026-10-19'];
const context = {
  schema_version: 2,
  checked_at: '2026-10-19T12:26:17.018Z',
  report_date: '2026-10-06',
  manifest_generated_at: '2026-10-06T00:51:11Z',
  report_url: 'https://ricomanifesto.github.io/SentryInsight/',
};
const article = (title, index) => ({
  title,
  link: `https://publisher.example/report-${index}`,
  date: '2026-10-19T10:00:00.000Z',
  source: 'Example',
  summary: 'Security teams are reviewing the latest development.',
});
const longArticles = [
  article(`Ransomware breach CVE-2026-59310 actively exploited: ${'responders investigate affected organizations and stolen credentials '.repeat(8)} ${'identifier'.repeat(20)}`, 1),
  article(`Compliance audit and privacy regulation: ${'governance teams review reporting requirements across affected organizations '.repeat(8)}`, 2),
];
// Public headlines and the stale-context stamp from the last published issue.
const observedArticles = [
  article('Unpatched Broadcom Wi-Fi Flaw Lets Attackers in Range Run Code as Root on Routers', 3),
  article('OpenCode Console Breach May Have Exposed OpenAI, Anthropic, and Google API Keys', 4),
];
const scenarios = [
  { name: 'long lane headlines', articles: longArticles },
  { name: 'retained context', articles: longArticles, mode: 'retained' },
  { name: 'stale context', articles: longArticles, mode: 'stale' },
  { name: 'retained issue with stale context', articles: longArticles, mode: 'stale', view: { kind: 'issue', issueDate: '2026-10-19' } },
  { name: 'observed headline mix and stale context', articles: observedArticles, mode: 'stale' },
];
const screenshotDirectory = path.join(process.cwd(), 'test-results/screenshots');

function renderScenario(scenario) {
  return generateHTML(scenario.articles, {
    generatedAt, retainedIssueDates, view: scenario.view,
    insightContext: scenario.mode ? { ...context, mode: scenario.mode } : undefined,
  });
}

for (const javaScriptEnabled of [true, false]) {
  test.describe(`mobile layout ${javaScriptEnabled ? 'with' : 'without'} JavaScript`, () => {
    test.use({ javaScriptEnabled, viewport: { width: 390, height: 844 } });

    for (const scenario of scenarios) {
      test(`${scenario.name} keeps reporting in the first viewport`, async ({ page }) => {
        const failures = [];
        page.on('pageerror', error => failures.push(error.message));
        // An overdue cadence label must remain truthful and fit alongside context.
        if (javaScriptEnabled) await page.clock.setFixedTime('2026-10-22T12:00:00.000Z');
        await page.route('http://127.0.0.1:4173/', route => route.fulfill({
          contentType: 'text/html',
          body: renderScenario(scenario),
        }));
        await page.goto('/');
        const firstCard = page.locator('article.news-item').first();
        const firstCardTop = await firstCard.evaluate(element => element.getBoundingClientRect().top);
        expect(firstCardTop).toBeLessThan(844);
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(await overflow()).toBeLessThanOrEqual(1);
        console.log(`${javaScriptEnabled ? 'JS' : 'No JS'} / ${scenario.name}: first card ${firstCardTop.toFixed(2)}px, overflow ${await overflow()}px`);
        await expect(firstCard).toBeInViewport();
        await expect(page.locator('.previous-issues')).toBeVisible();
        if (scenario.mode) {
          const status = page.locator('.insight-context');
          await expect(status).toBeVisible();
          await expect(status).toHaveAttribute('data-context-mode', scenario.mode);
          await expect(status).toContainText(scenario.mode === 'retained' ? 'retained as of' : 'is stale');
          await expect(status.locator('time')).toHaveAttribute('datetime', context.manifest_generated_at);
        }
        if (javaScriptEnabled && !scenario.view) {
          await expect(page.locator('[data-cadence-label]')).toHaveText('running behind its 3h cadence');
        }

        const scan = page.locator('#operatorScan');
        await expect(scan).not.toHaveAttribute('open', '');
        if (javaScriptEnabled && scenario.name === 'stale context') {
          fs.mkdirSync(screenshotDirectory, { recursive: true });
          await page.screenshot({ path: path.join(screenshotDirectory, 'layout-mobile-collapsed.png') });
        }
        const summary = scan.locator('summary');
        await expect(summary).toHaveAccessibleName('Operator scan lanes');
        await summary.focus();
        await page.keyboard.press('Enter');
        await expect(scan).toHaveAttribute('open', '');
        const links = scan.locator('[data-lane-link]');
        const expectedStories = scenario.articles === longArticles
          ? [longArticles[0], longArticles[0], longArticles[1]]
          : [observedArticles[1], observedArticles[0]];
        await expect(links).toHaveCount(expectedStories.length);
        await expect(links.first()).toBeVisible();
        for (const [index, story] of expectedStories.entries()) {
          await expect(links.nth(index)).toHaveText(story.title);
          await expect(links.nth(index)).toHaveAttribute('href', story.link);
        }
        expect(await overflow()).toBeLessThanOrEqual(1);

        if (javaScriptEnabled) {
          await page.locator('#search').fill('no matching story');
          await expect(page.locator('#emptyFilteredState')).toBeVisible();
          await page.locator('#emptyResetFilters').click();
          await expect(page.locator('article.news-item:visible')).toHaveCount(scenario.articles.length);
        }
        expect(failures).toEqual([]);
      });
    }
  });
}

test('desktop starts with scan lanes expanded and lets the reader collapse them', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.clock.setFixedTime('2026-10-22T12:00:00.000Z');
  await page.route('http://127.0.0.1:4173/', route => route.fulfill({
    contentType: 'text/html', body: renderScenario(scenarios.at(-1)),
  }));
  await page.goto('/');
  const scan = page.locator('#operatorScan');
  await expect(scan).toHaveAttribute('open', '');
  await expect(scan.locator('[data-lane-link]').first()).toBeVisible();
  await expect(page.locator('.insight-context')).toContainText('is stale');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, 'layout-desktop-expanded.png') });
  await scan.locator('summary').click();
  await expect(scan).not.toHaveAttribute('open', '');
  await expect(scan.locator('[data-lane-link]').first()).toBeHidden();
});
