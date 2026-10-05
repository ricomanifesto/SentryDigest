const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cheerio = require('cheerio');
const { renderArchivePage, renderArchiveIndex, refreshArchivePresentation } = require('../scripts/digest-archive');
const { generateHTML } = require('../scripts/render-news-html');
const { articleFragment } = require('../scripts/reporting-identity');

const article = {
  title: 'NetScaler CVE-2026-88779 actively exploited',
  summary: 'Incident response teams investigate stolen credentials.',
  link: 'https://example.com/netscaler', source: 'Example', date: '2026-10-04T12:00:00.000Z',
};
const manifest = {
  schema_version: 1, issue_date: '2026-10-04', generated_at: '2026-10-04T15:00:00.000Z',
  articles: [{ ...article, id: articleFragment(article.link) }],
};

test('retained issues share reader controls and preserve dated evidence identity', () => {
  const $ = cheerio.load(renderArchivePage(manifest, ['2026-10-03', '2026-10-04', '2026-10-05']));
  for (const selector of ['#search', '#sourceFilter', '#themeToggle', '#resetFilters', '#emptyResetFilters']) {
    assert.equal($(selector).length, 1, selector);
  }
  assert.equal($('link[rel="canonical"]').attr('href'), 'https://ricomanifesto.github.io/SentryDigest/archive/2026-10-04/');
  assert.equal($('article.news-item').attr('id'), manifest.articles[0].id);
  assert.equal($('.news-title a').attr('href'), article.link);
  assert.equal($('.news-title a').text(), article.title);
  assert.equal($('.news-summary').text().trim(), article.summary);
  assert.equal($('.item-permalink').attr('href'), `#${manifest.articles[0].id}`);
  assert.equal($('a[rel="prev"]').attr('href'), '../2026-10-03/');
  assert.equal($('a[rel="next"]').attr('href'), '../2026-10-05/');
  assert.equal($('.brand img').attr('src'), '../../assets/icon.svg');
  assert.equal($('.issue-trail-cadence').length, 0);
  assert.match($('.issue-strip').text(), /Retained issue/);
  assert.match($('.handoff-cue').first().text(), /CVE reference/);
});

test('archive index shares brand and theme with static issue links', () => {
  const $ = cheerio.load(renderArchiveIndex([{ issue_date: '2026-10-04', article_count: 1 }]));
  assert.equal($('#themeToggle').length, 1);
  assert.equal($('.brand img').attr('src'), '../assets/icon.svg');
  assert.equal($('h1').text(), 'Previous issues');
  assert.equal($('main ol a').attr('href'), './2026-10-04/');
  assert.equal($('#search').length, 0);
});

test('presentation refresh leaves all historical JSON bytes unchanged and updates adjacent navigation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-refresh-'));
  const before = new Map();
  for (const date of ['2026-10-03', '2026-10-04', '2026-10-05']) {
    const dir = path.join(root, 'archive', date);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.json');
    const data = JSON.stringify({ ...manifest, issue_date: date, generated_at: `${date}T15:00:00.000Z` });
    fs.writeFileSync(file, data);
    before.set(file, data);
  }
  refreshArchivePresentation(root);
  for (const [file, bytes] of before) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const first = cheerio.load(fs.readFileSync(path.join(root, 'archive/2026-10-03/index.html'), 'utf8'));
  assert.equal(first('a[rel="prev"]').length, 0);
  assert.equal(first('a[rel="next"]').attr('href'), '../2026-10-04/');
  const last = cheerio.load(fs.readFileSync(path.join(root, 'archive/2026-10-05/index.html'), 'utf8'));
  assert.equal(last('a[rel="next"]').length, 0);
});

test('handoff labels distinguish general reports, verified CVEs, and unverified references', () => {
  const governance = { ...article, title: 'tenfold Identity Governance adds features', summary: 'Governance tooling update.' };
  for (const [cves, expected] of [[null, 'CVE reference'], [[], 'general report'], [['CVE-2026-88779'], 'CVE analysis']]) {
    const $ = cheerio.load(generateHTML([article, governance], { generatedAt: new Date(manifest.generated_at), currentInsightCves: cves }));
    const incident = $('.handoff-cue').filter((_, el) => $(el).text().includes('incident watch')).first();
    assert.match(incident.text(), new RegExp(expected));
    if (cves?.length) assert.match(incident.attr('href'), /#cve-2026-88779$/);
    const grc = $('.handoff-cue[href="https://ricomanifesto.github.io/GRCInsight/"]');
    assert.match(grc.text(), /general report/);
    assert.match($('[data-lane="Governance watch"] [data-lane-destination]').text(), /general report/);
  }
});
