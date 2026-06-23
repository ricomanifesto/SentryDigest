const fs = require('fs');
const path = require('path');
const { generateHTML } = require('./render-news-html');

// Path to the index.html file
const indexHtmlPath = path.join(__dirname, '../index.html');

// Load configuration from file
const configPath = path.join(__dirname, '../config/news-sources.json');
let config;

try {
  // Ensure config directory exists
  const configDir = path.join(__dirname, '../config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // Try to load the config file
  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
    console.log(`Loaded configuration with ${config.sources.length} sources`);
  } else {
    // Create default config if none exists
    console.log('No configuration found, creating default config');
    config = {
      "sources": [
        {
          "name": "Krebs on Security",
          "url": "https://krebsonsecurity.com/feed/",
          "type": "rss",
          "enabled": true
        },
        {
          "name": "The Hacker News",
          "url": "https://feeds.feedburner.com/TheHackersNews",
          "type": "rss",
          "enabled": true
        },
        {
          "name": "Threatpost",
          "url": "https://threatpost.com/feed/",
          "type": "rss",
          "enabled": true
        },
        {
          "name": "Bleeping Computer",
          "url": "https://www.bleepingcomputer.com/feed/",
          "type": "rss",
          "enabled": true
        },
        {
          "name": "Dark Reading",
          "url": "https://www.darkreading.com/rss.xml",
          "type": "rss",
          "enabled": true
        },
        {
          "name": "ZDNet Security",
          "url": "https://www.zdnet.com/topic/security/rss.xml",
          "type": "rss",
          "enabled": true
        }
      ],
      "settings": {
        "maxNewsItems": 30,
        "lastUpdated": new Date().toISOString()
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
} catch (error) {
  console.error('Error with config file:', error.message);
  process.exit(1);
}

// Get sources from config
const sources = config.sources.filter(source => source.enabled);
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
async function fetchAllNews() {
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
  const maxItems = config.settings.maxNewsItems || 30;
  allNews = allNews.slice(0, maxItems);
  
  return allNews;
}

// Main function
async function main() {
  try {
    // Create necessary directories if they don't exist
    const scriptsDir = path.join(__dirname);
    if (!fs.existsSync(scriptsDir)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
    }
    
    // Fetch news
    console.log('Fetching news...');
    const newsItems = await fetchAllNews();
    console.log(`Fetched ${newsItems.length} news items from ${sources.length} active sources`);
    
    // Generate HTML
    const html = generateHTML(newsItems, {
      sourceNames: sources.map(source => source.name),
    });
    
    // Write HTML to index.html
    fs.writeFileSync(indexHtmlPath, html);
    console.log('Generated index.html');
    
    // Create a JSON file with the data for potential API use or debugging
    fs.writeFileSync(path.join(__dirname, '../news-data.json'), JSON.stringify(newsItems, null, 2));
    console.log('Generated news-data.json');
    
    // Update config file with last updated timestamp
    config.settings.lastUpdated = new Date().toISOString();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Updated config file with timestamp');
    
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
  normalizeArticleDate,
  normalizeFeedDate,
};
