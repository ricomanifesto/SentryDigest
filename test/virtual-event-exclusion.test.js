const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { collectNewsDataFailures } = require('../scripts/news-data-contract');
const { fetchNewsSnapshot, writeGeneratedNewsArtifacts } = require('../scripts/fetch-news');
const { generateRSSFeed } = require('../scripts/generate-rss');
const { writeDigestArchive, renderArchivePage } = require('../scripts/digest-archive');
const { generateHTML } = require('../scripts/render-news-html');
const { validateArtifacts } = require('../scripts/validate-artifacts');

const ARTICLE = {
  title: 'Security analysis of attacks during virtual events',
  summary: 'Researchers discussed event security at a conference.',
  link: 'https://example.com/security-analysis',
  date: '2026-09-08T12:00:00.000Z',
  firstSeen: '2026-09-08T13:00:00.000Z',
  source: 'Security News',
};
const CONTEXT = {
  schema_version: 2,
  mode: 'unavailable',
  checked_at: '2026-09-08T14:00:00.000Z',
  report_date: null,
  manifest_generated_at: null,
  report_url: null,
};
const MARKERS = [
  '[Virtual Event]', '[ vIrTuAl\t\n eVeNt ]', '&#91;Virtual&nbsp;Event&#93;',
  '&lbrack;Virtual&#10;Event&rbrack;', '&amp;#91;Virtual&amp;nbsp;Event&amp;#93;',
  '\\[Virtual Event\\]', '\\[ Virtual\nEvent \\]', '&#92;&#91;Virtual Event&#92;&#93;',
  '[<strong>Virtual</strong> Event]', '[Virtual<br>Event]',
];
const PROMOTIONS = [
  ...MARKERS.map((marker) => ({ ...ARTICLE, title: `${marker} Cloud security session` })),
  ...MARKERS.map((marker) => ({ ...ARTICLE, summary: `Register for ${marker}` })),
  { ...ARTICLE, link: 'https://www.darkreading.com/events/virtual-event-cloud-2026' },
  { ...ARTICLE, link: 'https://DARKREADING.com/events/%76irtual-event-cloud-2026?source=rss#register' },
];
const logger = { log() {}, error() {} };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-exclusion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    sources: [{ name: ARTICLE.source, type: 'rss', enabled: true, url: 'https://example.com/feed.xml' }],
    settings: { maxNewsItems: 30, lastUpdated: '2026-09-08T14:00:00.000Z' },
  };
  const paths = Object.fromEntries(['index.html', 'news-data.json', 'feed.xml', 'feed-info.json', 'config.json']
    .map((file) => [file, path.join(root, file)]));
  fs.writeFileSync(paths['config.json'], JSON.stringify(config));
  return { root, paths, config };
}

for (const [index, promotion] of PROMOTIONS.entries()) {
  test(`canonical contract rejects whole promotion variant ${index + 1}`, () => {
    assert.match(collectNewsDataFailures([promotion]).join('; '), /virtual.event promotion/i);
  });
}

test('generic event reporting and unrelated URLs remain legitimate articles', () => {
  for (const item of [
    ARTICLE,
    { ...ARTICLE, title: '[Event Security] Analysis of virtual events' },
    { ...ARTICLE, link: 'https://www.darkreading.com/attacks-breaches/event-security' },
    { ...ARTICLE, link: 'https://example.com/events/virtual-event-research' },
    { ...ARTICLE, link: 'https://www.darkreading.com.evil.example/events/virtual-event-promo' },
    { ...ARTICLE, title: 'Threat report <script>[Virtual Event]</script>' },
  ]) assert.deepEqual(collectNewsDataFailures([item]), []);
});

test('promotions are removed before ranking, cap and source contribution accounting', async () => {
  const sourceConfig = { enabledRssSources: [{ name: ARTICLE.source }, { name: 'Promotions Only' }], maxNewsItems: 1 };
  const snapshot = await fetchNewsSnapshot({
    sourceConfig, logger,
    fetchFeed: async (source) => source.name === ARTICLE.source
      ? [{ ...PROMOTIONS[0], date: new Date('2026-11-12') }, { ...ARTICLE, date: new Date(ARTICLE.date) }]
      : [{ ...PROMOTIONS[1], source: source.name, date: new Date('2026-11-13') }],
  });
  assert.deepEqual(snapshot.newsItems, [{ ...ARTICLE, date: new Date(ARTICLE.date) }]);
  assert.deepEqual(snapshot.sourceContributions, [
    { name: ARTICLE.source, lastContributedAt: ARTICLE.date },
    { name: 'Promotions Only', lastContributedAt: null },
  ]);
});

test('a successful but all-excluded fetch aborts without claiming a source outage', async () => {
  await assert.rejects(fetchNewsSnapshot({
    sourceConfig: { enabledRssSources: [{ name: ARTICLE.source }], maxNewsItems: 30 },
    fetchFeed: async () => PROMOTIONS, logger,
  }), /no publishable news/i);
});

test('empty canonical data cannot replace valid nonempty artifacts', () => {
  assert.match(collectNewsDataFailures([]).join('; '), /non-empty/);
});

for (const items of [[PROMOTIONS[0]], [ARTICLE, { ...PROMOTIONS[2], link: 'https://example.com/promotion' }], []]) {
  test(`news and RSS writers reject excluded or empty input before any writes (${items.length})`, (t) => {
    const { config, paths } = fixture(t);
    fs.writeFileSync(paths['news-data.json'], JSON.stringify(items));
    for (const file of ['index.html', 'feed.xml', 'feed-info.json']) fs.writeFileSync(paths[file], 'existing artifact');
    const before = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, fs.readFileSync(file)]));
    const beforeConfig = structuredClone(config);
    assert.throws(() => writeGeneratedNewsArtifacts({
      newsItems: items,
      sourceConfig: { config, enabledRssSources: config.sources, maxNewsItems: 30 },
      indexHtmlPath: paths['index.html'], newsDataPath: paths['news-data.json'], configPath: paths['config.json'],
      now: new Date('2026-09-08T14:00:00.000Z'), logger,
    }), /virtual.event promotion|non-empty/i);
    assert.deepEqual(config, beforeConfig);
    assert.throws(() => generateRSSFeed({
      newsDataPath: paths['news-data.json'], configPath: paths['config.json'],
      rssOutputPath: paths['feed.xml'], feedInfoPath: paths['feed-info.json'], logger,
    }), /virtual.event promotion|non-empty/i);
    for (const [key, file] of Object.entries(paths)) assert.deepEqual(fs.readFileSync(file), before[key]);
  });
}

test('archive input rejects promotions before creating an issue or changing retained output', (t) => {
  const { root } = fixture(t);
  for (const newsItems of [[PROMOTIONS[0]], []]) {
    assert.throws(() => writeDigestArchive({
      newsItems, outputRoot: root, generatedAt: CONTEXT.checked_at, insightContext: CONTEXT,
    }), /virtual.event promotion|non-empty/i);
    assert.equal(fs.existsSync(path.join(root, 'archive')), false);
  }
});

test('archive accumulation cannot silently retain an old tagged promotion', (t) => {
  const { root } = fixture(t);
  writeDigestArchive({ newsItems: [ARTICLE], outputRoot: root, generatedAt: CONTEXT.checked_at, insightContext: CONTEXT });
  const manifestPath = path.join(root, 'archive/2026-09-08/index.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.articles[0].title = PROMOTIONS[0].title;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = fs.readFileSync(manifestPath);
  assert.throws(() => writeDigestArchive({
    newsItems: [{ ...ARTICLE, link: 'https://example.com/another' }], outputRoot: root,
    generatedAt: CONTEXT.checked_at, insightContext: CONTEXT,
  }), /virtual.event promotion/i);
  assert.deepEqual(fs.readFileSync(manifestPath), before);
});

test('direct HTML builders cannot present excluded promotions as news', () => {
  assert.throws(() => generateHTML([PROMOTIONS[0]]), /virtual.event promotion/i);
  assert.throws(() => renderArchivePage({
    schema_version: 1, issue_date: '2026-09-08', articles: [PROMOTIONS[0]],
  }), /virtual.event promotion/i);
});

test('public validation rejects tagged records added to archived JSON', (t) => {
  const { root } = fixture(t);
  writeDigestArchive({ newsItems: [ARTICLE], outputRoot: root, generatedAt: CONTEXT.checked_at, insightContext: CONTEXT });
  const manifestPath = path.join(root, 'archive/2026-09-08/index.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.articles[0].title = PROMOTIONS[0].title;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.match(validateArtifacts(root).failures.join('; '), /archive.*virtual.event promotion/i);
});

for (const surface of ['index.html', 'feed.xml', 'archive/2026-09-08/index.html']) {
  test(`public validation rejects a promotion in ${surface} even without canonical data drift`, (t) => {
    const { root, paths } = fixture(t);
    fs.writeFileSync(paths['news-data.json'], JSON.stringify([ARTICLE]));
    fs.writeFileSync(paths['index.html'], generateHTML([ARTICLE]));
    generateRSSFeed({
      newsDataPath: paths['news-data.json'], configPath: paths['config.json'],
      rssOutputPath: paths['feed.xml'], feedInfoPath: paths['feed-info.json'], logger,
    });
    writeDigestArchive({ newsItems: [ARTICLE], outputRoot: root, generatedAt: CONTEXT.checked_at, insightContext: CONTEXT });
    const output = path.join(root, surface);
    fs.writeFileSync(output, fs.readFileSync(output, 'utf8').replaceAll(ARTICLE.title, '[Virtual Event] Register now'));
    assert.match(validateArtifacts(root).failures.join('; '), /virtual.event promotion/i);
  });
}
