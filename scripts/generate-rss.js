const fs = require('fs');
const path = require('path');
const RSS = require('rss');
const moment = require('moment');
const {
  FEED_INFO_CONTRACT,
  RSS_CHANNEL_CONTRACT,
} = require('./generated-artifact-contracts');
const {
  assertSourceConfigContract,
  isValidHttpUrl,
  normalizeSourceName,
} = require('./source-config-contract');

// Default generated artifact paths
const defaultNewsDataPath = path.join(__dirname, '../news-data.json');
const defaultConfigPath = path.join(__dirname, '../config/news-sources.json');
const defaultRssOutputPath = path.join(__dirname, '../feed.xml');
const defaultFeedInfoPath = path.join(__dirname, '../feed-info.json');

function formatFeedItemDate(date) {
  return moment.utc(date).format('YYYY-MM-DD');
}

function getGenerationDate(now) {
  return now instanceof Date ? new Date(now.getTime()) : new Date(now);
}

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function collectRssNewsDataCollectionFailures(newsData, maxNewsItems) {
  const failures = [];

  if (newsData.length > maxNewsItems) {
    failures.push(`news-data.json has ${newsData.length} items, which exceeds maxNewsItems ${maxNewsItems}`);
  }

  const links = new Set();
  newsData.forEach((item, index) => {
    const label = `news-data.json item ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }

    if (item.link && isValidHttpUrl(item.link)) {
      if (links.has(item.link)) {
        failures.push(`${label} duplicates link ${item.link}`);
      } else {
        links.add(item.link);
      }
    }

    const previousItem = newsData[index - 1];
    if (
      index > 0
      && previousItem
      && isValidDate(previousItem.date)
      && isValidDate(item.date)
    ) {
      const previous = new Date(previousItem.date).getTime();
      const current = new Date(item.date).getTime();
      if (current > previous) {
        failures.push(`${label} is newer than the previous item; news-data.json must be newest-first`);
      }
    }
  });

  return failures;
}

function collectRssNewsDataItemFailures(item, index, enabledSourceNames) {
  const failures = [];
  const label = `news-data.json item ${index + 1}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    failures.push(`${label} must be an object`);
    return failures;
  }

  if (!item.title || typeof item.title !== 'string') {
    failures.push(`${label} must have a string title`);
  }
  if (!item.link || !isValidHttpUrl(item.link)) {
    failures.push(`${label} must have an http(s) link`);
  }
  if (!item.date || !isValidDate(item.date)) {
    failures.push(`${label} must have a valid date`);
  }
  const normalizedSourceName = normalizeSourceName(item.source);
  if (!item.source || typeof item.source !== 'string') {
    failures.push(`${label} must have a string source`);
  } else if (!normalizedSourceName) {
    failures.push(`${label} must have a non-empty string source`);
  } else if (!enabledSourceNames.has(item.source)) {
    failures.push(`${label} source "${item.source}" must match an enabled RSS source`);
  }
  if (item.summary !== undefined && typeof item.summary !== 'string') {
    failures.push(`${label} summary must be a string when present`);
  }

  return failures;
}

function assertRssNewsDataContract(newsData, enabledRssSources = [], maxNewsItems = Number.POSITIVE_INFINITY) {
  const failures = [];
  const enabledSourceNames = new Set(
    enabledRssSources.map(source => source.name)
  );

  if (!Array.isArray(newsData)) {
    failures.push('news-data.json must be an array');
  } else {
    failures.push(...collectRssNewsDataCollectionFailures(newsData, maxNewsItems));
    failures.push(
      ...newsData.flatMap((item, index) => collectRssNewsDataItemFailures(item, index, enabledSourceNames))
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

// Create RSS feed
function generateRSSFeed(options = {}) {
  const {
    newsDataPath = defaultNewsDataPath,
    configPath = defaultConfigPath,
    rssOutputPath = defaultRssOutputPath,
    feedInfoPath = defaultFeedInfoPath,
    now = new Date(),
    logger = console,
  } = options;

  // Read the news data from the JSON file
  if (!fs.existsSync(newsDataPath)) {
    throw new Error('News data file not found. Run fetch-news.js first.');
  }

  const generatedAt = getGenerationDate(now);
  const newsData = JSON.parse(fs.readFileSync(newsDataPath, 'utf8'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { enabledRssSources, maxNewsItems } = assertSourceConfigContract(config);
  assertRssNewsDataContract(newsData, enabledRssSources, maxNewsItems);

  // Create a new RSS feed
  const feed = new RSS({
    title: RSS_CHANNEL_CONTRACT.title,
    description: RSS_CHANNEL_CONTRACT.description,
    feed_url: RSS_CHANNEL_CONTRACT.publicFeedUrl,
    site_url: RSS_CHANNEL_CONTRACT.publicSiteUrl,
    image_url: RSS_CHANNEL_CONTRACT.imageUrl,
    language: 'en',
    pubDate: generatedAt,
    ttl: '180', // Time to live in minutes (3 hours)
    custom_namespaces: {
      'dc': 'http://purl.org/dc/elements/1.1/'
    }
  });

  // Add information about the sources
  const activeSources = enabledRssSources.map(source => source.name);

  feed.custom_elements.push(
    {'comment': `News aggregated from: ${activeSources.join(', ')}`}
  );

  // Add items to the feed
  newsData.forEach(item => {
    feed.item({
      title: item.title,
      description: item.summary || 'No summary available',
      url: item.link,
      guid: item.link,
      categories: [item.source],
      author: item.source,
      date: item.date,
      custom_elements: [
        {'dc:source': item.source},
        {'dc:date': formatFeedItemDate(item.date)}
      ]
    });
  });

  // Generate the XML and write to file
  const xml = feed.xml({ indent: true });
  fs.writeFileSync(rssOutputPath, xml);
  logger.log(`Generated RSS feed at ${rssOutputPath}`);

  // Create a JSON file with RSS feed information (for reference)
  const feedInfo = {
    title: FEED_INFO_CONTRACT.title,
    url: FEED_INFO_CONTRACT.publicFeedUrl,
    itemCount: newsData.length,
    sources: activeSources,
    lastUpdated: generatedAt.toISOString()
  };

  fs.writeFileSync(
    feedInfoPath,
    JSON.stringify(feedInfo, null, 2)
  );
  logger.log('Generated feed-info.json');

  return {
    feedInfo,
    feedInfoPath,
    itemCount: newsData.length,
    rssOutputPath,
  };
}

if (require.main === module) {
  try {
    generateRSSFeed();
  } catch (error) {
    console.error('Error generating RSS feed:', error.message);
    process.exit(1);
  }
}

module.exports = {
  assertRssNewsDataContract,
  formatFeedItemDate,
  generateRSSFeed,
  getGenerationDate,
};
