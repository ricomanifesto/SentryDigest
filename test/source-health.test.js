const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeSourceHealth,
  SOURCE_STALE_AFTER_DAYS,
} = require('../scripts/source-health');

const AS_OF = new Date('2026-08-31T12:00:00.000Z');

test('source health distinguishes active, quiet, stale, and never-observed feeds at exact boundaries', () => {
  const described = describeSourceHealth([
    {
      name: 'Active Feed',
      itemCount: 1,
      lastContributedAt: '2026-08-31T11:00:00.000Z',
    },
    {
      name: 'Quiet Feed',
      itemCount: 0,
      lastContributedAt: '2026-08-01T12:00:00.001Z',
    },
    {
      name: 'Stale Feed',
      itemCount: 0,
      lastContributedAt: '2026-08-01T12:00:00.000Z',
    },
    {
      name: 'Never Observed Feed',
      itemCount: 0,
      lastContributedAt: null,
    },
  ], AS_OF);

  assert.equal(SOURCE_STALE_AFTER_DAYS, 30);
  assert.deepEqual(described, [
    {
      name: 'Active Feed',
      itemCount: 1,
      lastContributedAt: '2026-08-31T11:00:00.000Z',
      status: 'active',
      quietForDays: 0,
    },
    {
      name: 'Quiet Feed',
      itemCount: 0,
      lastContributedAt: '2026-08-01T12:00:00.001Z',
      status: 'quiet',
      quietForDays: 29,
    },
    {
      name: 'Stale Feed',
      itemCount: 0,
      lastContributedAt: '2026-08-01T12:00:00.000Z',
      status: 'stale',
      quietForDays: 30,
    },
    {
      name: 'Never Observed Feed',
      itemCount: 0,
      lastContributedAt: null,
      status: 'unobserved',
      quietForDays: null,
    },
  ]);
});

test('source health rejects an invalid observation time instead of silently aging feeds', () => {
  assert.throws(
    () => describeSourceHealth([], 'not-a-date'),
    /source health observation time must be a valid date/,
  );
});
