const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');
const VERIFIER = path.join(
  REPO_ROOT,
  'contracts',
  'reporting-identity-verifier-v1.py',
);
const RUNBOOK = path.join(REPO_ROOT, 'contracts', 'README.md');
const EXPECTED_GATES = [
  'SentryInsight: `.github/workflows/validate.yml`',
  'SentryInsight: `.github/workflows/generate-report.yml`',
  'GRCInsight: `.github/workflows/ci.yml`',
  'GRCInsight: `.github/workflows/deploy-site.yml`',
  'GRCInsight: `.github/workflows/deploy-lambda.yml`',
  'GRCInsight: `.github/workflows/lambda-report-generation.yml`',
];

function runVerifier(args) {
  return spawnSync('python3', [VERIFIER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('runbook inventories every current consumer gate', () => {
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  for (const gate of EXPECTED_GATES) assert.ok(runbook.includes(gate), gate);
  assert.match(runbook, /Exit 2 means the canonical\s+artifact/);
  assert.match(runbook, /exit 3 means canonical bytes were fetched/i);
  assert.match(runbook, /retries canonical fetches four\s+times/i);
});

test('versioned verifier bytes are immutable', () => {
  const bytes = fs.readFileSync(VERIFIER);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, '1d2d2288de826cd45fc72ad3e95e86474fbb72ec4b104a305db17f3b3b32081b');
});

test('verifier reports matching bytes and distinct drift', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reporting-verifier-'));
  const local = path.join(directory, 'local');
  const canonical = path.join(directory, 'canonical');
  fs.writeFileSync(local, 'same\n');
  fs.writeFileSync(canonical, 'same\n');

  const match = runVerifier([
    'compare', '--artifact', 'contract', '--local-artifact', local,
    '--canonical-artifact', canonical,
  ]);
  assert.equal(match.status, 0, match.stderr);
  assert.match(match.stdout, /verified: SHA-256/);

  fs.writeFileSync(canonical, 'different\n');
  const drift = runVerifier([
    'compare', '--artifact', 'contract', '--local-artifact', local,
    '--canonical-artifact', canonical,
  ]);
  assert.equal(drift.status, 3);
  assert.match(drift.stderr, /Reporting Identity Contract drift/);
  assert.doesNotMatch(drift.stderr, /unavailable/);
});

test('verifier gives canonical unavailability its own exit and annotation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reporting-verifier-'));
  const result = runVerifier([
    'fetch', '--artifact', 'contract', '--canonical-output', path.join(directory, 'out'),
    '--canonical-url', 'http://127.0.0.1:9/unavailable', '--attempts', '1',
    '--timeout-seconds', '0.1',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Canonical reporting identity contract unavailable/);
  assert.doesNotMatch(result.stderr, /drift/);
});
