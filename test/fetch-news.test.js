const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  fetchAllNews,
  INVALID_FEED_DATE_FALLBACK,
  loadSourceConfig,
  normalizeArticleDate,
  normalizeFeedDate,
  updateConfigLastUpdated,
  writeGeneratedNewsArtifacts,
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
const {
  ISSUE_TRAIL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
} = require('../scripts/generated-artifact-contracts');

test('fetch-news helpers can be imported without loading source config', () => {
  const modulePath = require.resolve('../scripts/fetch-news');
  const cachedModule = require.cache[modulePath];
  const originalExistsSync = fs.existsSync;
  let existsSyncCalls = 0;

  delete require.cache[modulePath];
  fs.existsSync = (...args) => {
    existsSyncCalls += 1;
    return originalExistsSync(...args);
  };

  try {
    const fetchNews = require('../scripts/fetch-news');

    assert.equal(typeof fetchNews.normalizeFeedDate, 'function');
    assert.equal(existsSyncCalls, 0);
  } finally {
    fs.existsSync = originalExistsSync;
    delete require.cache[modulePath];
    if (cachedModule) {
      require.cache[modulePath] = cachedModule;
    }
  }
});

test('fetchAllNews keeps successful source results when another source fails', async () => {
  const sourceConfig = {
    enabledRssSources: [
      { name: 'Healthy Source', type: 'rss' },
      { name: 'Unavailable Source', type: 'rss' },
    ],
    maxNewsItems: 30,
  };
  const errors = [];

  const result = await fetchAllNews({
    sourceConfig,
    fetchFeed: async (source) => {
      if (source.name === 'Unavailable Source') {
        throw new Error('upstream unavailable');
      }
      return [{
        title: 'Current security item',
        link: 'https://example.com/current',
        date: new Date('2026-07-22T10:00:00.000Z'),
        source: source.name,
        summary: '',
      }];
    },
    logger: { error: (...args) => errors.push(args.join(' ')) },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'Healthy Source');
  assert.match(errors[0], /Unavailable Source.*upstream unavailable/);
});

test('fetchAllNews rejects a total source outage before artifact generation', async () => {
  const sourceConfig = {
    enabledRssSources: [
      { name: 'Source One', type: 'rss' },
      { name: 'Source Two', type: 'rss' },
    ],
    maxNewsItems: 30,
  };

  await assert.rejects(
    fetchAllNews({
      sourceConfig,
      fetchFeed: async () => {
        throw new Error('upstream unavailable');
      },
      logger: { error() {} },
    }),
    /Failed to fetch all 2 enabled RSS sources/,
  );
});

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

test('loadSourceConfig bootstraps missing config with canonical RSS source shape', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-source-bootstrap-'));
  const configPath = path.join(tmpDir, 'config/news-sources.json');

  const result = loadSourceConfig({
    configPath,
    logger: { log() {} },
    now: new Date('2026-06-25T18:00:00.000Z'),
  });

  assert.equal(fs.existsSync(configPath), true);
  assert.equal(result.maxNewsItems, 30);
  assert.equal(result.enabledRssSources.length, result.config.sources.length);
  assert.equal(result.config.settings.lastUpdated, '2026-06-25T18:00:00.000Z');

  result.enabledRssSources.forEach((source) => {
    assert.equal(typeof source.name, 'string');
    assert.match(source.url, /^https?:\/\//);
    assert.equal(source.type, 'rss');
    assert.equal(source.enabled, true);
  });
});

test('updateConfigLastUpdated initializes missing settings while preserving existing fields', () => {
  const configWithoutSettings = {
    sources: [],
  };
  const configWithSettings = {
    sources: [],
    settings: {
      maxNewsItems: 10,
      sortMode: 'recent',
    },
  };

  updateConfigLastUpdated(configWithoutSettings, new Date('2026-06-25T19:00:00.000Z'));
  updateConfigLastUpdated(configWithSettings, new Date('2026-06-25T20:00:00.000Z'));

  assert.deepEqual(configWithoutSettings.settings, {
    lastUpdated: '2026-06-25T19:00:00.000Z',
  });
  assert.deepEqual(configWithSettings.settings, {
    maxNewsItems: 10,
    sortMode: 'recent',
    lastUpdated: '2026-06-25T20:00:00.000Z',
  });
});

test('writeGeneratedNewsArtifacts rejects invalid news data before writing artifacts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-fetch-write-contract-'));
  const indexHtmlPath = path.join(tmpDir, 'index.html');
  const newsDataPath = path.join(tmpDir, 'news-data.json');
  const configPath = path.join(tmpDir, 'config/news-sources.json');
  const sourceConfig = {
    config: {
      sources: [
        { name: 'Example Security', url: 'https://example.com/feed.xml', type: 'rss', enabled: true },
      ],
      settings: { maxNewsItems: 5 },
    },
    enabledRssSources: [
      { name: 'Example Security', url: 'https://example.com/feed.xml', type: 'rss', enabled: true },
    ],
    maxNewsItems: 5,
  };

  assert.throws(
    () => writeGeneratedNewsArtifacts({
      newsItems: [
        {
          title: 'Older duplicate item',
          link: 'https://example.com/duplicate',
          source: 'Example Security',
          date: new Date('2026-06-17T00:30:00.000Z'),
        },
        {
          title: 'Newer duplicate item',
          link: 'https://example.com/duplicate',
          source: 'Example Security',
          date: new Date('2026-06-18T00:30:00.000Z'),
        },
      ],
      sourceConfig,
      indexHtmlPath,
      newsDataPath,
      configPath,
      logger: { log() {} },
      now: new Date('2026-06-18T01:00:00.000Z'),
    }),
    /duplicates link.*newest-first/
  );
  assert.equal(fs.existsSync(indexHtmlPath), false);
  assert.equal(fs.existsSync(newsDataPath), false);
  assert.equal(fs.existsSync(configPath), false);
  assert.deepEqual(sourceConfig.config.settings, { maxNewsItems: 5 });
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

test('generateHTML publishes discoverable project identity metadata', () => {
  const html = generateHTML([], {
    generatedAt: new Date('2026-06-17T18:00:00.000Z'),
  });

  assert.match(html, /<link rel="canonical" href="https:\/\/ricomanifesto\.github\.io\/SentryDigest\/">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/ricomanifesto\.github\.io\/SentryDigest\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/ricomanifesto\.github\.io\/SentryDigest\/assets\/logo\.png">/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/ricomanifesto\.github\.io\/SentryDigest\/assets\/logo\.png">/);
  assert.match(html, /<script type="application\/ld\+json">[\s\S]*"@type":"WebSite"[\s\S]*"name":"Michael Rico"[\s\S]*<\/script>/);
  assert.match(html, /<a href="https:\/\/ricomanifesto\.com\/">Michael Rico<\/a>/);
  assert.doesNotMatch(html, /\/Users\//);
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

test('generateHTML groups legend explanations into a compact digest legend', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Microsoft',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
    {
      title: 'Security news roundup',
      link: 'https://www.bleepingcomputer.com/news/security/example/',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Bleeping Computer',
      summary: 'Industry reporting on security activity.',
    },
  ]);

  assert.match(html, /<details class="digest-legend" aria-label="Digest legend">/);
  assert.match(html, /<summary class="digest-legend-summary">Digest legend: source signals and handoff cues<\/summary>/);
  assert.match(html, /<div class="digest-legend-body">/);
  assert.match(html, /<div class="digest-legend-group source-signal-legend" aria-label="Source signal legend">/);
  assert.match(html, /<div class="digest-legend-group handoff-cue-legend" aria-label="Handoff cue legend">/);
  assert.match(html, /<div class="digest-legend-heading">Source signals<\/div>/);
  assert.match(html, /<div class="digest-legend-heading">Handoff cues<\/div>/);
  assert.doesNotMatch(html, /<section class="source-signal-legend" aria-label="Source signal legend">/);
  assert.doesNotMatch(html, /<section class="handoff-cue-legend" aria-label="Handoff cue legend">/);
});

test('generateHTML keeps legend details inside the source coverage scan row', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited in data breach response',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Microsoft',
      summary: 'SEC filings mention incident response, active exploitation, and stolen credentials.',
    },
    {
      title: 'Security news roundup',
      link: 'https://www.bleepingcomputer.com/news/security/example/',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Bleeping Computer',
      summary: 'Industry reporting on security activity.',
    },
  ]);

  const sourceCoverageStart = html.indexOf(`<section class="${SOURCE_COVERAGE_CONTRACT.sectionClass}" aria-label="RSS source coverage">`);
  const feedLinkIndex = html.indexOf('<a class="feed-link"', sourceCoverageStart);
  const digestLegendIndex = html.indexOf('<details class="digest-legend" aria-label="Digest legend">', sourceCoverageStart);
  const sourceCoverageEnd = html.indexOf('</section>', sourceCoverageStart);
  const operatorLanesIndex = html.indexOf('<section class="operator-lanes" aria-label="Operator scan lanes">');

  assert.ok(sourceCoverageStart !== -1);
  assert.ok(feedLinkIndex > sourceCoverageStart);
  assert.ok(digestLegendIndex > feedLinkIndex);
  assert.ok(digestLegendIndex < sourceCoverageEnd);
  assert.ok(sourceCoverageEnd < operatorLanesIndex);
});

test('generateHTML renders a handoff cue legend for present cues', () => {
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
      source: 'Example <Security>',
      summary: 'Researchers discuss general awareness topics.',
    },
  ]);

  assert.match(html, /<div class="digest-legend-group handoff-cue-legend" aria-label="Handoff cue legend">/);
  assert.match(html, /<div class="digest-legend-heading">Handoff cues<\/div>/);
  assert.match(html, /<span class="handoff-cue-name">SentryInsight: incident watch<\/span><span class="handoff-cue-detail">Potential incident or compromise follow-up<\/span>/);
  assert.match(html, /<span class="handoff-cue-name">SentryInsight: vuln triage<\/span><span class="handoff-cue-detail">Vulnerability or exploitation review<\/span>/);
  assert.match(html, /<span class="handoff-cue-name">SentryInsight: vendor watch<\/span><span class="handoff-cue-detail">Vendor or product-owner tracking<\/span>/);
  assert.match(html, /<span class="handoff-cue-name">GRCInsight: governance watch<\/span><span class="handoff-cue-detail">Regulatory, privacy, or audit relevance<\/span>/);
  assert.match(html, /<span class="handoff-cue-name">SentryInsight: monitor<\/span><span class="handoff-cue-detail">Low-signal item worth monitoring<\/span>/);
  assert.doesNotMatch(html, /Example <Security>/);
});

test('generateHTML omits absent handoff cue legend entries', () => {
  const html = generateHTML([
    {
      title: 'Weekly security podcast roundup',
      link: 'https://example.com/security-podcast-roundup',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Example Security',
      summary: 'Researchers discuss general awareness topics.',
    },
  ]);

  assert.match(html, /<div class="digest-legend-group handoff-cue-legend" aria-label="Handoff cue legend">/);
  assert.match(html, /<span class="handoff-cue-name">SentryInsight: monitor<\/span>/);
  assert.doesNotMatch(html, /Potential incident or compromise follow-up/);
  assert.doesNotMatch(html, /Vulnerability or exploitation review/);
  assert.doesNotMatch(html, /Vendor or product-owner tracking/);
  assert.doesNotMatch(html, /Regulatory, privacy, or audit relevance/);
});

test('generateHTML renders a source signal legend for present classifications', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange patch advisory',
      link: 'https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-1234',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Microsoft',
      summary: 'Vendor guidance for administrators.',
    },
    {
      title: 'Researchers publish intrusion analysis',
      link: 'https://unit42.paloaltonetworks.com/example-research/',
      date: new Date('2026-06-17T17:00:00.000Z'),
      source: 'Unit 42',
      summary: 'Research team analysis of intrusion activity.',
    },
    {
      title: 'Security news roundup',
      link: 'https://www.bleepingcomputer.com/news/security/example/',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Bleeping Computer',
      summary: 'Industry reporting on security activity.',
    },
    {
      title: 'Community security notes',
      link: 'https://example.com/security-notes',
      date: new Date('2026-06-17T15:00:00.000Z'),
      source: 'Example <Security>',
      summary: 'General monitoring notes.',
    },
  ]);

  assert.match(html, /<div class="digest-legend-group source-signal-legend" aria-label="Source signal legend">/);
  assert.match(html, /<div class="digest-legend-heading">Source signals<\/div>/);
  assert.match(html, /<span class="source-signal-name">Vendor advisory<\/span><span class="source-signal-detail">Vendor or product-owner guidance<\/span>/);
  assert.match(html, /<span class="source-signal-name">Research team<\/span><span class="source-signal-detail">Threat research or lab analysis<\/span>/);
  assert.match(html, /<span class="source-signal-name">Industry media<\/span><span class="source-signal-detail">Security news reporting<\/span>/);
  assert.match(html, /<span class="source-signal-name">General source<\/span><span class="source-signal-detail">Monitor for added context<\/span>/);
  assert.doesNotMatch(html, /Example <Security>/);
});

test('generateHTML omits absent source signal legend entries', () => {
  const html = generateHTML([
    {
      title: 'Security news roundup',
      link: 'https://www.bleepingcomputer.com/news/security/example/',
      date: new Date('2026-06-17T16:00:00.000Z'),
      source: 'Bleeping Computer',
      summary: 'Industry reporting on security activity.',
    },
  ]);

  assert.match(html, /<div class="digest-legend-group source-signal-legend" aria-label="Source signal legend">/);
  assert.match(html, /<span class="source-signal-name">Industry media<\/span>/);
  assert.doesNotMatch(html, /Vendor or product-owner guidance/);
  assert.doesNotMatch(html, /Threat research or lab analysis/);
  assert.doesNotMatch(html, /Monitor for added context/);
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

test('collectSourceCoverage includes configured sources with zero articles', () => {
  const coverage = collectSourceCoverage([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story one.',
    },
  ], ['Quiet Feed', 'Example Security']);

  assert.deepEqual(coverage, [
    { source: 'Example Security', count: 1 },
    { source: 'Quiet Feed', count: 0 },
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

  assert.match(html, /<div id="activeFilters" class="active-filters" role="list" aria-label="Active filter chips" hidden><\/div>/);
  assert.match(html, /<div id="filterStatusAnnouncement" class="sr-only" role="status" aria-live="polite" aria-atomic="true">Showing 1 of 1 article\.<\/div>/);
  assert.match(html, /<button id="resetFilters" class="btn reset-filters" type="button" hidden>Reset filters<\/button>/);
  assert.match(html, /<button id="emptyResetFilters" class="btn empty-reset-filters" type="button">Reset filters<\/button>/);
  assert.match(html, /const activeFilters = q\('#activeFilters'\)/);
  assert.match(html, /const filterStatusAnnouncement = q\('#filterStatusAnnouncement'\)/);
  assert.match(html, /const resetFilters = q\('#resetFilters'\)/);
  assert.match(html, /const emptyResetFilters = q\('#emptyResetFilters'\)/);
  assert.match(html, /function renderActiveFilters\(\)/);
  assert.match(html, /chip\.className = 'active-filter-chip'/);
  assert.match(html, /chip\.setAttribute\('role', 'listitem'\)/);
  assert.match(html, /chipText\.textContent = filterLabels\[key\] \+ ': ' \+ label/);
  assert.match(html, /const clearButton = document\.createElement\('button'\)/);
  assert.match(html, /clearButton\.className = 'active-filter-clear'/);
  assert.match(html, /clearButton\.type = 'button'/);
  assert.match(html, /clearButton\.setAttribute\('data-filter-key', key\)/);
  assert.match(html, /clearButton\.setAttribute\('aria-label', 'Clear ' \+ filterLabels\[key\] \+ ': ' \+ label \+ ' filter'\)/);
  assert.match(html, /clearButton\.textContent = '×'/);
  assert.match(html, /activeFilters\.addEventListener\('click', function\(event\)/);
  assert.match(html, /const key = target\.getAttribute\('data-filter-key'\)/);
  assert.match(html, /if \(filterControls\[key\]\) filterControls\[key\]\.value = ''/);
  assert.match(html, /resetFilters\.hidden = activeFiltersList\.length === 0/);
  assert.match(html, /function clearFilters\(options\)/);
  assert.match(html, /control\.value = ''/);
  assert.match(html, /if \(resetFilters\) resetFilters\.addEventListener\('click', function\(\)\{ clearFilters\(\{ focusRecoveryTarget: true \}\); \}\)/);
  assert.match(html, /if \(emptyResetFilters\) emptyResetFilters\.addEventListener\('click', function\(\)\{ clearFilters\(\{ focusRecoveryTarget: true \}\); \}\)/);
  assert.match(html, /const totalArticleLabel = total === 1 \? 'article' : 'articles'/);
  assert.match(html, /function getFilterStatusText\(visible, total, actionLabel, emptyFilteredStatusText\)/);
  assert.match(html, /return actionLabel \? actionLabel \+ ' ' \+ resultText : resultText/);
  assert.match(html, /function update\(statusActionLabel\)/);
  assert.match(html, /const safeStatusActionLabel = typeof statusActionLabel === 'string' \? statusActionLabel : ''/);
  assert.match(html, /if \(filterStatusAnnouncement\) filterStatusAnnouncement\.textContent = getFilterStatusText\(visible, total, safeStatusActionLabel, emptyFilteredStatusText\)/);
  assert.match(html, /update\('Filters reset\.'\)/);
  assert.match(html, /const clearedLabel = filterLabels\[key\] \|\| 'Selected'/);
  assert.match(html, /const clearedValue = filterControls\[key\] \? getControlLabel\(filterControls\[key\]\) : ''/);
  assert.match(html, /const clearedStatus = clearedValue \? 'Cleared ' \+ clearedLabel \+ ': ' \+ clearedValue \+ ' filter\.' : 'Cleared ' \+ clearedLabel \+ ' filter\.'/);
  assert.match(html, /update\(clearedStatus\)/);
  assert.match(html, /renderActiveFilters\(\);\s+renderFilterInsights\(visibleCards\);\s+updateOperatorLanes\(visibleCards\);\s+syncQueryState\(\);/);
});

test('generateHTML renders explicit keyboard focus states for filter controls', () => {
  const html = generateHTML([
    {
      title: 'Critical Cisco exploit campaign',
      link: 'https://example.com/cisco',
      pubDate: 'Wed, 25 Jun 2026 12:00:00 GMT',
      date: '2026-06-25T12:00:00.000Z',
      source: 'Example Source',
      summary: 'Cisco exploit campaign with ransomware follow-on risk.'
    }
  ], { sourceNames: ['Example Source'] });

  assert.match(html, /\.search:focus-within \{ border-color: var\(--accent\); box-shadow: 0 0 0 3px rgba\(37,99,235,0\.15\); outline: 2px solid var\(--accent\); outline-offset: 2px; \}/);
  assert.match(html, /\.select:focus-visible, \.btn:focus-visible \{ border-color: var\(--accent\); box-shadow: 0 0 0 3px rgba\(37,99,235,0\.15\); outline: 2px solid var\(--accent\); outline-offset: 2px; \}/);
  assert.match(html, /\.active-filter-clear:hover, \.active-filter-clear:focus-visible \{ background: var\(--chip\); color: var\(--accent\); outline: 2px solid var\(--accent\); outline-offset: 1px; \}/);
});

test('generateHTML renders explicit keyboard focus states for source shortcuts', () => {
  const html = generateHTML([
    {
      title: 'Critical Cisco exploit campaign',
      link: 'https://example.com/cisco',
      pubDate: 'Wed, 25 Jun 2026 12:00:00 GMT',
      date: '2026-06-25T12:00:00.000Z',
      source: 'Example Source',
      summary: 'Cisco exploit campaign with ransomware follow-on risk.'
    }
  ], { sourceNames: ['Example Source'] });

  assert.match(html, /\.source-count:hover, \.source-count:focus-visible, \.source-count\[aria-pressed="true"\] \{ border-color: var\(--accent\); \}/);
  assert.match(html, /\.source-count:focus-visible \{ box-shadow: 0 0 0 3px rgba\(37,99,235,0\.15\); outline: 2px solid var\(--accent\); outline-offset: 2px; \}/);
  assert.match(html, /\.source-count-empty:focus-visible \{ box-shadow: none; outline: none; \}/);
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

  assert.match(html, /<div id="filterInsights" class="filter-insights" role="status" aria-live="polite" aria-atomic="true" hidden><\/div>/);
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

test('generateHTML renders a compact digest issue metadata bar', () => {
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

  assert.match(html, /<section class="issue-strip" aria-label="Digest issue metadata">/);
  assert.match(html, /<span class="issue-label">Current issue<\/span>/);
  assert.match(html, /<time datetime="2026-06-17T18:00:00.000Z">June 17, 2026<\/time>/);
  assert.match(html, /<span class="issue-stat"><strong>2<\/strong> articles<\/span>/);
  assert.match(html, /<span class="issue-stat"><strong>2<\/strong> sources<\/span>/);
  assert.match(html, /<a class="issue-link" href="\.\/feed\.xml" aria-label="Open generated RSS archive">RSS archive<\/a>/);
});

test('generateHTML renders a compact feed archive trail', () => {
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

  assert.ok(html.includes(`<nav class="${ISSUE_TRAIL_CONTRACT.navClass}" aria-label="Digest archive trail">`));
  assert.match(html, /<span class="issue-trail-current" aria-current="page">Current digest<\/span>/);
  assert.ok(html.includes(`<a href="${ISSUE_TRAIL_CONTRACT.feedHref}" aria-label="Open generated RSS feed">RSS feed</a>`));
  assert.ok(html.includes(`<a href="${ISSUE_TRAIL_CONTRACT.sourceCoverageHref}">Source coverage</a>`));
  assert.ok(html.includes(`<span id="${ISSUE_TRAIL_CONTRACT.sourceCoverageAnchorId}" class="anchor-target" aria-hidden="true"></span>`));
  assert.match(html, /<section class="source-coverage" aria-label="RSS source coverage">/);
});

test('generateHTML labels repeated RSS navigation links', () => {
  const html = generateHTML([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story one.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.ok(html.includes('<a class="btn" href="./feed.xml" aria-label="Open generated RSS feed">RSS</a>'));
  assert.ok(html.includes('<a data-rss-link href="./feed.xml" aria-label="Open generated RSS feed">RSS Feed</a>'));
  assert.match(html, /<a class="feed-link" href="\.\/feed\.xml" aria-label="Open RSS feed with 1 latest article">RSS feed <span class="feed-link-count">1 item<\/span><\/a>/);
});

test('generateHTML renders feed update cadence in the archive trail', () => {
  const html = generateHTML([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story one.',
    },
  ], { generatedAt: new Date('2026-06-17T18:05:00.000Z') });

  assert.match(html, /<span class="issue-trail-meta">Updated <time datetime="2026-06-17T18:05:00.000Z">18:05 UTC<\/time><\/span>/);
  assert.ok(html.includes(`<span class="issue-trail-meta">${ISSUE_TRAIL_CONTRACT.cadenceText}</span>`));
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

  assert.ok(html.includes(`<section class="${SOURCE_COVERAGE_CONTRACT.sectionClass}" aria-label="RSS source coverage">`));
  assert.ok(html.includes(`<button class="source-count" type="button" ${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}="Example &lt;Security&gt;" aria-label="Filter to Example &lt;Security&gt; source, 2 articles" aria-pressed="false">Example &lt;Security&gt; <strong>2</strong></button>`));
  assert.ok(html.includes(`<button class="source-count" type="button" ${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}="Another Source" aria-label="Filter to Another Source source, 1 article" aria-pressed="false">Another Source <strong>1</strong></button>`));
  assert.match(html, /<a class="feed-link" href="\.\/feed\.xml" aria-label="Open RSS feed with 3 latest articles">RSS feed <span class="feed-link-count">3 items<\/span><\/a>/);
  assert.doesNotMatch(html, /Example <Security>/);
});

test('generateHTML renders singular RSS item count for feed inspection', () => {
  const html = generateHTML([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story one.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /<a class="feed-link" href="\.\/feed\.xml" aria-label="Open RSS feed with 1 latest article">RSS feed <span class="feed-link-count">1 item<\/span><\/a>/);
});

test('generateHTML renders quiet configured feeds as inert source coverage chips', () => {
  const html = generateHTML([
    {
      title: 'First story',
      link: 'https://example.com/first',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example <Security>',
      summary: 'Story one.',
    },
  ], {
    generatedAt: new Date('2026-06-17T18:00:00.000Z'),
    sourceNames: ['Quiet <Feed>', 'Example <Security>'],
  });

  assert.ok(html.includes(`<button class="source-count" type="button" ${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}="Example &lt;Security&gt;" aria-label="Filter to Example &lt;Security&gt; source, 1 article" aria-pressed="false">Example &lt;Security&gt; <strong>1</strong></button>`));
  assert.ok(html.includes(`<button class="source-count source-count-empty" type="button" ${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}="Quiet &lt;Feed&gt;" aria-label="Quiet &lt;Feed&gt; source has no current articles" aria-pressed="false" aria-disabled="true" disabled>Quiet &lt;Feed&gt; <strong>0</strong></button>`));
  assert.ok(html.includes('<div class="source-health-summary" data-active-sources="1" data-quiet-sources="1">'));
  assert.ok(html.includes('<span><strong>1</strong> active feed</span>'));
  assert.ok(html.includes(`<span><strong>1</strong> quiet feed</span> <span class="source-health-note">${SOURCE_COVERAGE_CONTRACT.healthNoteText}</span>`));
  assert.doesNotMatch(html, /Quiet <Feed>/);
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

  assert.ok(html.includes(`const sourceCoverageButtons = qa('${SOURCE_COVERAGE_CONTRACT.buttonSelector}')`));
  assert.ok(html.includes('<div class="source-filter-status" data-source-filter-status role="status" aria-live="polite" aria-atomic="true">Source shortcut: All active feeds (2 articles)</div>'));
  assert.ok(html.includes(`const sourceFilterStatus = q('${SOURCE_COVERAGE_CONTRACT.statusSelector}')`));
  assert.match(html, /sourceCoverageButtons\.forEach\(function\(button\)/);
  assert.ok(html.includes(`const source = button.getAttribute('${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}') || ''`));
  assert.match(html, /const nextSource = sourceFilter\.value === source \? '' : source/);
  assert.match(html, /sourceFilter\.value = nextSource/);
  assert.ok(html.includes(`button.setAttribute('aria-pressed', button.getAttribute('${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}') === src ? 'true' : 'false')`));
  assert.ok(html.includes("const hasComposedFilters = Boolean(term || severity || tag || vendor || age || handoff)"));
  assert.ok(html.includes("const countLabel = hasComposedFilters ? (articleLabel === 'article' ? 'filtered article' : 'filtered articles') : articleLabel"));
  assert.ok(html.includes("sourceFilterStatus.textContent = (src ? 'Source shortcut: ' + getControlLabel(sourceFilter) : 'Source shortcut: All active feeds') + ' (' + visible + ' ' + countLabel + ')'"));
  assert.ok(html.includes("const sourceShortcutStatus = nextSource ? 'Source shortcut: ' + getControlLabel(sourceFilter) + '.' : 'Source shortcut cleared.'"));
  assert.match(html, /update\(sourceShortcutStatus\);/);
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

test('generateHTML composes empty filtered state with active source shortcut context', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited by ransomware crew',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
    },
  ], { generatedAt: new Date('2026-06-17T18:00:00.000Z') });

  assert.match(html, /function renderEmptyFilteredState\(visible, src, hasComposedFilters\)/);
  assert.match(html, /function getEmptyFilteredMessage\(src, hasComposedFilters\)/);
  assert.ok(html.includes("const sourceLabel = src ? getControlLabel(sourceFilter) : ''"));
  assert.ok(html.includes("return sourceLabel && hasComposedFilters ? 'No ' + sourceLabel + ' articles match the current filters.' : 'No articles match the current filters.'"));
  assert.ok(html.includes("const messageTarget = emptyFilteredMessage || emptyFilteredState"));
  assert.ok(html.includes("messageTarget.textContent = getEmptyFilteredMessage(src, hasComposedFilters)"));
  assert.match(html, /const emptyFilteredStatusText = visible === 0 \? getEmptyFilteredMessage\(src, hasComposedFilters\) : ''/);
  assert.match(html, /getFilterStatusText\(visible, total, safeStatusActionLabel, emptyFilteredStatusText\)/);
  assert.match(html, /renderEmptyFilteredState\(visible, src, hasComposedFilters\)/);
});

test('generateHTML returns focus to search after empty-state reset', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited by ransomware crew',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
    },
  ]);

  assert.match(html, /function focusFilterRecoveryTarget\(\)/);
  assert.match(html, /if \(search && typeof search\.focus === 'function'\) search\.focus\(\)/);
  assert.match(html, /function clearFilters\(options\)/);
  assert.match(html, /const shouldFocusRecoveryTarget = options && options\.focusRecoveryTarget/);
  assert.match(html, /if \(shouldFocusRecoveryTarget\) focusFilterRecoveryTarget\(\)/);
  assert.match(html, /if \(resetFilters\) resetFilters\.addEventListener\('click', function\(\)\{ clearFilters\(\{ focusRecoveryTarget: true \}\); \}\)/);
  assert.match(html, /if \(emptyResetFilters\) emptyResetFilters\.addEventListener\('click', function\(\)\{ clearFilters\(\{ focusRecoveryTarget: true \}\); \}\)/);
});

test('generateHTML recovers focus after active filter chip clearing', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited by ransomware crew',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
    },
  ]);

  assert.match(html, /function focusActiveFilterRecoveryTarget\(preferredIndex\)/);
  assert.ok(html.includes("const remainingClearButtons = activeFilters ? Array.from(activeFilters.querySelectorAll('.active-filter-clear')) : [];"));
  assert.ok(html.includes('const nextClearButton = remainingClearButtons[Math.min(preferredIndex, remainingClearButtons.length - 1)];'));
  assert.match(html, /if \(nextClearButton && typeof nextClearButton\.focus === 'function'\) \{/);
  assert.match(html, /nextClearButton\.focus\(\)/);
  assert.match(html, /focusFilterRecoveryTarget\(\)/);
  assert.ok(html.includes("const clearButtonsBefore = activeFilters ? Array.from(activeFilters.querySelectorAll('.active-filter-clear')) : [];"));
  assert.ok(html.includes('const clearedIndex = clearButtonsBefore.indexOf(target);'));
  assert.ok(html.includes('const hasRemainingActiveFilters = clearButtonsBefore.length > 1;'));
  assert.match(html, /const clearedValue = filterControls\[key\] \? getControlLabel\(filterControls\[key\]\) : ''/);
  assert.match(html, /update\(clearedStatus\)/);
  assert.match(html, /hasRemainingActiveFilters \? focusActiveFilterRecoveryTarget\(clearedIndex\) : focusFilterRecoveryTarget\(\)/);
});

test('generateHTML recovers focus after source shortcut toggling', () => {
  const html = generateHTML([
    {
      title: 'Microsoft Exchange zero-day exploited by ransomware crew',
      link: 'https://security.example.com/microsoft-exchange-zero-day',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'SecurityWeek',
      summary: 'CVE-2026-1234 is under active exploitation in data breach investigations.',
    },
  ]);

  assert.match(html, /function focusSourceShortcutRecoveryTarget\(source\)/);
  assert.ok(html.includes(`return button.getAttribute('${SOURCE_COVERAGE_CONTRACT.buttonDataAttribute}') === source;`));
  assert.match(html, /if \(targetButton && typeof targetButton\.focus === 'function'\) \{/);
  assert.match(html, /targetButton\.focus\(\)/);
  assert.match(html, /focusFilterRecoveryTarget\(\)/);
  assert.match(html, /const nextSource = sourceFilter\.value === source \? '' : source/);
  assert.match(html, /sourceFilter\.value = nextSource/);
  assert.ok(html.includes("const sourceShortcutStatus = nextSource ? 'Source shortcut: ' + getControlLabel(sourceFilter) + '.' : 'Source shortcut cleared.'"));
  assert.match(html, /update\(sourceShortcutStatus\);\s+focusSourceShortcutRecoveryTarget\(source\);/);
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
