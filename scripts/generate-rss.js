const fs = require('fs');
const path = require('path');
const RSS = require('rss');
const moment = require('moment');
const {
  FEED_INFO_CONTRACT,
  RSS_CHANNEL_CONTRACT,
} = require('./generated-artifact-contracts');

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
  const activeSources = config.sources
    .filter(source => source.enabled)
    .map(source => source.name);

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
  formatFeedItemDate,
  generateRSSFeed,
  getGenerationDate,
};
