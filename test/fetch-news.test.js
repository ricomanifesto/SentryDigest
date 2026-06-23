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

test('collectFacetFilterOptions returns deterministic severity, tag, and vendor options', () => {
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
  ]);

  assert.deepEqual(options.severities, ['Critical', 'Monitor']);
  assert.deepEqual(options.tags, ['AI Security', 'Data Breach', 'Exploitation', 'Ransomware', 'Vulnerability']);
  assert.deepEqual(options.vendors, ['Microsoft']);
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
  assert.match(html, /\[sourceFilter, severityFilter, tagFilter, vendorFilter, ageFilter\]/);
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
  assert.match(html, /<span class="source-count" data-source="Example &lt;Security&gt;">Example &lt;Security&gt; <strong>2<\/strong><\/span>/);
  assert.match(html, /<span class="source-count" data-source="Another Source">Another Source <strong>1<\/strong><\/span>/);
  assert.match(html, /<a href="\.\/feed\.xml">RSS feed<\/a>/);
  assert.doesNotMatch(html, /Example <Security>/);
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
  assert.match(html, /<article class="operator-lane" data-lane="Incident watch">/);
  assert.match(html, /<article class="operator-lane" data-lane="Vulnerability triage">/);
  assert.match(html, /<article class="operator-lane" data-lane="Governance watch">/);
  assert.match(html, /<span class="operator-lane-count"><strong>1<\/strong> item<\/span>/);
  assert.match(html, /Ransomware crew steals credentials from exchange/);
  assert.match(html, /Cisco VPN vulnerability patched by vendor/);
  assert.match(html, /Regulator opens &lt;privacy&gt; compliance audit/);
  assert.match(html, /<a href="#" class="operator-lane-link">Regulator opens &lt;privacy&gt; compliance audit<\/a>/);
  assert.doesNotMatch(html, /javascript:alert/);
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
