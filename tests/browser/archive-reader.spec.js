const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { generateHTML } = require('../../scripts/render-news-html');
const { renderArchivePage, renderArchiveIndex } = require('../../scripts/digest-archive');
const { articleFragment } = require('../../scripts/reporting-identity');

const dates = ['2026-10-03', '2026-10-04', '2026-10-05'];
const articles = [
  { title: 'NetScaler CVE-2026-88779 actively exploited', summary: 'Incident response teams investigate stolen credentials.', link: 'https://publisher.example/netscaler', date: '2026-10-04T13:00:00Z', source: 'Example' },
  { title: 'tenfold Identity Governance adds features', summary: 'Governance tools update.', link: 'https://publisher.example/tenfold', date: '2026-10-04T12:00:00Z', source: 'Example' },
  { title: 'Other incident CVE-2026-11111 actively exploited', summary: 'Incident response investigation.', link: 'https://publisher.example/other', date: '2026-10-04T11:00:00Z', source: 'Other' },
];
const generatedAt = new Date('2026-10-05T09:00:00Z');

async function readerFixtures(context) {
  await context.route(/^http:\/\/127\.0\.0\.1:4173\/(?:\?.*)?$/,  route => route.fulfill({ contentType: 'text/html', body: generateHTML(articles, {
    generatedAt, retainedIssueDates: dates, currentInsightCves: ['CVE-2026-88779', 'CVE-2026-11111'],
  }) }));
  await context.route('http://127.0.0.1:4173/archive/', route => route.fulfill({ contentType: 'text/html', body: renderArchiveIndex(dates.map(issue_date => ({ issue_date, article_count: 3 }))) }));
  await context.route(/\/archive\/2026-10-0[345]\//, route => {
    const date = new URL(route.request().url()).pathname.split('/')[2];
    return route.fulfill({ contentType: 'text/html', body: renderArchivePage({ schema_version: 1, issue_date: date, generated_at: `${date}T15:00:00Z`, articles: articles.map(article => ({ ...article, id: articleFragment(article.link) })) }, dates) });
  });
}

for (const width of [1440, 390]) {
  test(`theme and reader interactions survive archive navigation at ${width}px`, async ({ context, page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width, height: 900 });
    await readerFixtures(context);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#search').fill('NetScaler');
    await expect(page.locator('article.news-item:visible')).toHaveCount(1);
    await expect(page).toHaveURL(/q=NetScaler/);
    await page.locator('#themeToggle').click();
    await page.locator('.previous-issues').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('link', { name: 'October 4, 2026', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.subtitle')).toHaveText('Digest for October 4, 2026');
    await expect(page.locator('.brand img')).toBeVisible();
    await expect.poll(() => page.locator('.brand img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.locator('#search').fill('missing result');
    await expect(page.locator('#emptyFilteredState')).toBeVisible();
    await page.locator('#emptyResetFilters').click();
    await expect(page.locator('#search')).toBeFocused();
    await expect(page.locator('article.news-item:visible')).toHaveCount(3);
    await page.locator('#sourceFilter').selectOption('Other');
    await expect(page.locator('article.news-item:visible')).toHaveCount(1);
    await page.locator('#resetFilters').click();
    await page.locator('#search').fill('NetScaler');
    await expect(page.locator('article.news-item:visible')).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear Search: NetScaler filter' }).click();
    await expect(page.locator('article.news-item:visible')).toHaveCount(3);
    await expect(page.locator('a[rel="prev"]')).toContainText('Previous issue');
    await page.locator('a[rel="next"]').click();
    await expect(page.locator('.subtitle')).toHaveText('Digest for October 5, 2026');
    await expect(page.locator('a[rel="next"]')).toHaveCount(0);
    await page.goBack();
    await page.goBack();
    await page.goBack();
    await expect(page.locator('#search')).toHaveValue('NetScaler');
    await expect(page.locator('article.news-item:visible')).toHaveCount(1);
    await page.goto('/archive/2026-10-04/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    fs.mkdirSync(path.join(process.cwd(), 'test-results/screenshots'), { recursive: true });
    await page.screenshot({ path: `test-results/screenshots/archive-reader-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('filtered lane follows the visible CVE and general destinations disclose their scope', async ({ context, page }) => {
  await readerFixtures(context);
  await page.goto('/');
  const lane = page.locator('[data-lane-cue="SentryInsight: incident watch"]');
  await expect(lane.locator('[data-lane-destination]')).toHaveAttribute('href', /#cve-2026-88779$/);
  await page.locator('#search').fill('Other incident');
  await expect(lane.locator('[data-lane-destination]')).toHaveAttribute('href', /#cve-2026-11111$/);
  await expect(lane.locator('[data-lane-destination]')).toContainText('CVE analysis: CVE-2026-11111');
  await context.route('https://ricomanifesto.github.io/SentryInsight/', route => route.fulfill({ contentType: 'text/html', body: '<h1 id="cve-2026-11111">Matching finding</h1>' }));
  const findingOpened = context.waitForEvent('page');
  await lane.locator('[data-lane-destination]').click();
  const finding = await findingOpened;
  await expect(finding).toHaveURL('https://ricomanifesto.github.io/SentryInsight/#cve-2026-11111');
  await expect(finding.locator('#cve-2026-11111')).toBeVisible();
  await finding.close();
  await page.locator('#resetFilters').click();
  await page.locator('#search').fill('tenfold');
  const grc = page.locator('article.news-item:visible a.handoff-cue[href*="GRCInsight"]');
  await expect(grc).toContainText('general report');
  await context.route('https://ricomanifesto.github.io/GRCInsight/', route => route.fulfill({ contentType: 'text/html', body: '<h1>General report</h1>' }));
  const opened = context.waitForEvent('page');
  await grc.click();
  const destination = await opened;
  await expect(destination).toHaveURL('https://ricomanifesto.github.io/GRCInsight/');
  await destination.close();
  await page.locator('#search').fill('no such article');
  await expect(lane.locator('[data-lane-destination]')).not.toHaveAttribute('href');
});

test('retained issue keeps source, full summary, identity and adjacent links without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  await readerFixtures(context);
  const page = await context.newPage();
  await page.goto(`/archive/2026-10-04/#${articleFragment(articles[0].link)}`);
  const card = page.locator(`#${articleFragment(articles[0].link)}`);
  await expect(card).toBeVisible();
  await expect(card.locator('.news-title a')).toHaveAttribute('href', articles[0].link);
  await expect(card.locator('.news-summary')).toHaveText(articles[0].summary);
  await page.locator('a[rel="prev"]').click();
  await expect(page.locator('.subtitle')).toHaveText('Digest for October 3, 2026');
  await context.close();
});
