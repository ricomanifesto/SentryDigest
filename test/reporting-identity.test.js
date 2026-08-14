const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  articleFragment,
  articleSourceKey,
  normalizeArticleUrl,
} = require('../scripts/reporting-identity');

const contract = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../contracts/reporting-identity-v1.json'),
  'utf8',
));
const CONTRACT_SHA256 = '16c52db11b981aba115f4a1a127458def99b809c3e768028bebb66b880e33671';

test('reporting identity contract v1 is immutable', () => {
  const bytes = fs.readFileSync(path.join(__dirname, '../contracts/reporting-identity-v1.json'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), CONTRACT_SHA256);
});

for (const vector of contract.accepted) {
  test(`reporting identity contract accepts ${vector.name}`, () => {
    assert.equal(normalizeArticleUrl(vector.input), vector.normalized);
    assert.equal(articleSourceKey(vector.input), vector.source_key);
    assert.equal(articleFragment(vector.input), vector.reporting_fragment);
  });
}

for (const vector of contract.rejected) {
  test(`reporting identity contract rejects ${vector.name}`, () => {
    assert.throws(() => normalizeArticleUrl(vector.input));
  });
}
