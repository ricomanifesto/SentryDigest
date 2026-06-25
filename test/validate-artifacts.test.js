const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ISSUE_TRAIL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
} = require('../scripts/generated-artifact-contracts');
const { validateArtifacts } = require('../scripts/validate-artifacts');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function renderArchiveTrail() {
  return `<nav class="${ISSUE_TRAIL_CONTRACT.navClass}" aria-label="Digest archive trail">
      <span class="issue-trail-current" aria-current="page">Current digest</span>
      <a href="${ISSUE_TRAIL_CONTRACT.feedHref}">RSS feed</a>
      <a href="${ISSUE_TRAIL_CONTRACT.sourceCoverageHref}">Source coverage</a>
      <span class="issue-trail-meta">Updated <time datetime="2026-06-17T18:30:00.000Z">18:30 UTC</time></span>
      <span class="issue-trail-meta">${ISSUE_TRAIL_CONTRACT.cadenceText}</span>
    </nav>
    <span id="${ISSUE_TRAIL_CONTRACT.sourceCoverageAnchorId}" class="anchor-target" aria-hidden="true"></span>`;
}

function renderGeneratedMetadata(generatedAt = '2026-06-17T18:30:00.000Z') {
  return `<section id="stats" aria-label="Digest statistics">
      <time datetime="${generatedAt}">Generated at ${generatedAt}</time>
    </section>
    <div class="issue-strip">
      <time datetime="${generatedAt}">Updated ${generatedAt}</time>
    </div>`;
}

function collectFixtureSourceCounts(newsData, sourceNames = ['Example Security']) {
  const counts = new Map(sourceNames.map((source) => [source, 0]));

  newsData.forEach((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.source !== 'string') {
      return;
    }
    counts.set(item.source, (counts.get(item.source) || 0) + 1);
  });

  return [...counts.entries()].map(([source, count]) => ({ source, count }));
}

function renderFixtureSourceControls(newsData, sourceNames) {
  const activeSources = collectFixtureSourceCounts(newsData, sourceNames)
    .filter(({ count }) => count > 0)
    .map(({ source }) => `<option value="${source}">${source}</option>`)
    .join('');
  const sourceButtons = collectFixtureSourceCounts(newsData, sourceNames)
    .map(({ source, count }) => {
      const emptyClass = count === 0 ? ' source-count-empty' : '';
      const disabledAttributes = count === 0 ? ' aria-disabled="true" disabled' : '';
      return `<button class="source-count${emptyClass}" type="button" ${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}="${source}" aria-pressed="false"${disabledAttributes}>${source} <strong>${count}</strong></button>`;
    })
    .join('');

  return `<select id="sourceFilter" class="select" aria-label="Filter by source">
      <option value="">All sources</option>
      ${activeSources}
    </select>
    <section class="${SOURCE_COVERAGE_CONTRACT.sectionClass}" aria-label="RSS source coverage">
      <div class="source-counts">${sourceButtons}</div>
    </section>`;
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
    lastUpdated: overrides.feedInfoLastUpdated || '2026-06-17T18:30:00.000Z',
  });
  writeText(
    path.join(repoRoot, 'feed.xml'),
    overrides.feedXml ||
      `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
        <atom:link href="https://ricomanifesto.github.io/SentryDigest/feed.xml" />
        ${newsData.map((item) => `<item><title>${item.title}</title><link>${item.link}</link></item>`).join('\n')}
      </channel></rss>`
  );
  writeText(
    path.join(repoRoot, 'index.html'),
    overrides.indexHtml ||
      `<html><body>
        <h1>SentryDigest</h1>
        <a href="./feed.xml">RSS</a>
        ${renderGeneratedMetadata()}
        ${renderArchiveTrail()}
        ${renderFixtureSourceControls(newsData, ['Example Security'])}
        ${newsData.map((item) => `<article class="news-item"><a href="${item.link}">${item.title}</a></article>`).join('\n')}
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

test('validateArtifacts rejects feed links that drift from news-data', () => {
  const repoRoot = createFixture({
    feedXml: `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
      <atom:link href="https://ricomanifesto.github.io/SentryDigest/feed.xml" />
      <item><title>Newer item</title><link>https://example.com/wrong-newer</link></item>
      <item><title>Older item</title><link>https://example.com/older</link></item>
    </channel></rss>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(
    result.failures.join('\n'),
    /feed\.xml item 1 link https:\/\/example\.com\/wrong-newer does not match news-data\.json link https:\/\/example\.com\/newer/
  );
});

test('validateArtifacts rejects generated HTML article links that drift from news-data', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item"><a href="https://example.com/wrong-newer">Newer item</a></article>
      <article class="news-item"><a href="https://example.com/older">Older item</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(
    result.failures.join('\n'),
    /index\.html article item 1 href https:\/\/example\.com\/wrong-newer does not match news-data\.json link https:\/\/example\.com\/newer/
  );
});

test('validateArtifacts rejects a missing generated archive trail contract', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item"><a href="https://example.com/newer">Newer item</a></article>
      <article class="news-item"><a href="https://example.com/older">Older item</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /index\.html must render the digest archive trail contract/);
});

test('validateArtifacts rejects generated source coverage count drift', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      ${renderArchiveTrail()}
      <select id="sourceFilter" class="select" aria-label="Filter by source">
        <option value="">All sources</option>
        <option value="Example Security">Example Security</option>
      </select>
      <section class="${SOURCE_COVERAGE_CONTRACT.sectionClass}" aria-label="RSS source coverage">
        <div class="source-counts">
          <button class="source-count" type="button" ${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}="Example Security" aria-pressed="false">Example Security <strong>1</strong></button>
        </div>
      </section>
      <article class="news-item"><a href="https://example.com/newer">Newer item</a></article>
      <article class="news-item"><a href="https://example.com/older">Older item</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /index\.html source coverage count for Example Security 1 does not match news-data\.json count 2/);
});

test('validateArtifacts rejects feed-info timestamp drift from the generated digest', () => {
  const repoRoot = createFixture({
    feedInfoLastUpdated: '2026-06-17T17:00:00.000Z',
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /feed-info\.json lastUpdated must align with generated index\.html metadata/);
});

test('validateArtifacts rejects malformed generated metadata timestamps', () => {
  const repoRoot = createFixture({
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <section id="stats" aria-label="Digest statistics">
        <time datetime="not-a-date">Broken</time>
      </section>
      <div class="issue-strip">
        <time datetime="2026-06-17T18:30:00.000Z">Updated 18:30 UTC</time>
      </div>
      ${renderArchiveTrail()}
      ${renderFixtureSourceControls([
        {
          source: 'Example Security',
        },
      ], ['Example Security'])}
      <article class="news-item"><a href="https://example.com/newer">Newer item</a></article>
      <article class="news-item"><a href="https://example.com/older">Older item</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /index\.html generated metadata timestamp for stats must be a valid date/);
});

test('validateArtifacts accepts escaped generated HTML article hrefs', () => {
  const repoRoot = createFixture({
    newsData: [
      {
        title: 'Query item',
        link: 'https://example.com/article?x=1&y=2',
        date: '2026-06-17T18:00:00.000Z',
        source: 'Example Security',
        summary: 'Story with query params',
      },
    ],
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      ${renderGeneratedMetadata()}
      ${renderArchiveTrail()}
      ${renderFixtureSourceControls([
        {
          source: 'Example Security',
        },
      ], ['Example Security'])}
      <article class="news-item"><a href="https://example.com/article?x=1&amp;y=2">Query item</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
});

test('validateArtifacts accepts renderer-normalized generated HTML article hrefs', () => {
  const repoRoot = createFixture({
    newsData: [
      {
        title: 'Normalized item',
        link: 'https://example.com',
        date: '2026-06-17T18:00:00.000Z',
        source: 'Example Security',
        summary: 'Story with normalized URL',
      },
    ],
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      ${renderGeneratedMetadata()}
      ${renderArchiveTrail()}
      ${renderFixtureSourceControls([
        {
          source: 'Example Security',
        },
      ], ['Example Security'])}
      <article class="news-item"><a href="https://example.com/">Normalized item</a></article>
    </body></html>`,
  });

  const result = validateArtifacts(repoRoot);

  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
});

test('validateArtifacts reports malformed news-data items without throwing during link comparison', () => {
  const repoRoot = createFixture({
    newsData: [null],
    feedXml: `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
      <atom:link href="https://ricomanifesto.github.io/SentryDigest/feed.xml" />
      <item><title>Malformed</title><link>https://example.com/malformed</link></item>
    </channel></rss>`,
    indexHtml: `<html><body>
      <h1>SentryDigest</h1>
      <a href="./feed.xml">RSS</a>
      <article class="news-item"><a href="https://example.com/malformed">Malformed</a></article>
    </body></html>`,
  });

  assert.doesNotThrow(() => validateArtifacts(repoRoot));

  const result = validateArtifacts(repoRoot);
  assert.equal(result.valid, false);
  assert.match(result.failures.join('\n'), /news-data item 1 must be an object/);
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
