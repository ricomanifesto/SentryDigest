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

test('validateSourceConfig uses the default item limit when settings are omitted', () => {
  const { failures, maxNewsItems } = validateSourceConfig({
    sources: [
      enabledSource(),
    ],
  });

  assert.deepEqual(failures, []);
  assert.equal(maxNewsItems, 30);
});

test('validateSourceConfig rejects malformed settings blocks', () => {
  for (const settings of [null, [], 'recent']) {
    const { failures } = validateSourceConfig({
      sources: [
        enabledSource(),
      ],
      settings,
    });

    assert.deepEqual(failures, ['settings must be an object']);
  }
});

test('validateSourceConfig rejects committed trigger-only settings', () => {
  for (const triggerField of ['testTrigger', 'manualTrigger']) {
    const { failures } = validateSourceConfig({
      sources: [enabledSource()],
      settings: {
        maxNewsItems: 30,
        [triggerField]: true,
      },
    });

    assert.deepEqual(failures, [`settings.${triggerField} is a trigger-only field and must not be committed`]);
  }
});

test('validateSourceConfig accepts null or ISO contribution history and rejects malformed values', () => {
  for (const lastContributedAt of [null, '2026-08-13T18:00:00.000Z']) {
    const { failures } = validateSourceConfig({
      sources: [enabledSource({ lastContributedAt })],
    });
    assert.deepEqual(failures, []);
  }

  const { failures } = validateSourceConfig({
    sources: [enabledSource({ lastContributedAt: 'last Tuesday' })],
  });
  assert.deepEqual(failures, ['config source 1 lastContributedAt must be null or a valid ISO timestamp']);
});

test('enabled feed sources require credential-free public destinations', () => {
  const urls = [
    'http://127.0.0.1/feed', 'http://2130706433/feed', 'http://10.1.2.3/feed',
    'http://172.16.0.1/feed', 'http://192.168.1.2/feed', 'http://169.254.1.2/feed',
    'http://100.64.0.1/feed', 'http://0.0.0.0/feed', 'http://224.0.0.1/feed',
    'http://[::1]/feed', 'http://[fc00::1]/feed', 'http://[fe80::1]/feed',
    'http://[::ffff:127.0.0.1]/feed', 'http://[2002:7f00:1::1]/feed',
    'http://localhost/feed', 'http://service.local/feed', 'http://service.internal/feed',
    'https://example.com:8443/feed', 'http://example.com:8080/feed',
    'https://user:password@example.com/feed',
  ];
  for (const url of urls) {
    const { failures, enabledRssSources } = validateSourceConfig({ sources: [enabledSource({ url })] });
    assert.ok(failures.some((failure) => /public|destination/i.test(failure)), url);
    assert.deepEqual(enabledRssSources, [], url);
  }
});

test('public feed URLs retain HTTPS, IPv4 and global IPv6 compatibility', () => {
  for (const url of ['https://feeds.example.com/feed.xml', 'http://8.8.8.8/feed', 'https://[2606:4700:4700::1111]/feed']) {
    const { failures, enabledRssSources } = validateSourceConfig({ sources: [enabledSource({ url })] });
    assert.deepEqual(failures, [], url);
    assert.equal(enabledRssSources.length, 1);
  }
});
