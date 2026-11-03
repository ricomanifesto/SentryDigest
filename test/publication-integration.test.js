const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const SITE_CONFIG = JSON.parse(read('publication/site.json'));
const LEGAL_STATES = [
  { mode: 'disabled', proof: 'off' },
  { mode: 'prepare', proof: 'off' },
  { mode: 'prepare', proof: 'on' },
  { mode: 'active', proof: 'on' },
];
const LEGACY = (site) => `https://ricomanifesto.github.io/${site}/`;
const PRODUCTION = {
  SentryDigest: 'https://sentrydigest.ricomanifesto.com/',
  SentryInsight: 'https://sentryinsight.ricomanifesto.com/',
  GRCInsight: 'https://grcinsight.ricomanifesto.com/',
};
const emitted = (site, config = SITE_CONFIG) => config.origins[site][config.origins[site].emitted];

// Loads the generators under a substituted publication/site.json in a fresh
// process and reports what they emit and how they identify history.
function underConfig(t, config) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'digest-activation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    const [root, configJson, dir] = process.argv.slice(1);
    const sitePath = require.resolve(path.join(root, 'publication', 'site.json'));
    require.cache[sitePath] = { id: sitePath, filename: sitePath, loaded: true, exports: JSON.parse(configJson) };
    const contracts = require(path.join(root, 'scripts', 'generated-artifact-contracts'));
    const archive = require(path.join(root, 'scripts', 'digest-archive'));
    const findings = require(path.join(root, 'scripts', 'current-insight-findings'));
    const { generateRSSFeed } = require(path.join(root, 'scripts', 'generate-rss'));
    const silent = { log() {}, warn() {}, error() {} };
    generateRSSFeed({ rssOutputPath: path.join(dir, 'feed.xml'), feedInfoPath: path.join(dir, 'feed-info.json'), now: new Date('2026-11-01T00:00:00Z'), logger: silent });
    const feed = fs.readFileSync(path.join(dir, 'feed.xml'), 'utf8');
    const identities = archive.listDigestIssueDates(root).map((date) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'archive', date, 'index.json'), 'utf8'));
      return [date, manifest.articles.map((article, index) => archive.canonicalArchiveArticle(article, index))];
    });
    process.stdout.write(JSON.stringify({
      digestRoot: archive.PUBLIC_ROOT,
      feedUrl: contracts.FEED_INFO_CONTRACT.publicFeedUrl,
      grcHandoff: contracts.HANDOFF_DESTINATION_CONTRACT.destinations['GRCInsight: governance watch'],
      insightReport: findings.INSIGHT_REPORT_URL,
      insightAccepted: findings.INSIGHT_REPORT_URLS,
      guids: [...feed.matchAll(/<guid[^>]*>([^<]*)<\\/guid>/g)].map((match) => match[1]),
      archiveIdentity: crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex'),
      archiveIssues: identities.length,
    }));
  `;
  const out = require('node:child_process').execFileSync(process.execPath, ['-e', script, ROOT, JSON.stringify(config), dir], { encoding: 'utf8' });
  return JSON.parse(out);
}

function withState(publication, emission) {
  const config = JSON.parse(JSON.stringify(SITE_CONFIG));
  config.publication = publication;
  for (const origins of Object.values(config.origins)) origins.emitted = emission;
  return config;
}

const ARTICLE = {
  title: '  Vendor patches exploited flaw  ',
  link: 'https://example.com/security/advisory#comments',
  date: '2026-08-13T20:00:00Z',
  source: 'Example Security',
  summary: 'Attackers are exploiting the issue.',
  firstSeen: '2026-08-13T20:30:00.000Z',
};

test('digest_content_digest follows canonical article content, not timestamps or hosting', () => {
  const { digestContentDigest } = require('../scripts/digest-content-identity');
  const base = digestContentDigest([ARTICLE]);
  assert.match(base, /^[0-9a-f]{64}$/);

  for (const [name, change] of [
    ['title', { title: 'Vendor patches actively exploited flaw' }],
    ['summary', { summary: 'Attackers are exploiting the issue widely.' }],
    ['date', { date: '2026-08-13T21:00:00Z' }],
    ['source', { source: 'Other Security' }],
  ]) {
    assert.notEqual(digestContentDigest([{ ...ARTICLE, ...change }]), base, name);
  }
  for (const [name, change] of [
    ['firstSeen', { firstSeen: '2026-08-14T00:00:00.000Z' }],
    ['link fragment', { link: 'https://example.com/security/advisory' }],
    ['equivalent date form', { date: '2026-08-13T20:00:00.000Z' }],
    ['surrounding whitespace', { title: 'Vendor patches exploited flaw', summary: ' Attackers are exploiting the issue. ' }],
  ]) {
    assert.equal(digestContentDigest([{ ...ARTICLE, ...change }]), base, name);
  }
  const second = { ...ARTICLE, link: 'https://example.com/other', title: 'Second' };
  assert.notEqual(digestContentDigest([ARTICLE, second]), base);
  assert.equal(digestContentDigest([ARTICLE, second]), digestContentDigest([second, ARTICLE]));
  assert.notEqual(digestContentDigest([]), base);
});

test('the publication configuration is a legal activation state with the confirmed origins', () => {
  // Any legal state passes the ordinary gates; the shipped initial state is
  // verified separately as a candidate fact.
  const { loadSiteConfig } = require('../publication/kit/config');
  const config = loadSiteConfig(read('publication/site.json'));
  assert.equal(config.site, 'SentryDigest');
  assert.ok(LEGAL_STATES.some((state) => state.mode === config.publication.mode && state.proof === config.publication.proof));
  for (const [site, production] of Object.entries(PRODUCTION)) {
    assert.equal(config.origins[site].legacy, LEGACY(site));
    assert.equal(config.origins[site].production, production);
    assert.ok(['legacy', 'production'].includes(config.origins[site].emitted));
  }
  for (const state of LEGAL_STATES) {
    for (const emission of ['legacy', 'production']) assert.doesNotThrow(() => loadSiteConfig(JSON.stringify(withState(state, emission))));
  }
  assert.deepEqual(config.consumers.map((consumer) => consumer.name), ['SentryInsight', 'GRCInsight']);
  assert.deepEqual(config.payload_builder, ['node', 'scripts/build-static-artifact.js']);
});

test('Insight report URLs are accepted from the configured legacy and production set only', () => {
  const findings = require('../scripts/current-insight-findings');
  const context = require('../scripts/insight-sync-context');
  const valid = {
    schema_version: 1,
    report_date: '2026-11-01',
    generated_at: '2026-11-01T06:30:00Z',
    report_url: 'https://ricomanifesto.github.io/SentryInsight/',
    finding_count: 3,
    complete_cve_count: 1,
    cve_ids: ['CVE-2026-0001'],
  };
  assert.doesNotThrow(() => findings.assertCurrentInsightFindings(valid));
  assert.doesNotThrow(() => findings.assertCurrentInsightFindings({ ...valid, report_url: 'https://sentryinsight.ricomanifesto.com/' }));
  for (const url of ['https://sentryinsight-x.vercel.app/', 'https://ricomanifesto.github.io/GRCInsight/', 'https://sentryinsight.ricomanifesto.com/reports/']) {
    assert.throws(() => findings.assertCurrentInsightFindings({ ...valid, report_url: url }), /report_url/, url);
  }
  assert.equal(findings.INSIGHT_REPORT_URL, emitted('SentryInsight'));
  assert.equal(findings.CURRENT_FINDINGS_URL, `${emitted('SentryInsight')}current-findings.json`);
  assert.deepEqual(findings.INSIGHT_REPORT_URLS, ['https://ricomanifesto.github.io/SentryInsight/', 'https://sentryinsight.ricomanifesto.com/']);

  const snapshot = {
    schema_version: 2,
    mode: 'current',
    checked_at: '2026-11-01T07:00:00.000Z',
    report_date: '2026-11-01',
    manifest_generated_at: '2026-11-01T06:30:00Z',
    report_url: 'https://sentryinsight.ricomanifesto.com/',
  };
  assert.doesNotThrow(() => context.assertInsightSyncContext(snapshot));
  assert.throws(() => context.assertInsightSyncContext({ ...snapshot, report_url: 'https://example.com/' }), /canonical SentryInsight report/);
});

test('emitted public URLs follow the configured emitted origins', () => {
  const contracts = require('../scripts/generated-artifact-contracts');
  const digest = emitted('SentryDigest');
  assert.equal(contracts.FEED_INFO_CONTRACT.publicFeedUrl, `${digest}feed.xml`);
  assert.equal(contracts.RSS_CHANNEL_CONTRACT.publicSiteUrl, digest);
  assert.equal(contracts.RSS_CHANNEL_CONTRACT.imageUrl, `${digest}assets/icon-512.png`);
  assert.equal(contracts.SITE_METADATA_CONTRACT.imageUrl, `${digest}assets/social-preview.png`);
  assert.equal(contracts.HANDOFF_DESTINATION_CONTRACT.destinations['GRCInsight: governance watch'], emitted('GRCInsight'));
  assert.equal(contracts.HANDOFF_DESTINATION_CONTRACT.destinations['SentryInsight: monitor'], emitted('SentryInsight'));
  assert.equal(require('../scripts/digest-archive').PUBLIC_ROOT, digest);
});

test('every legal state and emission keeps feed GUIDs, archive identities and accepted provenance stable', (t) => {
  const baseline = underConfig(t, withState(LEGAL_STATES[0], 'legacy'));
  assert.ok(baseline.guids.length > 0);
  assert.ok(baseline.archiveIssues > 0);
  for (const state of LEGAL_STATES) {
    for (const emission of ['legacy', 'production']) {
      const observed = underConfig(t, withState(state, emission));
      const label = `${state.mode}/${state.proof} ${emission}`;
      const origin = (site) => (emission === 'production' ? PRODUCTION[site] : LEGACY(site));
      assert.equal(observed.digestRoot, origin('SentryDigest'), label);
      assert.equal(observed.feedUrl, `${origin('SentryDigest')}feed.xml`, label);
      assert.equal(observed.grcHandoff, origin('GRCInsight'), label);
      assert.equal(observed.insightReport, origin('SentryInsight'), label);
      assert.deepEqual(observed.insightAccepted, [LEGACY('SentryInsight'), PRODUCTION.SentryInsight], label);
      assert.deepEqual(observed.guids, baseline.guids, label);
      assert.equal(observed.archiveIdentity, baseline.archiveIdentity, label);
    }
  }
});

test('the static builder excludes the publication tooling from the payload', () => {
  const { classifyTrackedPath } = require('../scripts/build-static-artifact');
  for (const relativePath of ['publication/site.json', 'publication/cli.js', 'publication/kit/publisher.js', 'publication/adapter/build.js', 'publication/test/core.test.js', 'publication/README.md']) {
    assert.equal(classifyTrackedPath(relativePath), 'exclude', relativePath);
  }
});

test('the publisher workflow is serialized, explicit and the only content-write path', () => {
  const workflow = read('.github/workflows/publish-production.yml');
  assert.match(workflow, /^on:\n {2}workflow_call:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^ {2}(push|schedule|repository_dispatch|pull_request):/m);
  assert.match(workflow, /^permissions:\n {2}contents: write\n/m);
  assert.doesNotMatch(workflow, /actions: write|id-token|secrets: inherit/);
  assert.match(workflow, /concurrency:\n {2}group: publish-production\n {2}cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /node publication\/cli\.js "\$INVOCATION"/);
  assert.match(workflow, /REPO_ACCESS_TOKEN: \$\{\{ secrets\.REPO_ACCESS_TOKEN \}\}/);
  // A manual publish runs the same repository gate as the scheduled update.
  assert.match(workflow, /- name: Run repository gate\n\s+if: inputs\.invocation == 'publish'\n\s+run: npm test/);
});

test('the update workflow hands the post-push commit to the publisher and gates the legacy notifier', () => {
  const workflow = read('.github/workflows/update-news.yml');
  assert.match(workflow, /outputs:\n\s+commit_sha: \$\{\{ steps\.commit\.outputs\.commit_sha \}\}\n\s+head_sha: \$\{\{ steps\.commit\.outputs\.head_sha \}\}/);
  assert.match(workflow, /\n\s+fi\n\s+# The pushed commit, or the unchanged head, for the publisher\.\n\s+echo "head_sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"\n/);
  assert.match(workflow, /- name: Read current notification authority\n\s+id: authority\n[\s\S]*?node publication\/cli\.js authority/);
  const authorityIndex = workflow.indexOf('id: authority');
  for (const step of ['- name: Trigger SentryInsight Analysis', '- name: Trigger GRC Insight Analysis']) {
    const index = workflow.indexOf(step);
    assert.ok(index > authorityIndex, step);
    assert.match(workflow.slice(index, index + 200), /if: steps\.commit\.outputs\.changes_made == 'true' && steps\.authority\.outputs\.mode != 'active'/);
  }
  assert.match(workflow, /publish:\n\s+needs: update-news\n\s+uses: \.\/\.github\/workflows\/publish-production\.yml\n\s+with:\n\s+invocation: publish\n\s+source_sha: \$\{\{ needs\.update-news\.outputs\.head_sha \}\}\n\s+secrets:\n\s+REPO_ACCESS_TOKEN: \$\{\{ secrets\.REPO_ACCESS_TOKEN \}\}/);
  assert.match(workflow, /^permissions:\n {2}contents: write\n/m);
  assert.doesNotMatch(workflow, /actions: write/);
});
