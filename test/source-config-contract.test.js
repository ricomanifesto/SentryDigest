const assert = require('node:assert/strict');
const test = require('node:test');

const {
  validateSourceConfig,
} = require('../scripts/source-config-contract');

function enabledSource(overrides = {}) {
  return {
    name: 'Example Security',
    url: 'https://example.com/feed.xml',
    type: 'rss',
    enabled: true,
    ...overrides,
  };
}

test('validateSourceConfig rejects duplicate enabled source names', () => {
  const { failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: 'Example Security', url: 'https://example.com/one.xml' }),
      enabledSource({ name: 'Example Security', url: 'https://example.com/two.xml' }),
    ],
  });

  assert.deepEqual(failures, ['config source 2 duplicates enabled source name "Example Security"']);
});

test('validateSourceConfig rejects blank enabled source names', () => {
  const { failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: '   ' }),
    ],
  });

  assert.deepEqual(failures, ['config source 1 must have a non-empty string name']);
});

test('validateSourceConfig rejects normalized duplicate enabled source names', () => {
  const { failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: 'Example Security', url: 'https://example.com/one.xml' }),
      enabledSource({ name: '  example   security  ', url: 'https://example.com/two.xml' }),
    ],
  });

  assert.deepEqual(failures, ['config source 2 duplicates enabled source name "example security"']);
});

test('validateSourceConfig rejects duplicate enabled source urls', () => {
  const { failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: 'Example One', url: 'https://example.com/feed.xml' }),
      enabledSource({ name: 'Example Two', url: 'https://example.com/feed.xml' }),
    ],
  });

  assert.deepEqual(failures, ['config source 2 duplicates enabled source url "https://example.com/feed.xml"']);
});

test('validateSourceConfig rejects canonical duplicate enabled source urls', () => {
  const { failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: 'Example One', url: 'https://EXAMPLE.com:443/feed.xml' }),
      enabledSource({ name: 'Example Two', url: 'https://example.com/feed.xml' }),
    ],
  });

  assert.deepEqual(failures, ['config source 2 duplicates enabled source url "https://example.com/feed.xml"']);
});

test('validateSourceConfig rejects fragment-only duplicate enabled source urls', () => {
  const { failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: 'Example One', url: 'https://example.com/feed.xml' }),
      enabledSource({ name: 'Example Two', url: 'https://example.com/feed.xml#copy' }),
    ],
  });

  assert.deepEqual(failures, ['config source 2 duplicates enabled source url "https://example.com/feed.xml"']);
});

test('validateSourceConfig allows disabled duplicate source names and urls', () => {
  const { enabledRssSources, failures } = validateSourceConfig({
    sources: [
      enabledSource({ name: 'Example Security', url: 'https://example.com/feed.xml' }),
      {
        name: 'Example Security',
        url: 'https://example.com/feed.xml',
        type: 'rss',
        enabled: false,
      },
    ],
  });

  assert.deepEqual(failures, []);
  assert.equal(enabledRssSources.length, 1);
});
