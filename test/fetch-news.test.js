const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INVALID_FEED_DATE_FALLBACK,
  normalizeArticleDate,
  normalizeFeedDate,
} = require('../scripts/fetch-news');
const {
  collectFacetFilterOptions,
  collectOperatorLanes,
  collectSourceCoverage,
  deriveArticleFacets,
  deriveAgeBucket,
  deriveHandoffCues,
  generateHTML,
} = require('../scripts/render-news-html');

test('normalizeFeedDate preserves valid feed dates', () => {
  const date = normalizeFeedDate(
    'Wed, 17 Jun 2026 18:00:00 GMT',
    new Date('2026-06-01T00:00:00.000Z'),
  );

  assert.equal(date.toISOString(), '2026-06-17T18:00:00.000Z');
});

test('normalizeFeedDate falls back for invalid or missing feed dates', () => {
  const fallback = new Date('2026-06-17T12:00:00.000Z');

  assert.equal(normalizeFeedDate('not a date', fallback).toISOString(), fallback.toISOString());
  assert.equal(normalizeFeedDate(undefined, fallback).toISOString(), fallback.toISOString());
});

test('normalizeFeedDate uses a stable old default for malformed feed dates', () => {
  assert.equal(normalizeFeedDate('not a date'), INVALID_FEED_DATE_FALLBACK);
  assert.equal(INVALID_FEED_DATE_FALLBACK.toISOString(), '1970-01-01T00:00:00.000Z');
});

test('normalizeArticleDate falls back from malformed pubDate to isoDate', () => {
  const date = normalizeArticleDate({
    pubDate: 'not a date',
    isoDate: '2026-06-18T15:30:00.000Z',
  });

  assert.equal(date.toISOString(), '2026-06-18T15:30:00.000Z');
});

test('normalizeArticleDate uses the stable old fallback for malformed feed dates', () => {
  const date = normalizeArticleDate({
    pubDate: 'not a date',
  });

  assert.equal(date, INVALID_FEED_DATE_FALLBACK);
});

test('normalizeArticleDate uses isoDate when pubDate is missing', () => {
  const date = normalizeArticleDate({
    isoDate: '2026-06-18T15:45:00.000Z',
  });

  assert.equal(date.toISOString(), '2026-06-18T15:45:00.000Z');
});

test('normalizeArticleDate uses parser date before the stable old fallback', () => {
  const date = normalizeArticleDate({
    date: '2026-06-18T16:30:00.000Z',
  });

  assert.equal(date.toISOString(), '2026-06-18T16:30:00.000Z');
});

test('generateHTML escapes feed-controlled article fields', () => {
  const html = generateHTML([
    {
      title: '<img src=x onerror=alert(1)>',
      link: 'https://example.com/story?x="bad"',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example <Security>',
      summary: '<script>alert("bad")</script>',
    },
  ]);

  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Example &lt;Security&gt;/);
});

test('generateHTML renders unsafe article links as inert anchors', () => {
  const html = generateHTML([
    {
      title: 'Unsafe link',
      link: 'javascript:alert(1)',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story',
    },
  ]);

  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="#"/);
});

test('deriveArticleFacets identifies operator severity, tags, vendors, and source signal', () => {
  const facets = deriveArticleFacets({
    title: 'Microsoft Exchange zero-day exploited by ransomware crew',
    link: 'https://security.example.com/microsoft-exchange-zero-day',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'SecurityWeek',
    summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
  });

  assert.equal(facets.severity, 'Critical');
  assert.deepEqual(facets.tags, ['Ransomware', 'Vulnerability', 'Exploitation', 'Data Breach']);
  assert.deepEqual(facets.vendors, ['Microsoft']);
  assert.equal(facets.sourceSignal, 'Industry media');
});

test('deriveArticleFacets classifies Threatpost as industry media', () => {
  const facets = deriveArticleFacets({
    title: 'Threat intelligence teams track phishing campaign',
    link: 'https://threatpost.com/example-story',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Threatpost',
    summary: 'Researchers observed credential harvesting infrastructure.',
  });

  assert.equal(facets.sourceSignal, 'Industry media');
});

test('deriveArticleFacets recognizes vulnerability wording without CVE IDs', () => {
  const singular = deriveArticleFacets({
    title: 'Vendor fixes authentication vulnerability in edge appliance',
    link: 'https://example.com/authentication-vulnerability',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'The vulnerability can expose administrator sessions.',
  });
  const plural = deriveArticleFacets({
    title: 'Several vulnerabilities affect popular VPN products',
    link: 'https://example.com/vpn-vulnerabilities',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Administrators should review the advisories.',
  });

  assert.equal(singular.severity, 'Elevated');
  assert.ok(singular.tags.includes('Vulnerability'));
  assert.equal(plural.severity, 'Elevated');
  assert.ok(plural.tags.includes('Vulnerability'));
});

test('deriveArticleFacets does not mark generic critical asset mentions as Critical', () => {
  const facets = deriveArticleFacets({
    title: 'AI agents connect to critical business systems',
    link: 'https://example.com/ai-agents-business-systems',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Security teams are reviewing governance for critical business systems.',
  });

  assert.equal(facets.severity, 'Monitor');
  assert.deepEqual(facets.tags, ['AI Security']);
});

test('deriveArticleFacets elevates flaw and exploit stories tagged as operational risks', () => {
  const facets = deriveArticleFacets({
    title: 'FFmpeg flaw exploited in video processing stacks',
    link: 'https://example.com/ffmpeg-flaw-exploited',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Attackers are exploiting the flaw before some teams have patched affected servers.',
  });

  assert.equal(facets.severity, 'Elevated');
  assert.deepEqual(facets.tags, ['Vulnerability', 'Exploitation']);
});

test('deriveArticleFacets elevates bare exploit stories through exploitation tags', () => {
  const facets = deriveArticleFacets({
    title: 'Researchers publish exploit for appliance flaw',
    link: 'https://example.com/appliance-exploit',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Security teams should review exposure before broad scanning begins.',
  });

  assert.equal(facets.severity, 'Elevated');
  assert.deepEqual(facets.tags, ['Vulnerability', 'Exploitation']);
});

test('deriveArticleFacets does not tag generic exchange incidents as Microsoft', () => {
  const facets = deriveArticleFacets({
    title: 'Cryptocurrency exchange discloses credential theft',
    link: 'https://example.com/crypto-exchange-incident',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'The exchange reported a data breach and reset user passwords after an identity incident.',
  });

  assert.deepEqual(facets.vendors, []);
  assert.deepEqual(facets.tags, ['Data Breach', 'Identity']);
});

test('deriveArticleFacets recognizes plural credential-theft wording', () => {
  const facets = deriveArticleFacets({
    title: 'Firewall sniffer used to steal credentials',
    link: 'https://example.com/firewall-credentials',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Attackers harvested authentication secrets from compromised firewalls.',
  });

  assert.equal(facets.severity, 'Critical');
  assert.deepEqual(facets.tags, ['Data Breach', 'Identity']);
});

test('deriveArticleFacets does not treat compromised devices as data breaches', () => {
  const facets = deriveArticleFacets({
    title: 'Router botnet compromised thousands of outdated devices',
    link: 'https://example.com/router-botnet',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'The malware turned routers into proxies for malicious traffic.',
  });

  assert.equal(facets.severity, 'Elevated');
  assert.deepEqual(facets.tags, ['Malware']);
  assert.ok(!facets.tags.includes('Data Breach'));
});

test('deriveArticleFacets does not tag ordinary software packages as supply chain risks', () => {
  const facets = deriveArticleFacets({
    title: 'Windows feature update uses a small enablement package',
    link: 'https://example.com/windows-enablement-package',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Administrators can upgrade managed devices using the package.',
  });

  assert.equal(facets.severity, 'Monitor');
  assert.deepEqual(facets.tags, []);
  assert.deepEqual(facets.vendors, ['Microsoft']);
});

test('deriveArticleFacets does not tag ordinary dependency updates as supply chain risks', () => {
  const facets = deriveArticleFacets({
    title: 'Application dependency update improves startup time',
    link: 'https://example.com/dependency-update',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'The release notes describe a routine dependency upgrade.',
  });

  assert.equal(facets.severity, 'Monitor');
  assert.deepEqual(facets.tags, []);
});

test('deriveArticleFacets does not tag Cisco IOS XE advisories as Apple', () => {
  const facets = deriveArticleFacets({
    title: 'Cisco IOS XE advisory warns of exploit attempts',
    link: 'https://example.com/cisco-ios-xe-advisory',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Administrators should patch affected Cisco routers.',
  });

  assert.deepEqual(facets.vendors, ['Cisco']);
  assert.ok(!facets.vendors.includes('Apple'));
});

test('generateHTML renders escaped operator facets on article cards', () => {
  const html = generateHTML([
    {
      title: 'Cisco VPN flaw exploited in the wild',
      link: 'https://example.com/cisco-vpn',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Attackers are exploiting a critical vulnerability affecting Cisco appliances.',
    },
  ]);

  assert.match(html, /data-severity="Critical"/);
  assert.match(html, /data-tags="Vulnerability,Exploitation"/);
  assert.match(html, /data-vendors="Cisco"/);
  assert.match(html, /data-source-signal="General source"/);
  assert.match(html, /<span class="severity severity-critical">Critical<\/span>/);
  assert.match(html, /<span class="chip">Cisco<\/span>/);
  assert.match(html, /<span class="chip">Vulnerability<\/span>/);
});

test('generateHTML renders escaped downstream handoff cues on article cards', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
  ]);

  assert.match(html, /data-handoff-cues="SentryInsight: incident watch,SentryInsight: vuln triage,SentryInsight: vendor watch,GRCInsight: governance watch"/);
  assert.match(html, /<div class="handoff-row" aria-label="Downstream handoff cues">/);
  assert.match(html, /<span class="handoff-cue">SentryInsight: incident watch<\/span>/);
  assert.match(html, /<span class="handoff-cue">GRCInsight: governance watch<\/span>/);
});

test('collectFacetFilterOptions returns deterministic severity, tag, vendor, and handoff options', () => {
  const options = collectFacetFilterOptions([
    {
      title: 'Microsoft Exchange zero-day exploited by ransomware crew',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
    },
    {
      title: 'AI agents connect to critical business systems',
      link: 'https://example.com/ai-agents-business-systems',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Security teams are reviewing governance for critical business systems.',
    },
    {
      title: 'Weekly security podcast roundup',
      link: 'https://example.com/security-podcast-roundup',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example Security',
      summary: 'Researchers discuss general awareness topics.',
    },
  ]);

  assert.deepEqual(options.severities, ['Critical', 'Monitor']);
  assert.deepEqual(options.tags, ['AI Security', 'Data Breach', 'Exploitation', 'Ransomware', 'Vulnerability']);
  assert.deepEqual(options.vendors, ['Microsoft']);
  assert.deepEqual(options.handoffCues, [
    'SentryInsight: incident watch',
    'SentryInsight: vuln triage',
    'SentryInsight: vendor watch',
    'GRCInsight: governance watch',
    'SentryInsight: monitor',
  ]);
});

test('collectSourceCoverage returns deterministic source counts', () => {
  const coverage = collectSourceCoverage([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story one.',
    },
    {
      title: 'Second story',
      link: 'https://example.com/second',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story two.',
    },
    {
      title: 'Third story',
      link: 'https://example.com/third',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Another Source',
      summary: 'Story three.',
    },
  ]);

  assert.deepEqual(coverage, [
    { source: 'Example Security', count: 2 },
    { source: 'Another Source', count: 1 },
  ]);
});

test('deriveHandoffCues identifies downstream incident and governance relevance', () => {
  const cues = deriveHandoffCues({
    title: 'Microsoft Exchange zero-day exploited in data breach response',
    link: 'https://security.example.com/microsoft-exchange-zero-day',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'SecurityWeek',
    summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
  });

  assert.deepEqual(cues, [
    'SentryInsight: incident watch',
    'SentryInsight: vuln triage',
    'SentryInsight: vendor watch',
    'GRCInsight: governance watch',
  ]);
});

test('deriveHandoffCues returns a stable monitor cue for low-signal articles', () => {
  const cues = deriveHandoffCues({
    title: 'Weekly security podcast roundup',
    link: 'https://example.com/security-podcast-roundup',
    date: new Date('2026-06-17T18:00:00.000Z'),
    source: 'Example Security',
    summary: 'Researchers discuss general awareness topics.',
  });

  assert.deepEqual(cues, ['SentryInsight: monitor']);
});

test('collectOperatorLanes returns deterministic lane counts and latest articles', () => {
  const lanes = collectOperatorLanes([
    {
      title: 'Malformed date incident should not become latest',
      link: 'https://example.com/malformed-incident',
      date: new Date('invalid'),
      source: 'Example Security',
      summary: 'Incident response teams are investigating stolen credentials.',
    },
    {
      title: 'Ransomware crew steals credentials from exchange',
      link: 'https://example.com/incident',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Incident response teams are investigating stolen credentials.',
    },
    {
      title: 'Cisco VPN vulnerability patched by vendor',
      link: 'https://example.com/vuln',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example Security',
      summary: 'CVE-2026-1234 affects exposed appliances.',
    },
    {
      title: 'Regulator opens privacy compliance audit',
      link: 'https://example.com/grc',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Example Security',
      summary: 'Governance teams are reviewing regulatory filings.',
    },
  ]);

  assert.deepEqual(lanes, [
    {
      label: 'Incident watch',
      count: 2,
      latestTitle: 'Ransomware crew steals credentials from exchange',
      latestLink: 'https://example.com/incident',
    },
    {
      label: 'Vulnerability triage',
      count: 1,
      latestTitle: 'Cisco VPN vulnerability patched by vendor',
      latestLink: 'https://example.com/vuln',
    },
    {
      label: 'Governance watch',
      count: 1,
      latestTitle: 'Regulator opens privacy compliance audit',
      latestLink: 'https://example.com/grc',
    },
  ]);
});

test('deriveAgeBucket returns deterministic operator age buckets', () => {
  const generatedAt = new Date('2026-06-17T18:00:00.000Z');

  assert.deepEqual(deriveAgeBucket(new Date('2026-06-17T17:30:00.000Z'), generatedAt), {
    label: 'Fresh',
    detail: '30m old',
  });
  assert.deepEqual(deriveAgeBucket(new Date('2026-06-16T18:00:00.000Z'), generatedAt), {
    label: 'Recent',
    detail: '1d old',
  });
  assert.deepEqual(deriveAgeBucket(new Date('2026-06-13T17:59:00.000Z'), generatedAt), {
    label: 'Older',
    detail: '4d old',
  });
  assert.deepEqual(deriveAgeBucket(new Date('invalid'), generatedAt), {
    label: 'Undated',
    detail: 'date unavailable',
  });
  assert.deepEqual(deriveAgeBucket(INVALID_FEED_DATE_FALLBACK, generatedAt), {
    label: 'Undated',
    detail: 'date unavailable',
  });
});

test('generateHTML uses generatedAt for new article badges', () => {
  const realDateNow = Date.now;
  Date.now = () => new Date('2030-01-01T00:00:00.000Z').getTime();

  try {
    const html = generateHTML([
      {
        title: 'Fresh relative to generated artifact',
        link: 'https://example.com/fresh-artifact',
        date: new Date('2026-06-17T17:30:00.000Z'),
        source: 'Example Security',
        summary: 'A recent article for this generated artifact.',
      },
    ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

    assert.match(html, /<span class="badge-new">NEW<\/span>/);
  } finally {
    Date.now = realDateNow;
  }
});

test('generateHTML renders age metadata and filter controls', () => {
  const html = generateHTML([
    {
      title: 'Fresh VPN exploitation story',
      link: 'https://example.com/fresh-vpn',
      date: new Date('2026-06-17T17:30:00.000Z'),
      source: 'Example Security',
      summary: 'Attackers are exploiting a VPN vulnerability.',
    },
    {
      title: 'Older governance roundup',
      link: 'https://example.com/older-governance',
      date: new Date('2026-06-13T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Governance teams review audit findings.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /data-age-bucket="Fresh"/);
  assert.match(html, /data-age-bucket="Older"/);
  assert.match(html, /<span class="chip age-chip">Fresh - 30m old<\/span>/);
  assert.match(html, /<select id="ageFilter" class="select" aria-label="Filter by article age">/);
  assert.match(html, /<option value="Fresh">Fresh<\/option>/);
  assert.match(html, /<option value="Older">Older<\/option>/);
  assert.match(html, /const ageFilter = q\('#ageFilter'\)/);
  assert.match(html, /card.getAttribute\('data-age-bucket'\) === age/);
  assert.match(html, /\[sourceFilter, severityFilter, tagFilter, vendorFilter, ageFilter, handoffFilter\]/);
});

test('generateHTML renders handoff cue filter controls', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
    {
      title: 'Weekly security podcast roundup',
      link: 'https://example.com/security-podcast-roundup',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example Security',
      summary: 'Researchers discuss general awareness topics.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /<select id="handoffFilter" class="select" aria-label="Filter by downstream handoff cue">/);
  assert.match(html, /<option value="SentryInsight: incident watch">SentryInsight: incident watch<\/option>/);
  assert.match(html, /<option value="SentryInsight: vuln triage">SentryInsight: vuln triage<\/option>/);
  assert.match(html, /<option value="SentryInsight: vendor watch">SentryInsight: vendor watch<\/option>/);
  assert.match(html, /<option value="GRCInsight: governance watch">GRCInsight: governance watch<\/option>/);
  assert.match(html, /<option value="SentryInsight: monitor">SentryInsight: monitor<\/option>/);
  assert.match(html, /const handoffFilter = q\('#handoffFilter'\)/);
  assert.match(html, /const handoff = handoffFilter && handoffFilter\.value \|\| ''/);
  assert.match(html, /const matchesHandoff = !handoff \|\| card\.getAttribute\('data-handoff-cues'\)\.split\(','\)\.filter\(Boolean\)\.includes\(handoff\)/);
  assert.match(html, /matchesSource && matchesSeverity && matchesTag && matchesVendor && matchesAge && matchesHandoff/);
  assert.match(html, /\[sourceFilter, severityFilter, tagFilter, vendorFilter, ageFilter, handoffFilter\]/);
});

test('generateHTML renders shareable filter query state wiring', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /const filterParams = \{/);
  assert.match(html, /search: 'q'/);
  assert.match(html, /sourceFilter: 'source'/);
  assert.match(html, /severityFilter: 'severity'/);
  assert.match(html, /tagFilter: 'tag'/);
  assert.match(html, /vendorFilter: 'vendor'/);
  assert.match(html, /ageFilter: 'age'/);
  assert.match(html, /handoffFilter: 'handoff'/);
  assert.match(html, /function applyQueryState\(\)/);
  assert.match(html, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(html, /control\.value = value/);
  assert.match(html, /function syncQueryState\(\)/);
  assert.match(html, /window\.history\.replaceState\(null, '', nextUrl\)/);
  assert.match(html, /applyQueryState\(\);\s+update\(\);/);
});

test('generateHTML renders active filter summary and reset wiring', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /<div id="activeFilters" class="active-filters" hidden aria-live="polite"><\/div>/);
  assert.match(html, /<button id="resetFilters" class="btn reset-filters" type="button" hidden>Reset filters<\/button>/);
  assert.match(html, /const activeFilters = q\('#activeFilters'\)/);
  assert.match(html, /const resetFilters = q\('#resetFilters'\)/);
  assert.match(html, /function renderActiveFilters\(\)/);
  assert.match(html, /chip\.className = 'active-filter-chip'/);
  assert.match(html, /chip\.textContent = filterLabels\[key\] \+ ': ' \+ label/);
  assert.match(html, /resetFilters\.hidden = activeFiltersList\.length === 0/);
  assert.match(html, /resetFilters\.addEventListener\('click', function\(\)/);
  assert.match(html, /control\.value = ''/);
  assert.match(html, /renderActiveFilters\(\);\s+renderFilterInsights\(visibleCards\);\s+updateOperatorLanes\(visibleCards\);\s+syncQueryState\(\);/);
});

test('generateHTML renders visible result context wiring', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
    {
      title: 'Cisco VPN vulnerability patched by vendor',
      link: 'https://security.example.com/cisco-vpn-vulnerability',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 affects exposed appliances.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /<div id="filterInsights" class="filter-insights" aria-live="polite"><\/div>/);
  assert.match(html, /const filterInsights = q\('#filterInsights'\)/);
  assert.match(html, /function incrementCount\(counts, value\)/);
  assert.match(html, /function collectListCounts\(counts, rawValue\)/);
  assert.match(html, /function appendInsightGroup\(label, counts, limit\)/);
  assert.match(html, /function renderFilterInsights\(visibleCards\)/);
  assert.match(html, /const visibleCards = \[\]/);
  assert.match(html, /if \(show\) \{\s+visible\+\+;\s+visibleCards\.push\(card\);/);
  assert.match(html, /collectListCounts\(topicCounts, card\.getAttribute\('data-tags'\)\)/);
  assert.match(html, /collectListCounts\(vendorCounts, card\.getAttribute\('data-vendors'\)\)/);
  assert.match(html, /collectListCounts\(handoffCounts, card\.getAttribute\('data-handoff-cues'\)\)/);
  assert.match(html, /renderFilterInsights\(visibleCards\)/);
});

test('generateHTML renders escaped source coverage and RSS clarity', () => {
  const html = generateHTML([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example <Security>',
      summary: 'Story one.',
    },
    {
      title: 'Second story',
      link: 'https://example.com/second',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example <Security>',
      summary: 'Story two.',
    },
    {
      title: 'Third story',
      link: 'https://example.com/third',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Another Source',
      summary: 'Story three.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /<section class="source-coverage" aria-label="RSS source coverage">/);
  assert.match(html, /<button class="source-count" type="button" data-source-filter="Example &lt;Security&gt;" aria-pressed="false">Example &lt;Security&gt; <strong>2<\/strong><\/button>/);
  assert.match(html, /<button class="source-count" type="button" data-source-filter="Another Source" aria-pressed="false">Another Source <strong>1<\/strong><\/button>/);
  assert.match(html, /<a href="\.\/feed\.xml">RSS feed<\/a>/);
  assert.doesNotMatch(html, /Example <Security>/);
});

test('generateHTML wires source coverage counts into the source filter', () => {
  const html = generateHTML([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story one.',
    },
    {
      title: 'Second story',
      link: 'https://example.com/second',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Another Source',
      summary: 'Story two.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /const sourceCoverageButtons = qa\('\[data-source-filter\]'\)/);
  assert.match(html, /sourceCoverageButtons\.forEach\(function\(button\)/);
  assert.match(html, /const source = button\.getAttribute\('data-source-filter'\) \|\| ''/);
  assert.match(html, /sourceFilter\.value = sourceFilter\.value === source \? '' : source/);
  assert.match(html, /button\.setAttribute\('aria-pressed', button\.getAttribute\('data-source-filter'\) === src \? 'true' : 'false'\)/);
  assert.match(html, /update\(\);/);
});

test('generateHTML renders escaped operator scan lanes', () => {
  const html = generateHTML([
    {
      title: 'Ransomware crew steals credentials from exchange',
      link: 'https://example.com/incident',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Incident response teams are investigating stolen credentials.',
    },
    {
      title: 'Cisco VPN vulnerability patched by vendor',
      link: 'https://example.com/vuln',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example Security',
      summary: 'CVE-2026-1234 affects exposed appliances.',
    },
    {
      title: 'Regulator opens <privacy> compliance audit',
      link: 'javascript:alert(1)',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Example Security',
      summary: 'Governance teams are reviewing regulatory filings.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /<section class="operator-lanes" aria-label="Operator scan lanes">/);
  assert.match(html, /<article class="operator-lane" data-lane="Incident watch" data-lane-cue="SentryInsight: incident watch">/);
  assert.match(html, /<article class="operator-lane" data-lane="Vulnerability triage" data-lane-cue="SentryInsight: vuln triage">/);
  assert.match(html, /<article class="operator-lane" data-lane="Governance watch" data-lane-cue="GRCInsight: governance watch">/);
  assert.match(html, /<span class="operator-lane-count" data-lane-count><strong>1<\/strong> item<\/span>/);
  assert.match(html, /<a href="https:\/\/example\.com\/incident" class="operator-lane-link" data-lane-link>Ransomware crew steals credentials from exchange<\/a>/);
  assert.match(html, /Ransomware crew steals credentials from exchange/);
  assert.match(html, /Cisco VPN vulnerability patched by vendor/);
  assert.match(html, /Regulator opens &lt;privacy&gt; compliance audit/);
  assert.match(html, /<a href="#" class="operator-lane-link" data-lane-link>Regulator opens &lt;privacy&gt; compliance audit<\/a>/);
  assert.doesNotMatch(html, /javascript:alert/);
});

test('generateHTML renders filter-aware operator lane wiring', () => {
  const html = generateHTML([
    {
      title: 'Ransomware crew steals credentials from exchange',
      link: 'https://example.com/incident',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Incident response teams are investigating stolen credentials.',
    },
    {
      title: 'Cisco VPN vulnerability patched by vendor',
      link: 'https://example.com/vuln',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example Security',
      summary: 'CVE-2026-1234 affects exposed appliances.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /const operatorLanes = qa\('\.operator-lane'\)/);
  assert.match(html, /function updateOperatorLanes\(visibleCards\)/);
  assert.match(html, /const cue = lane\.getAttribute\('data-lane-cue'\)/);
  assert.match(html, /card\.getAttribute\('data-handoff-cues'\)\.split\(','\)\.filter\(Boolean\)\.includes\(cue\)/);
  assert.match(html, /const strongCount = document\.createElement\('strong'\)/);
  assert.match(html, /strongCount\.textContent = matchingCards\.length/);
  assert.match(html, /countTarget\.appendChild\(strongCount\)/);
  assert.match(html, /countTarget\.appendChild\(document\.createTextNode\(' ' \+ itemLabel\)\)/);
  assert.match(html, /linkTarget\.textContent = latestLink \? latestLink\.textContent : 'No current match'/);
  assert.match(html, /linkTarget\.setAttribute\('href', latestLink \? latestLink\.getAttribute\('href'\) : '#'\)/);
  assert.match(html, /renderFilterInsights\(visibleCards\);\s+updateOperatorLanes\(visibleCards\);\s+syncQueryState\(\);/);
});

test('generateHTML treats the malformed feed date fallback as undated', () => {
  const html = generateHTML([
    {
      title: 'Malformed date feed item',
      link: 'https://example.com/malformed-date',
      date: INVALID_FEED_DATE_FALLBACK,
      source: 'Example Security',
      summary: 'A feed item without a usable publication date.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /data-age-bucket="Undated"/);
  assert.match(html, /<span class="chip age-chip">Undated - date unavailable<\/span>/);
  assert.match(html, /<option value="Undated">Undated<\/option>/);
});

test('generateHTML renders facet filter controls and empty filtered state', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited by ransomware crew',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
    },
  ]);

  assert.match(html, /<select id="severityFilter" class="select" aria-label="Filter by severity">/);
  assert.match(html, /<option value="Critical">Critical<\/option>/);
  assert.match(html, /<select id="tagFilter" class="select" aria-label="Filter by topic tag">/);
  assert.match(html, /<option value="Data Breach">Data Breach<\/option>/);
  assert.match(html, /<select id="vendorFilter" class="select" aria-label="Filter by affected vendor">/);
  assert.match(html, /<option value="Microsoft">Microsoft<\/option>/);
  assert.match(html, /id="emptyFilteredState"/);
  assert.match(html, /No articles match the current filters/);
  assert.match(html, /card.getAttribute\('data-severity'\) === severity/);
  assert.match(html, /split\(','\)\.filter\(Boolean\)\.includes\(tag\)/);
  assert.match(html, /split\(','\)\.filter\(Boolean\)\.includes\(vendor\)/);
});

test('generateHTML renders long summaries as accessible expandable content', () => {
  const longSummary = `${'Security teams should prioritize exposed VPN appliances. '.repeat(6)}<script>alert(1)</script>`;
  const html = generateHTML([
    {
      title: 'VPN exploitation campaign expands',
      link: 'https://example.com/vpn-exploitation',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: longSummary,
    },
  ]);

  assert.match(html, /<details class="summary-disclosure">/);
  assert.match(html, /<summary class="summary-toggle" aria-controls="summary-full-0">/);
  assert.match(html, /<span class="summary-preview-text">Security teams should prioritize exposed VPN appliances/);
  assert.match(html, /<span class="summary-action">Show full summary<\/span>/);
  assert.match(html, /details\[open\] \.summary-action \{ display: none; \}/);
  assert.match(html, /<p class="news-summary summary-full" id="summary-full-0">/);
  assert.doesNotMatch(html, /<p class="news-summary summary-preview"/);
  assert.doesNotMatch(html, /data-summary-toggle/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('generateHTML splits expanded summary content without duplicating the preview', () => {
  const previewText = 'Security teams should prioritize exposed VPN appliances and patch externally managed edge devices before broad scanning starts';
  const summary = `${previewText} because attackers are chaining the flaw with stolen credentials across incident response cases.`;
  const html = generateHTML([
    {
      title: 'VPN exploitation campaign expands',
      link: 'https://example.com/vpn-exploitation',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary,
    },
  ]);

  const previewMatch = html.match(/<span class="summary-preview-text">([^<]+)<\/span>/);
  const remainderMatch = html.match(/<p class="news-summary summary-full" id="summary-full-0">([^<]+)<\/p>/);

  assert.ok(previewMatch);
  assert.ok(remainderMatch);
  assert.ok(summary.startsWith(previewMatch[1]));
  assert.ok(summary.endsWith(remainderMatch[1]));
  assert.ok(!remainderMatch[1].startsWith(previewMatch[1]));
});

test('generateHTML expands production-shaped fetched summaries', () => {
  const fetchedSummary = `${'Security teams should prioritize exposed VPN appliances and review incident timelines. '.repeat(3).slice(0, 200)}...`;
  assert.equal(fetchedSummary.length, 203);

  const html = generateHTML([
    {
      title: 'Fetched summary advisory',
      link: 'https://example.com/fetched-summary-advisory',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: fetchedSummary,
    },
  ]);

  assert.match(html, /<details class="summary-disclosure">/);
  assert.match(html, /<summary class="summary-toggle" aria-controls="summary-full-0">/);
  assert.match(html, /<span class="summary-preview-text">Security teams should prioritize exposed VPN appliances/);
  assert.match(html, /<p class="news-summary summary-full" id="summary-full-0">/);
});

test('generateHTML leaves short summaries as plain escaped content', () => {
  const html = generateHTML([
    {
      title: 'Brief advisory',
      link: 'https://example.com/brief-advisory',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Patch exposed systems <quickly>.',
    },
  ]);

  assert.match(html, /<p class="news-summary">Patch exposed systems &lt;quickly&gt;\.<\/p>/);
  assert.doesNotMatch(html, /<details class="summary-disclosure"/);
  assert.doesNotMatch(html, /<p class="news-summary summary-full"/);
});
