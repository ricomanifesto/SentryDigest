const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  articleFragment,
  writeDigestArchive,
} = require('../scripts/digest-archive');

const FIRST_ARTICLE = {
  title: 'Critical vendor flaw exploited',
  link: 'https://example.com/security/advisory',
  date: '2026-08-13T20:00:00.000Z',
  source: 'Example Security',
  summary: 'Attackers are exploiting the issue.',
  firstSeen: '2026-08-13T20:30:00.000Z',
};

const CURRENT_INSIGHT_CONTEXT = {
  schema_version: 2,
  mode: 'current',
  checked_at: '2026-08-13T21:00:00.000Z',
  report_date: '2026-08-13',
  manifest_generated_at: '2026-08-13T20:54:18Z',
  report_url: 'https://ricomanifesto.github.io/SentryInsight/',
};

const STALE_INSIGHT_CONTEXT = {
  ...CURRENT_INSIGHT_CONTEXT,
  mode: 'stale',
};

test('article fragments are stable identities derived from original URLs', () => {
  assert.equal(
    articleFragment(FIRST_ARTICLE.link),
    'reporting-cc16b55febdc',
  );
  assert.equal(
    articleFragment(`${FIRST_ARTICLE.link}#reader-view`),
    articleFragment(FIRST_ARTICLE.link),
  );
});

test('dated digest archives accumulate a UTC day and render stable no-JS evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-archive-'));
  const first = writeDigestArchive({
    newsItems: [FIRST_ARTICLE],
    outputRoot: root,
    generatedAt: new Date('2026-08-13T21:00:00.000Z'),
    insightContext: CURRENT_INSIGHT_CONTEXT,
  });

  const secondArticle = {
    ...FIRST_ARTICLE,
    title: 'Follow-up analysis of vendor flaw',
    link: 'https://research.example.net/follow-up',
    source: 'Research Team',
    date: '2026-08-13T21:30:00.000Z',
  };
  const second = writeDigestArchive({
    newsItems: [secondArticle],
    outputRoot: root,
    generatedAt: new Date('2026-08-13T22:00:00.000Z'),
    insightContext: CURRENT_INSIGHT_CONTEXT,
  });

  assert.equal(first.issueDate, '2026-08-13');
  assert.equal(second.issueDate, '2026-08-13');
  const issueRoot = path.join(root, 'archive', '2026-08-13');
  const manifest = JSON.parse(fs.readFileSync(path.join(issueRoot, 'index.json')));
  const html = fs.readFileSync(path.join(issueRoot, 'index.html'), 'utf8');
  const archiveIndex = fs.readFileSync(path.join(root, 'archive', 'index.html'), 'utf8');

  assert.equal(manifest.schema_version, 2);
  assert.equal(manifest.issue_date, '2026-08-13');
  assert.deepEqual(manifest.insight_context, CURRENT_INSIGHT_CONTEXT);
  assert.equal(manifest.articles.length, 2);
  assert.match(html, /Digest for August 13, 2026/);
  assert.match(html, new RegExp(`id="${articleFragment(FIRST_ARTICLE.link)}"`));
  assert.match(html, /href="https:\/\/example\.com\/security\/advisory"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /class="insight-context"/);
  assert.doesNotMatch(html, /fetch\(/);
  assert.match(archiveIndex, /Previous issues/);
  assert.match(archiveIndex, /href="\.\/2026-08-13\/"/);
  assert.doesNotMatch(archiveIndex, /<script/);
});

test('dated digest archive output is byte-identical for the same inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-archive-stable-'));
  const options = {
    newsItems: [FIRST_ARTICLE],
    outputRoot: root,
    generatedAt: new Date('2026-08-13T21:00:00.000Z'),
    insightContext: CURRENT_INSIGHT_CONTEXT,
  };

  writeDigestArchive(options);
  const issueRoot = path.join(root, 'archive', '2026-08-13');
  const firstJson = fs.readFileSync(path.join(issueRoot, 'index.json'));
  const firstHtml = fs.readFileSync(path.join(issueRoot, 'index.html'));
  writeDigestArchive(options);

  assert.deepEqual(fs.readFileSync(path.join(issueRoot, 'index.json')), firstJson);
  assert.deepEqual(fs.readFileSync(path.join(issueRoot, 'index.html')), firstHtml);
});

test('dated digest archives reject unsafe original URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-archive-url-'));

  assert.throws(
    () => writeDigestArchive({
      newsItems: [{ ...FIRST_ARTICLE, link: 'javascript:alert(1)' }],
      outputRoot: root,
      generatedAt: new Date('2026-08-13T21:00:00.000Z'),
      insightContext: CURRENT_INSIGHT_CONTEXT,
    }),
    /http or https URL/,
  );
});

test('new issues stamp actionable context without rewriting historical schema-one issues', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-archive-context-'));
  const historicalRoot = path.join(root, 'archive', '2026-08-12');
  fs.mkdirSync(historicalRoot, { recursive: true });
  const historicalManifest = `${JSON.stringify({
    schema_version: 1,
    issue_date: '2026-08-12',
    generated_at: '2026-08-12T21:00:00.000Z',
    articles: [],
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(historicalRoot, 'index.json'), historicalManifest);
  fs.writeFileSync(path.join(historicalRoot, 'index.html'), '<!doctype html><title>Historical issue</title>\n');

  writeDigestArchive({
    newsItems: [FIRST_ARTICLE],
    outputRoot: root,
    generatedAt: new Date('2026-08-13T21:00:00.000Z'),
    insightContext: STALE_INSIGHT_CONTEXT,
  });

  const currentRoot = path.join(root, 'archive', '2026-08-13');
  const manifest = JSON.parse(fs.readFileSync(path.join(currentRoot, 'index.json'), 'utf8'));
  const html = fs.readFileSync(path.join(currentRoot, 'index.html'), 'utf8');
  assert.equal(fs.readFileSync(path.join(historicalRoot, 'index.json'), 'utf8'), historicalManifest);
  assert.equal(manifest.schema_version, 2);
  assert.deepEqual(manifest.insight_context, STALE_INSIGHT_CONTEXT);
  assert.match(
    html,
    /<a class="insight-context-link" href="https:\/\/ricomanifesto\.github\.io\/SentryInsight\/" target="_blank" rel="noopener noreferrer">SentryInsight context<\/a>/,
  );
  assert.match(html, /data-context-mode="stale"/);
});
