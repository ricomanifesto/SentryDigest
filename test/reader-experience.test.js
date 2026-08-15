const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FEED_INFO_CONTRACT,
  HANDOFF_DESTINATION_CONTRACT,
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
    'Systems were hacked…',
  );
  assert.equal(
    normalizeSummary('<p>More reporting follows. [...]...</p>'),
    'More reporting follows…',
  );
  assert.equal(
    normalizeSummary(`${'Investigators are tracing the campaign across affected organizations. '.repeat(3)}During testing,`),
    `${'Investigators are tracing the campaign across affected organizations. '.repeat(3)}During testing…`,
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

  assert.match(html, /Updated <time class="issue-trail-updated" datetime="2026-08-13T16:01:10\.160Z">16:01 UTC · Aug 13<\/time>/);
  assert.match(html, /<time datetime="2026-08-13T15:13:00\.000Z">August 13, 2026 at 3:13 PM UTC<\/time>/);
  assert.doesNotMatch(html, /toLocaleString/);
  assert.doesNotMatch(html, /Last updated/);
});

test('cadence health stays quiet on schedule and names an overdue digest', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.match(html, /data-cadence-hours="3"/);
  assert.match(html, /data-cadence-state="scheduled"/);
  assert.match(html, /const cadenceDeadlineMs = cadenceHours \* 60 \* 60 \* 1000/);
  assert.match(html, /const isOverdue = Date\.now\(\) - updatedAt > cadenceDeadlineMs/);
  assert.match(html, /cadenceLabel\.textContent = isOverdue \? 'running behind its 3h cadence' : '3h cadence'/);
  assert.match(html, /cadenceStatus\.setAttribute\('data-cadence-state', isOverdue \? 'overdue' : 'current'\)/);
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

test('cards show each source once, retain host metadata, and omit decorative dots', () => {
  const html = generateHTML([
    article(),
    article({ title: 'Second media story', link: 'https://www.darkreading.com/example', source: 'Dark Reading' }),
  ], { generatedAt: GENERATED_AT });

  assert.match(html, /data-host="bleepingcomputer\.com"/);
  assert.match(html, /<span class="chip source-chip">Bleeping Computer<\/span>/);
  assert.doesNotMatch(html, /Bleeping Computer · bleepingcomputer\.com/);
  assert.doesNotMatch(html, /class="dot"/);
  assert.doesNotMatch(html, /<span class="chip">Industry media<\/span>/);
  assert.doesNotMatch(html, />HEALTH ONLY</i);
  assert.doesNotMatch(html, />Visible mix</);
  assert.doesNotMatch(html, />Source shortcut/);
});

test('default digest keeps advanced controls and source diagnostics off the front stage', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.match(html, /<details id="advancedFilters" class="advanced-filters">/);
  assert.match(html, /<summary class="advanced-filters-summary">Refine digest<\/summary>/);
  assert.match(html, /<details class="source-coverage-details">/);
  assert.match(html, /<div class="stats" id="stats" hidden>/);
  assert.doesNotMatch(html, /radial-gradient|linear-gradient|backdrop-filter/);
  assert.doesNotMatch(html, /font-size:\s*(?:12px|0\.8rem|0\.82rem|0\.85rem|0\.9rem|0\.92rem|0\.95rem|1\.06rem)/);
});

test('generated digest defaults to light while preserving an explicit dark choice', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.match(html, /const saved = localStorage\.getItem\(themeKey\)/);
  assert.match(html, /root\.setAttribute\('data-theme', saved === 'dark' \? 'dark' : 'light'\)/);
  assert.doesNotMatch(html, /prefers-color-scheme/);
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
  assert.match(html, new RegExp(`<p class="news-summary">${incompleteSummary}…</p>`));
  assert.match(
    html,
    /<a class="summary-continuation" href="https:\/\/www\.bleepingcomputer\.com\/news\/security\/example\/"[^>]*>Continues at Bleeping Computer <span aria-hidden="true">→<\/span><\/a>/,
  );
});

test('truncated summary continuation is escaped, accessible, and points at the article', () => {
  const html = generateHTML([
    article({
      link: 'https://example.com/read?topic=breach&view=full',
      source: 'News & Analysis',
      summary: 'Investigators are tracing the campaign across affected organizations…',
    }),
  ], { generatedAt: GENERATED_AT });

  assert.match(html, /class="summary-continuation"/);
  assert.match(html, /href="https:\/\/example\.com\/read\?topic=breach&amp;view=full"/);
  assert.match(html, /aria-label="Continue reading at News &amp; Analysis"/);
  assert.match(html, />Continues at News &amp; Analysis <span aria-hidden="true">→<\/span><\/a>/);
});

test('reader contracts reject a truncated summary whose continuation path disappears', () => {
  const articles = [article({ summary: 'Investigators are tracing the campaign across affected organizations…' })];
  const html = generateHTML(articles, { generatedAt: GENERATED_AT })
    .replace(/<a class="summary-continuation"[\s\S]*?<\/a>/, '');
  const failures = [];

  validateReaderExperience(html, articles, failures);

  assert.match(failures.join('\n'), /truncated summary 1 must have one continuation link/);
});

test('quiet configured sources remain visible with durable contribution history', () => {
  const html = generateHTML([article()], {
    generatedAt: GENERATED_AT,
    sourceHealth: [
      {
        name: 'Bleeping Computer',
        itemCount: 1,
        lastContributedAt: '2026-08-13T15:13:00.000Z',
      },
      {
        name: 'Krebs on Security',
        itemCount: 0,
        lastContributedAt: '2026-08-09T11:30:00.000Z',
      },
    ],
  });

  assert.match(html, /data-active-sources="1" data-quiet-sources="1"/);
  assert.match(html, /data-health-status="quiet" data-quiet-for-days="4">Krebs on Security quiet since <time datetime="2026-08-09T11:30:00.000Z">August 9, 2026 at 11:30 AM UTC<\/time>/);
  assert.doesNotMatch(html, /data-source-filter="Krebs on Security"/);
  assert.doesNotMatch(html, /HEALTH ONLY/i);
});

test('prolonged source silence is labeled as probable feed failure instead of ordinary quiet', () => {
  const html = generateHTML([article()], {
    generatedAt: new Date('2026-08-31T12:00:00.000Z'),
    sourceHealth: [
      {
        name: 'Bleeping Computer',
        itemCount: 1,
        lastContributedAt: '2026-08-31T11:00:00.000Z',
      },
      {
        name: 'Long Quiet Feed',
        itemCount: 0,
        lastContributedAt: '2026-07-01T12:00:00.000Z',
      },
    ],
  });

  assert.match(html, /data-health-status="stale" data-quiet-for-days="61">Long Quiet Feed no items in 61 days; feed may have moved · last contribution <time datetime="2026-07-01T12:00:00.000Z">July 1, 2026 at 12:00 PM UTC<\/time>/);
  assert.doesNotMatch(html, /data-source-filter="Long Quiet Feed"/);
});

test('handoff cues, legend entries, and lane headings link to downstream products', () => {
  const html = generateHTML([
    article({
      title: 'Ransomware incident triggers regulatory review',
      summary: 'Incident response teams are investigating stolen records and privacy obligations.',
    }),
  ], { generatedAt: GENERATED_AT });

  assert.match(html, new RegExp(`<a class="handoff-cue" href="${HANDOFF_DESTINATION_CONTRACT.destinations['SentryInsight: incident watch']}"`));
  assert.match(html, new RegExp(`<a class="handoff-cue-legend-chip" href="${HANDOFF_DESTINATION_CONTRACT.destinations['GRCInsight: governance watch']}"`));
  assert.match(html, new RegExp(`<a class="operator-lane-heading" data-lane-destination href="${HANDOFF_DESTINATION_CONTRACT.destinations['SentryInsight: incident watch']}"`));
  assert.match(html, new RegExp(`<a class="operator-lane-heading" data-lane-destination href="${HANDOFF_DESTINATION_CONTRACT.destinations['GRCInsight: governance watch']}"`));
});

test('incident handoffs carry complete CVE context while generic and GRC links keep their front doors', () => {
  const cveHtml = generateHTML([
    article({
      title: 'CVE-2026-59310 exploited in a ransomware intrusion',
      summary: 'Incident response teams are investigating stolen credentials and regulatory obligations.',
    }),
  ], { generatedAt: GENERATED_AT });
  const genericHtml = generateHTML([
    article({
      title: 'Ransomware intrusion under investigation',
      summary: 'Incident response teams are investigating stolen credentials and regulatory obligations.',
    }),
  ], { generatedAt: GENERATED_AT });

  assert.match(cveHtml, /<a class="handoff-cue" href="https:\/\/ricomanifesto\.github\.io\/SentryInsight\/#cve-2026-59310"[^>]*>SentryInsight: incident watch<\/a>/);
  assert.match(cveHtml, /<a class="operator-lane-heading" data-lane-destination href="https:\/\/ricomanifesto\.github\.io\/SentryInsight\/#cve-2026-59310"/);
  assert.match(cveHtml, /<a class="handoff-cue" href="https:\/\/ricomanifesto\.github\.io\/GRCInsight\/"[^>]*>GRCInsight: governance watch<\/a>/);
  assert.match(genericHtml, /<a class="handoff-cue" href="https:\/\/ricomanifesto\.github\.io\/SentryInsight\/"[^>]*>SentryInsight: incident watch<\/a>/);
});

test('incident handoffs prefer the first CVE present in the current Insight report', () => {
  const html = generateHTML([
    article({
      title: 'CVE-2026-00001 and CVE-2026-59310 exploited in one intrusion',
      summary: 'Incident response teams are investigating stolen credentials.',
    }),
  ], {
    generatedAt: GENERATED_AT,
    currentInsightCves: ['CVE-2026-59310'],
  });

  assert.match(html, /SentryInsight\/#cve-2026-59310/);
  assert.doesNotMatch(html, /SentryInsight\/#cve-2026-00001/);
});

test('rolling article cards expose their stable reporting identity as a permalink', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.match(
    html,
    /<a class="item-permalink" href="#reporting-[0-9a-f]{12}" aria-label="Permalink to this reporting item">Permalink<\/a>/,
  );
});

test('issue trail makes retained history visible beside the current digest', () => {
  const html = generateHTML([article()], {
    generatedAt: new Date('2026-08-14T02:20:21.072Z'),
    retainedIssueDates: ['2026-08-13', '2026-08-14'],
  });

  assert.match(html, /class="previous-issues" href="\.\/archive\/"/);
  assert.match(html, /class="previous-issue" href="\.\/archive\/2026-08-13\/"/);
  assert.match(html, /<time datetime="2026-08-13T00:00:00\.000Z">Aug 13<\/time>/);
});

test('only non-current SentryInsight context is named on the reader surface', () => {
  const base = {
    schema_version: 2,
    checked_at: '2026-08-14T02:20:21.072Z',
    report_date: '2026-08-13',
    manifest_generated_at: '2026-08-13T21:54:18Z',
    report_url: 'https://ricomanifesto.github.io/SentryInsight/',
  };
  const current = generateHTML([article()], {
    generatedAt: GENERATED_AT,
    insightContext: { ...base, mode: 'current' },
  });
  const retained = generateHTML([article()], {
    generatedAt: GENERATED_AT,
    insightContext: { ...base, mode: 'retained' },
  });
  const stale = generateHTML([article()], {
    generatedAt: GENERATED_AT,
    insightContext: { ...base, mode: 'stale' },
  });
  const unavailable = generateHTML([article()], {
    generatedAt: GENERATED_AT,
    insightContext: {
      schema_version: 2,
      mode: 'unavailable',
      checked_at: '2026-08-14T02:20:21.072Z',
      report_date: null,
      manifest_generated_at: null,
      report_url: null,
    },
  });

  assert.doesNotMatch(current, /class="insight-context"/);
  assert.match(retained, /data-context-mode="retained"[^>]*><a class="insight-context-link" href="https:\/\/ricomanifesto\.github\.io\/SentryInsight\/" target="_blank" rel="noopener noreferrer">SentryInsight context<\/a> retained as of <time datetime="2026-08-13T21:54:18Z">August 13, 2026 at 9:54 PM UTC<\/time>/);
  assert.match(stale, /data-context-mode="stale"[^>]*><a class="insight-context-link"[^>]+>SentryInsight context<\/a> as of .* is stale; CVE handoffs use the first-mentioned CVE\./);
  assert.match(unavailable, /data-context-mode="unavailable"[^>]*><a class="insight-context-link" href="https:\/\/ricomanifesto\.github\.io\/SentryInsight\/"[^>]*>SentryInsight context<\/a> unavailable as of .*; CVE handoffs use the first-mentioned CVE\./);
});

test('reader contracts reject an incident handoff that drops available CVE context', () => {
  const articles = [article({
    title: 'CVE-2026-59310 exploited in a ransomware intrusion',
    summary: 'Incident response teams are investigating stolen credentials.',
  })];
  const html = generateHTML(articles, { generatedAt: GENERATED_AT })
    .replaceAll('https://ricomanifesto.github.io/SentryInsight/#cve-2026-59310', 'https://ricomanifesto.github.io/SentryInsight/');
  const failures = [];

  validateReaderExperience(html, articles, failures);

  assert.match(failures.join('\n'), /card 1 handoff cue 1 .* must link to its downstream product/);
});

test('rolling feed wording and machine-readable identity stay honest', () => {
  const html = generateHTML([article()], { generatedAt: GENERATED_AT });

  assert.equal(RSS_CHANNEL_CONTRACT.title, 'SentryDigest');
  assert.equal(FEED_INFO_CONTRACT.title, 'SentryDigest RSS Feed');
  assert.match(html, />Rolling RSS feed<\/a>/);
  assert.doesNotMatch(html, /RSS archive/i);
});

test('reader contracts reject punctuation stacked before a truncation ellipsis', () => {
  const failures = [];
  validateReaderExperience(
    '<p class="news-summary">Systems were hacked.…</p>',
    [article({ summary: 'Systems were hacked.…' })],
    failures,
  );

  assert.equal(
    failures.filter((failure) => /redundant punctuation before a truncation ellipsis/.test(failure)).length,
    2,
  );
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
