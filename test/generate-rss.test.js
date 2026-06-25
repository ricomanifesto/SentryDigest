const assert = require('node:assert/strict');
const test = require('node:test');

const { formatFeedItemDate } = require('../scripts/generate-rss');

test('formatFeedItemDate uses UTC day semantics for RSS dc:date', () => {
  assert.equal(formatFeedItemDate('2026-06-17T00:30:00.000Z'), '2026-06-17');
});
