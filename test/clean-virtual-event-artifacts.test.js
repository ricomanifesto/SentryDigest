const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const cheerio = require('cheerio');
const { validateArtifacts } = require('../scripts/validate-artifacts');
const { isVirtualEventPromotion } = require('../scripts/feed-content-policy');

const repoRoot = path.resolve(__dirname, '..');
const paths = ['news-data.json', 'index.html', 'feed.xml', 'feed-info.json', 'config', 'archive',
  'sitemap.xml', 'sentryinsight-context.json', 'sentryinsight-findings.json'];

function snapshot(root) {
  const files = {};
  function visit(relative) {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) {
      fs.readdirSync(absolute).sort().forEach((name) => visit(path.join(relative, name)));
    } else files[relative] = fs.readFileSync(absolute);
  }
  paths.forEach(visit);
  return files;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  paths.forEach((file) => fs.cpSync(path.join(repoRoot, file), path.join(root, file), { recursive: true }));
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file)));
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2));
  const cleanNews = read('news-data.json').filter((article) => !isVirtualEventPromotion(article));
  const promotion = {
    ...cleanNews[0], title: '\\[ Virtual\nEvent \\] Register for cloud security',
    link: 'https://www.darkreading.com/events/virtual-event-test-promotion', date: '2027-01-01T12:00:00.000Z',
  };
  write('news-data.json', [promotion, ...cleanNews]);
  const config = read('config/news-sources.json');
  config.sources.find((source) => source.name === promotion.source).lastContributedAt = promotion.date;
  write('config/news-sources.json', config);
  const date = read('feed-info.json').lastUpdated.slice(0, 10);
  const archivePath = `archive/${date}/index.json`;
  const manifest = read(archivePath);
  manifest.articles = [promotion, ...manifest.articles.filter((article) => !isVirtualEventPromotion(article))];
  write(archivePath, manifest);
  return { root, read, write, promotion, archivePath };
}

test('offline cleanup removes whole records, preserves evidence and refresh timestamps, and is idempotent', (t) => {
  const { cleanVirtualEventArtifacts } = require('../scripts/clean-virtual-event-artifacts');
  const { root, read } = fixture(t);
  const before = snapshot(root);
  const result = cleanVirtualEventArtifacts({ outputRoot: root });
  assert.equal(result.removedCurrent, 1);
  assert.equal(result.currentCount, read('news-data.json').length);
  assert.deepEqual(read('news-data.json'), JSON.parse(before['news-data.json']).filter((item) => !isVirtualEventPromotion(item)));
  assert.equal(read('feed-info.json').lastUpdated, JSON.parse(before['feed-info.json']).lastUpdated);
  const $ = cheerio.load(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
  assert.equal($('.issue-strip time').attr('datetime'), JSON.parse(before['feed-info.json']).lastUpdated);
  assert.equal($('.issue-trail-updated').attr('datetime'), JSON.parse(before['feed-info.json']).lastUpdated);
  assert.equal(read('config/news-sources.json').settings.lastUpdated, JSON.parse(before['config/news-sources.json']).settings.lastUpdated);
  for (const [file, contents] of Object.entries(before)) {
    if (/archive\/.*\/index.json$/.test(file)) {
      const previous = JSON.parse(contents);
      const actual = read(file);
      assert.deepEqual(actual, { ...previous, articles: previous.articles.filter((item) => !isVirtualEventPromotion(item)) });
    }
    if (/sentryinsight|sitemap/.test(file)) assert.deepEqual(fs.readFileSync(path.join(root, file)), contents);
  }
  const config = read('config/news-sources.json');
  assert.ok(config.sources.every((source) => source.lastContributedAt !== '2027-01-01T12:00:00.000Z'));
  assert.deepEqual(validateArtifacts(root).failures, []);
  const after = snapshot(root);
  assert.deepEqual(cleanVirtualEventArtifacts({ outputRoot: root }).changedFiles, []);
  assert.deepEqual(snapshot(root), after);
});

for (const target of ['rolling', 'archive']) {
  test(`all-excluded ${target} data aborts the entire cleanup before replacing any file`, (t) => {
    const { cleanVirtualEventArtifacts } = require('../scripts/clean-virtual-event-artifacts');
    const { root, read, write, promotion, archivePath } = fixture(t);
    if (target === 'rolling') write('news-data.json', [promotion]);
    else write(archivePath, { ...read(archivePath), articles: [promotion] });
    const before = snapshot(root);
    assert.throws(() => cleanVirtualEventArtifacts({ outputRoot: root }), /non-empty|no publishable/i);
    assert.deepEqual(snapshot(root), before);
  });
}

test('unrelated invalid retained data aborts cleanup with no partial writes', (t) => {
  const { cleanVirtualEventArtifacts } = require('../scripts/clean-virtual-event-artifacts');
  const { root, read, write } = fixture(t);
  const news = read('news-data.json');
  news[1].link = 'javascript:alert(1)';
  write('news-data.json', news);
  const before = snapshot(root);
  assert.throws(() => cleanVirtualEventArtifacts({ outputRoot: root }), /http\(s\) link/);
  assert.deepEqual(snapshot(root), before);
});

test('unrelated public validation failures abort staged cleanup without replacing artifacts', (t) => {
  const { cleanVirtualEventArtifacts } = require('../scripts/clean-virtual-event-artifacts');
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'sitemap.xml'), '<urlset/>');
  const before = snapshot(root);
  assert.throws(() => cleanVirtualEventArtifacts({ outputRoot: root }), /sitemap/);
  assert.deepEqual(snapshot(root), before);
});
