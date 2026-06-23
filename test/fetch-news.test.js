const assert = require('node:assert/strict');
const test = require('node:test');

const {
  INVALID_FEED_DATE_FALLBACK,
  normalizeArticleDate,
  normalizeFeedDate,
} = require('../scripts/fetch-news');
const { deriveArticleFacets, generateHTML } = require('../scripts/render-news-html');

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
