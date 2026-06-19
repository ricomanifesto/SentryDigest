const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateArtifacts } = require('../scripts/validate-artifacts');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function createFixture(overrides = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-'));
  const newsData = overrides.newsData || [
    {
      title: 'Newer item',
      link: 'https://example.com/newer',
      date: '2026-06-17T18:00:00.000Z',
      source: 'Example Security',
      summary: 'Newest story',
    },
    {
      title: 'Older item',
      link: 'https://example.com/older',
      date: '2026-06-17T17:00:00.000Z',
      source: 'Example Security',
      summary: 'Older story',
    },
  ];

  writeJson(path.join(repoRoot, 'config/news-sources.json'), {
    sources: [
      {
        name: 'Example Security',
        url: 'https://example.com/feed.xml',
        type: 'rss',
        enabled: true,
      },
    ],
    settings: {
      maxNewsItems: 30,
    },
  });
  writeJson(path.join(repoRoot, 'news-data.json'), newsData);
  writeJson(path.join(repoRoot, 'feed-info.json'), {
    title: 'Cybersecurity News Aggregator RSS Feed',
    url: 'https://ricomanifesto.github.io/SentryDigest/feed.xml',
    itemCount: overrides.feedInfoItemCount ?? newsData.length,
    sources: ['Example Security'],
    lastUpdated: '2026-06-17T18:30:00.000Z',
  });
  writeText(
    path.join(repoRoot, 'feed.xml'),
    overrides.feedXml ||
      `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
        <atom:link href="https://ricomanifesto.github.io/SentryDigest/feed.xml" />
        ${newsData.map((item) => `<item><title>${item.title}</title></item>`).join('\n')}
      </channel></rss>`
  );
  writeText(
    path.join(repoRoot, 'index.html'),
    overrides.indexHtml ||
      `<html><body>
        <h1>SentryDigest</h1>
        <a href="./feed.xml">RSS</a>
        ${newsData.map((item) => `<article class="news-item">${item.title}</article>`).join('\n')}
      </body></html>`
  );

  return repoRoot;
}

test('validateArtifacts passes when generated artifacts agree', () => {
  const repoRoot = createFixture();

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.itemCount, 2);
  assert.equal(result.enabledSourceCount, 1);
});

test('validateArtifacts reports every changed downstream artifact mismatch', () => {
  const repoRoot = createFixture({
    feedInfoItemCount: 1,
    feedXml: `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
      <atom:link href="https://ricomanifesto.github.io/SentryDigest/feed.xml" />
      <item><title>Only one item</title></item>
    </channel></rss>`,
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item">Only one item</article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(
    result.failures.join('\n'),
    /feed-info\.json itemCount 1 does not match news-data\.json length 2/
  );
  assert.match(result.failures.join('\n'), /feed\.xml has 1 items, expected 2/);
  assert.match(result.failures.join('\n'), /index\.html renders 1 article cards, expected 2/);
});

test('validateArtifacts reports missing generated artifacts', () => {
  const repoRoot = createFixture();
  fs.rmSync(path.join(repoRoot, 'feed.xml'));

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /feed\.xml is missing/);
});

test('validateArtifacts rejects duplicate links and non-newest-first data', () => {
  const repoRoot = createFixture({
    newsData: [
      {
        title: 'Older duplicate',
        link: 'https://example.com/duplicate',
        date: '2026-06-17T17:00:00.000Z',
        source: 'Example Security',
        summary: 'Older duplicate story',
      },
      {
        title: 'Newer duplicate',
        link: 'https://example.com/duplicate',
        date: '2026-06-17T18:00:00.000Z',
        source: 'Example Security',
        summary: 'Newer duplicate story',
      },
    ],
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /duplicates link https:\/\/example\.com\/duplicate/);
  assert.match(result.failures.join('\n'), /must be newest-first/);
});

test('validateArtifacts rejects unsafe article links in generated HTML', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item"><a href="javascript:alert(1)">Unsafe</a></article>
      <article class="news-item"><a href="https://example.com/older">Older</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /index\.html contains unsafe article href javascript:alert\(1\)/);
});

test('validateArtifacts rejects single-quoted unsafe article links in generated HTML', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item"><a href='javascript:alert(1)'>Unsafe</a></article>
      <article class="news-item"><a href="https://example.com/older">Older</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /index\.html contains unsafe article href javascript:alert\(1\)/);
});

test('validateArtifacts reports malformed encoded article hrefs without throwing', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item"><a href="&#9999999999;">Malformed</a></article>
      <article class="news-item"><a href="https://example.com/older">Older</a></article>
    </body></html>`,
  });

  assert.doesNotThrow(() => validateArtifacts(repoRoot));

  const result = validateArtifacts(repoRoot);
  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /index\.html contains unsafe article href/);
});
