const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FEED_INFO_CONTRACT,
  RSS_CHANNEL_CONTRACT,
} = require('../scripts/generated-artifact-contracts');
const {
  assignFirstSeen,
  normalizeFeedText,
  normalizeSummary,
} = require('../scripts/fetch-news');
const {
  deriveArticleFacets,
  generateHTML,
} = require('../scripts/render-news-html');
const {
  validateReaderExperience,
} = require('../scripts/validate-artifacts');

const GENERATED_AT = new Date('2026-08-13T16:01:10.160Z');

function article(overrides = {}) {
  return {
    title: 'Routine security update',
    link: 'https://www.bleepingcomputer.com/news/security/example/',
    date: '2026-08-13T15:13:00.000Z',
    firstSeen: GENERATED_AT.toISOString(),
    source: 'Bleeping Computer',
    summary: 'Security teams are reviewing the latest development.',
    ...overrides,
  };
}

test('ingest normalization decodes repeated entities and removes feed truncation artifacts', () => {
  assert.equal(
    normalizeFeedText('Jewelbug &amp;amp; attackers target cloud services'),
    'Jewelbug & attackers target cloud services',
  );
  assert.equal(
    normalizeSummary('<p>Systems were hacked [...]...</p>'),
    'Systems were hacked',
  );
});

test('assignFirstSeen preserves known items and marks only new links with the current build', () => {
  const result = assignFirstSeen(
    [
      article({ link: 'https://example.com/known', firstSeen: undefined }),
      article({ link: 'https://example.com/new', firstSeen: undefined }),
    ],
    [
      article({
        link: 'https://example.com/known',
        date: '2026-08-12T12:00:00.000Z',
        firstSeen: '2026-08-12T15:00:00.000Z',
      }),
    ],
    GENERATED_AT,
  );

  assert.equal(result[0].firstSeen, '2026-08-12T15:00:00.000Z');
  assert.equal(result[1].firstSeen, GENERATED_AT.toISOString());
});

test('severity treats explicit data-theft campaigns as critical impact', () => {
  const facets = deriveArticleFacets(article({
    title: 'City-Forum data-theft campaign targets Salesforce portals',
    summary: 'Attackers stole customer records from exposed service portals.',
  }));

  assert.equal(facets.severity, 'Critical');
  assert.ok(facets.tags.includes('Data Breach'));
});

test('generated digest uses explicit UTC labels and never rewrites them to viewer locale', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.match(html, /Updated <time datetime="2026-08-13T16:01:10\.160Z">16:01 UTC · Aug 13<\/time>/);
  assert.match(html, /<time datetime="2026-08-13T15:13:00\.000Z">August 13, 2026 at 3:13 PM UTC<\/time>/);
  assert.doesNotMatch(html, /toLocaleString/);
  assert.doesNotMatch(html, /Last updated/);
});

test('freshness is live, uses a six-hour window, and NEW follows firstSeen', () => {
  const html = generateHTML([
    article(),
    article({
      title: 'Known recent story',
      link: 'https://example.com/known-recent',
      firstSeen: '2026-08-12T16:00:00.000Z',
    }),
  ], { generatedAt: GENERATED_AT });

  assert.match(html, /data-published-at="2026-08-13T15:13:00\.000Z"/);
  assert.match(html, /function updateFreshness\(\)/);
  assert.match(html, /const freshHours = 6/);
  assert.equal((html.match(/<span class="badge-new">NEW<\/span>/g) || []).length, 1);
});

test('taxonomy remains legible while zero-result lanes stay off stage', () => {
  const html = generateHTML([
    article({
      title: 'Ransomware crew steals customer records',
      summary: 'Incident response teams are investigating the compromise.',
    }),
  ], { generatedAt: GENERATED_AT });

  assert.match(html, /<option value="GRCInsight: governance watch">GRCInsight: governance watch<\/option>/);
  assert.match(html, /<span class="handoff-cue-name">GRCInsight: governance watch<\/span>/);
  assert.doesNotMatch(html, /data-lane="Governance watch"/);
  assert.match(html, /<span class="operator-lane-empty" data-lane-empty hidden>No current match<\/span>/);
  assert.doesNotMatch(html, /href="#"[^>]*>No current match/);
});

test('cards merge source and domain and omit a non-varying source signal', () => {
  const html = generateHTML([
    article(),
    article({ title: 'Second media story', link: 'https://www.darkreading.com/example', source: 'Dark Reading' }),
  ], { generatedAt: GENERATED_AT });

  assert.match(html, /Bleeping Computer · bleepingcomputer\.com/);
  assert.doesNotMatch(html, /<span class="chip">Industry media<\/span>/);
  assert.doesNotMatch(html, />HEALTH ONLY</i);
  assert.doesNotMatch(html, />Visible mix</);
  assert.doesNotMatch(html, />Source shortcut/);
});

test('hollow summary remainders do not create disclosure controls', () => {
  const summary = `${'A'.repeat(150)} hacked [...]...`;
  const html = generateHTML([article({ summary })], { generatedAt: GENERATED_AT });

  assert.doesNotMatch(html, /<details class="summary-disclosure">/);
  assert.doesNotMatch(html, /Show full summary/);
  assert.match(html, /<p class="news-summary">/);
});

test('feed summaries cut off mid-sentence stay visible without a hollow disclosure promise', () => {
  const incompleteSummary = `${'Security teams are reviewing exposed systems while responders correlate active exploitation across affected environments. '.repeat(3)}The investigation also`;
  const html = generateHTML([article({ summary: incompleteSummary })], { generatedAt: GENERATED_AT });

  assert.doesNotMatch(html, /<details class="summary-disclosure">/);
  assert.doesNotMatch(html, /Show full summary/);
  assert.match(html, new RegExp(`<p class="news-summary">${incompleteSummary}</p>`));
});

test('rolling feed wording and machine-readable identity stay honest', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.equal(RSS_CHANNEL_CONTRACT.title, 'SentryDigest');
  assert.equal(FEED_INFO_CONTRACT.title, 'SentryDigest RSS Feed');
  assert.match(html, />Rolling RSS feed<\/a>/);
  assert.doesNotMatch(html, /RSS archive/i);
});

test('reader experience contracts reject the observed papercut classes', () => {
  const failures = [];
  validateReaderExperience(
    `<main>
      <time datetime="2026-08-13T16:01:10.160Z">4:01 PM</time>
      <a href="#">No current match</a>
      <details class="summary-disclosure"><p class="summary-full">hacked [...]...</p></details>
      <h2 class="news-title">Jewelbug &amp;amp; attackers</h2>
      <script>new Date().toLocaleString()</script>
    </main>`,
    [article({
      title: 'Jewelbug &amp; attackers',
      summary: 'Systems were hacked [...]...',
    })],
    failures,
  );

  const message = failures.join('\n');
  assert.match(message, /timezone/i);
  assert.match(message, /hash-only/i);
  assert.match(message, /summary/i);
  assert.match(message, /HTML entit/i);
  assert.match(message, /locale-dependent/i);
});
