const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectNewsDataFailures,
} = require('../scripts/news-data-contract');

test('collectNewsDataFailures reports shared collection and item contract failures', () => {
  const failures = collectNewsDataFailures(
    [
      {
        title: 'Older duplicate',
        link: 'https://example.com/duplicate',
        date: '2026-06-17T17:00:00.000Z',
        source: 'Disabled Source',
      },
      {
        title: 'Newer duplicate',
        link: 'https://example.com/duplicate',
        date: '2026-06-17T18:00:00.000Z',
        source: 'Disabled Source',
      },
    ],
    [{ name: 'Enabled Source' }],
    1
  );

  assert.match(failures.join('\n'), /exceeds maxNewsItems 1/);
  assert.match(failures.join('\n'), /duplicates link https:\/\/example\.com\/duplicate/);
  assert.match(failures.join('\n'), /must be newest-first/);
  assert.match(failures.join('\n'), /must match an enabled RSS source/);
});
