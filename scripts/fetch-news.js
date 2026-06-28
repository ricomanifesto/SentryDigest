const fs = require('fs');
const path = require('path');
const { generateHTML } = require('./render-news-html');
const { assertRssNewsDataContract } = require('./generate-rss');
const { assertSourceConfigContract } = require('./source-config-contract');

// Path to the index.html file
const indexHtmlPath = path.join(__dirname, '../index.html');
const newsDataPath = path.join(__dirname, '../news-data.json');

// Load configuration from file
const configPath = path.join(__dirname, '../config/news-sources.json');

function createDefaultSourceConfig(now = new Date()) {
  return {
    sources: [
      {
        name: 'Krebs on Security',
        url: 'https://krebsonsecurity.com/feed/',
        type: 'rss',
        enabled: true,
      },
      {
        name: 'The Hacker News',
        url: 'https://feeds.feedburner.com/TheHackersNews',
        type: 'rss',
        enabled: true,
      },
      {
        name: 'Threatpost',
        url: 'https://threatpost.com/feed/',
        type: 'rss',
        enabled: true,
      },
      {
        name: 'Bleeping Computer',
        url: 'https://www.bleepingcomputer.com/feed/',
        type: 'rss',
        enabled: true,
      },
      {
        name: 'Dark Reading',
        url: 'https://www.darkreading.com/rss.xml',
        type: 'rss',
        enabled: true,
      },
      {
        name: 'ZDNet Security',
        url: 'https://www.zdnet.com/topic/security/rss.xml',
        type: 'rss',
        enabled: true,
      },
    ],
    settings: {
      maxNewsItems: 30,
      lastUpdated: now.toISOString(),
    },
  };
}

function loadSourceConfig(options = {}) {
  const {
    configPath: sourceConfigPath = configPath,
    logger = console,
    now = new Date(),
  } = options;
  const configDir = path.dirname(sourceConfigPath);
  let loadedConfig;

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (fs.existsSync(sourceConfigPath)) {
    const configData = fs.readFileSync(sourceConfigPath, 'utf8');
    loadedConfig = JSON.parse(configData);
    const sourceCount = Array.isArray(loadedConfig.sources) ? loadedConfig.sources.length : 0;
    logger.log(`Loaded configuration with ${sourceCount} sources`);
  } else {
    logger.log('No configuration found, creating default config');
    loadedConfig = createDefaultSourceConfig(now);
    fs.writeFileSync(sourceConfigPath, JSON.stringify(loadedConfig, null, 2));
  }

  const sourceConfig = assertSourceConfigContract(loadedConfig);
  return {
    config: loadedConfig,
    configPath: sourceConfigPath,
    enabledRssSources: sourceConfig.enabledRssSources,
    maxNewsItems: sourceConfig.maxNewsItems,
  };
}

function updateConfigLastUpdated(config, now = new Date()) {
  if (!config.settings) {
    config.settings = {};
  }

  config.settings.lastUpdated = now.toISOString();
  return config;
}

// Use simple date-based sort across all sources

const INVALID_FEED_DATE_FALLBACK = new Date('1970-01-01T00:00:00.000Z');

function parseFeedDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeFeedDate(value, fallback = INVALID_FEED_DATE_FALLBACK) {
  return parseFeedDate(value) || fallback;
}

function normalizeArticleDate(article) {
  const candidates = [article.pubDate, article.isoDate, article.date];

  for (const candidate of candidates) {
    const date = parseFeedDate(candidate);
    if (date) {
      return date;
    }
  }

  return INVALID_FEED_DATE_FALLBACK;
}

// Function to fetch RSS feed content
async function fetchRSSFeed(source) {
  try {
    const Parser = require('rss-parser');
    const parser = new Parser();
    const feed = await parser.parseURL(source.url);
    return feed.items.map(article => ({
      title: article.title,
      link: article.link,
      date: normalizeArticleDate(article),
      source: source.name,
      summary: article.contentSnippet ? article.contentSnippet.substring(0, 200) + '...' : ''
    }));
  } catch (error) {
    console.error(`Error fetching from ${source.name}:`, error.message);
    return [];
  }
}

/* VT integration removed
// VT integration removed

*/
// Function to fetch news from all sources
async function fetchAllNews(options = {}) {
  const {
    sourceConfig = loadSourceConfig(options),
  } = options;
  const sources = sourceConfig.enabledRssSources;
  const allNewsPromises = sources.map(source => {
    if (source.type === 'rss') {
      return fetchRSSFeed(source);
    }
    // Add other types of fetching if needed (e.g., web scraping for non-RSS sources)
    return Promise.resolve([]);
  });

  const allNewsArrays = await Promise.all(allNewsPromises);
  
  // Flatten the array of arrays into a single array
  let allNews = allNewsArrays.flat();
  
  // Sort by date and cap to max
  allNews.sort((a, b) => b.date - a.date);
  allNews = allNews.slice(0, sourceConfig.maxNewsItems);
  
  return allNews;
}

function writeGeneratedNewsArtifacts(options) {
  const {
    newsItems,
    sourceConfig,
    indexHtmlPath: outputIndexHtmlPath = indexHtmlPath,
    newsDataPath: outputNewsDataPath = newsDataPath,
    configPath: outputConfigPath = configPath,
    logger = console,
    now = new Date(),
  } = options;
  const config = sourceConfig.config;
  const sources = sourceConfig.enabledRssSources;

  assertRssNewsDataContract(newsItems, sources, sourceConfig.maxNewsItems);

  const html = generateHTML(newsItems, {
    sourceNames: sources.map(source => source.name),
  });

  fs.writeFileSync(outputIndexHtmlPath, html);
  logger.log('Generated index.html');

  fs.writeFileSync(outputNewsDataPath, JSON.stringify(newsItems, null, 2));
  logger.log('Generated news-data.json');

  updateConfigLastUpdated(config, now);
  fs.mkdirSync(path.dirname(outputConfigPath), { recursive: true });
  fs.writeFileSync(outputConfigPath, JSON.stringify(config, null, 2));
  logger.log('Updated config file with timestamp');
}

// Main function
async function main() {
  try {
    // Create necessary directories if they don't exist
    const scriptsDir = path.join(__dirname);
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }

    const sourceConfig = loadSourceConfig();
    const sources = sourceConfig.enabledRssSources;
    
    // Fetch news
    console.log('Fetching news...');
    const newsItems = await fetchAllNews({ sourceConfig });
    console.log(`Fetched ${newsItems.length} news items from ${sources.length} active sources`);

    writeGeneratedNewsArtifacts({
      newsItems,
      sourceConfig,
    });
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  fetchAllNews,
  fetchRSSFeed,
  INVALID_FEED_DATE_FALLBACK,
  createDefaultSourceConfig,
  loadSourceConfig,
  normalizeArticleDate,
  normalizeFeedDate,
  updateConfigLastUpdated,
  writeGeneratedNewsArtifacts,
};
