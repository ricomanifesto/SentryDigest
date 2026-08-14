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
  });

  assert.equal(first.issueDate, '2026-08-13');
  assert.equal(second.issueDate, '2026-08-13');
  const issueRoot = path.join(root, 'archive', '2026-08-13');
  const manifest = JSON.parse(fs.readFileSync(path.join(issueRoot, 'index.json')));
  const html = fs.readFileSync(path.join(issueRoot, 'index.html'), 'utf8');

  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.issue_date, '2026-08-13');
  assert.equal(manifest.articles.length, 2);
  assert.match(html, /Digest for August 13, 2026/);
  assert.match(html, new RegExp(`id="${articleFragment(FIRST_ARTICLE.link)}"`));
  assert.match(html, /href="https:\/\/example\.com\/security\/advisory"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /fetch\(/);
});

test('dated digest archive output is byte-identical for the same inputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-archive-stable-'));
  const options = {
    newsItems: [FIRST_ARTICLE],
    outputRoot: root,
    generatedAt: new Date('2026-08-13T21:00:00.000Z'),
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
    }),
    /http or https URL/,
  );
});
