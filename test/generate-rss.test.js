const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { formatFeedItemDate, generateRSSFeed } = require('../scripts/generate-rss');

test('formatFeedItemDate uses UTC day semantics for RSS dc:date', () => {
  assert.equal(formatFeedItemDate('2026-06-17T00:30:00.000Z'), '2026-06-17');
});

test('generateRSSFeed writes explicit output paths without relying on repo globals', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-rss-'));
  const newsDataPath = path.join(tmpDir, 'news-data.json');
  const configPath = path.join(tmpDir, 'news-sources.json');
  const rssOutputPath = path.join(tmpDir, 'feed.xml');
  const feedInfoPath = path.join(tmpDir, 'feed-info.json');
  const writes = new Map();
  const originalWriteFileSync = fs.writeFileSync;

  fs.writeFileSync(
    newsDataPath,
    JSON.stringify([
      {
        title: 'Critical vendor patch released',
        summary: 'Patch guidance for an exploited product.',
        link: 'https://example.com/vendor-patch',
        source: 'Vendor Advisory',
        date: '2026-06-17T00:30:00.000Z',
      },
    ])
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sources: [
        { name: 'Vendor Advisory', url: 'https://example.com/vendor-feed.xml', type: 'rss', enabled: true },
        { name: 'Disabled Feed', enabled: false },
      ],
    })
  );

  fs.writeFileSync = (filePath, content) => {
    writes.set(filePath, String(content));
    return undefined;
  };

  try {
    const result = generateRSSFeed({
      newsDataPath,
      configPath,
      rssOutputPath,
      feedInfoPath,
      now: new Date('2026-06-17T01:00:00.000Z'),
      logger: { log() {}, error() {} },
    });

    assert.equal(result.itemCount, 1);
    assert.equal(result.feedInfo.lastUpdated, '2026-06-17T01:00:00.000Z');
    assert.equal(result.feedInfoPath, feedInfoPath);
    assert.equal(result.rssOutputPath, rssOutputPath);
    assert.match(writes.get(rssOutputPath), /<dc:date>2026-06-17<\/dc:date>/);
    assert.equal(JSON.parse(writes.get(feedInfoPath)).sources.length, 1);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test('generateRSSFeed rejects enabled sources outside the canonical RSS source contract', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-rss-source-contract-'));
  const newsDataPath = path.join(tmpDir, 'news-data.json');
  const configPath = path.join(tmpDir, 'news-sources.json');

  fs.writeFileSync(newsDataPath, JSON.stringify([]));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sources: [
        {
          name: 'Missing URL Feed',
          enabled: true,
        },
      ],
    })
  );

  assert.throws(
    () => generateRSSFeed({
      newsDataPath,
      configPath,
      rssOutputPath: path.join(tmpDir, 'feed.xml'),
      feedInfoPath: path.join(tmpDir, 'feed-info.json'),
      logger: { log() {}, error() {} },
    }),
    /config source 1 must have an http\(s\) url/
  );
});

test('generateRSSFeed throws for missing news data without exiting module callers', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-rss-missing-'));
  const originalExit = process.exit;
  let exitCalled = false;

  process.exit = code => {
    exitCalled = true;
    throw new Error(`process.exit called with ${code}`);
  };

  try {
    assert.throws(
      () => generateRSSFeed({
        newsDataPath: path.join(tmpDir, 'missing-news-data.json'),
        configPath: path.join(tmpDir, 'news-sources.json'),
        rssOutputPath: path.join(tmpDir, 'feed.xml'),
        feedInfoPath: path.join(tmpDir, 'feed-info.json'),
        logger: { log() {}, error() {} },
      }),
      /News data file not found/
    );
    assert.equal(exitCalled, false);
  } finally {
    process.exit = originalExit;
  }
});
