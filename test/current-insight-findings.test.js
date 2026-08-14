const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertCurrentInsightFindings,
  getCurrentInsightCves,
} = require('../scripts/current-insight-findings');
const { syncCurrentInsightFindings } = require('../scripts/sync-insight-findings');

const MANIFEST = {
  schema_version: 1,
  report_date: '2026-08-13',
  generated_at: '2026-08-13T21:54:18Z',
  report_url: 'https://ricomanifesto.github.io/SentryInsight/',
  finding_count: 14,
  complete_cve_count: 2,
  cve_ids: ['CVE-2026-59310', 'CVE-2026-71362'],
};

test('current Insight findings expose a fresh complete CVE membership set', () => {
  assert.equal(assertCurrentInsightFindings(MANIFEST), MANIFEST);
  assert.deepEqual(
    [...getCurrentInsightCves(MANIFEST, new Date('2026-08-13T23:00:00Z'))],
    MANIFEST.cve_ids,
  );
});

test('current Insight findings reject malformed or duplicate CVE membership', () => {
  assert.throws(
    () => assertCurrentInsightFindings({
      ...MANIFEST,
      cve_ids: ['CVE-2026-59310', 'CVE-2026-59310'],
    }),
    /unique complete CVE IDs/,
  );
  assert.throws(
    () => assertCurrentInsightFindings({ ...MANIFEST, report_url: 'https://example.com/' }),
    /canonical report/,
  );
});

test('current Insight findings become unavailable rather than authoritative when stale', () => {
  assert.equal(
    getCurrentInsightCves(MANIFEST, new Date('2026-08-16T00:00:00Z')),
    null,
  );
});

test('current Insight findings become unavailable when their timestamp is in the future', () => {
  assert.equal(
    getCurrentInsightCves(
      { ...MANIFEST, generated_at: '2026-08-13T23:30:00Z' },
      new Date('2026-08-13T23:00:00Z'),
    ),
    null,
  );
});

test('sync retains a last-known-good snapshot when the public manifest is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-insight-findings-'));
  const outputPath = path.join(root, 'sentryinsight-findings.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(MANIFEST, null, 2)}\n`);
  const warnings = [];

  const result = await syncCurrentInsightFindings({
    outputPath,
    now: new Date('2026-08-13T23:00:00Z'),
    fetchImpl: async () => { throw new Error('offline'); },
    logger: { log() {}, warn(message) { warnings.push(message); } },
  });

  assert.equal(result.retained, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), MANIFEST);
  assert.match(warnings.join('\n'), /retaining last-known-good snapshot/);
});

test('sync atomically replaces a valid current snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-insight-refresh-'));
  const outputPath = path.join(root, 'sentryinsight-findings.json');

  const result = await syncCurrentInsightFindings({
    outputPath,
    now: new Date('2026-08-13T23:00:00Z'),
    fetchImpl: async () => ({ ok: true, json: async () => MANIFEST }),
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), MANIFEST);
  assert.equal(fs.existsSync(`${outputPath}.tmp`), false);
});

test('sync never replaces a newer current-finding snapshot with older state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-insight-monotonic-'));
  const outputPath = path.join(root, 'sentryinsight-findings.json');
  const newer = {
    ...MANIFEST,
    generated_at: '2026-08-13T22:54:18Z',
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(newer, null, 2)}\n`);

  const result = await syncCurrentInsightFindings({
    outputPath,
    now: new Date('2026-08-13T23:00:00Z'),
    fetchImpl: async () => ({ ok: true, json: async () => MANIFEST }),
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.changed, false);
  assert.equal(result.retained, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), newer);
});
