const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const moment = require('moment');

// Create a new RSS parser instance
const parser = new Parser();

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

// Function to fetch RSS feed content
async function fetchRSSFeed(source) {
  try {
    const feed = await parser.parseURL(source.url);
    return feed.items.map(item => ({
      title: item.title,
      link: item.link,
      date: item.pubDate ? new Date(item.pubDate) : new Date(),
      source: source.name,
      summary: item.contentSnippet ? item.contentSnippet.substring(0, 200) + '...' : ''
    }));
  } catch (error) {
    console.error(`Error fetching from ${source.name}:`, error.message);
    return [];
  }
}

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
  
  // Sort by date, newest first
  allNews.sort((a, b) => b.date - a.date);
  
  // Limit to max news items from config
  const maxItems = config.settings.maxNewsItems || 30;
  allNews = allNews.slice(0, maxItems);
  
  return allNews;
}

// Function to generate HTML
function generateHTML(newsItems) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cybersecurity News Aggregator</title>
  <meta name="description" content="Latest cybersecurity news from top sources">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 1200px;
      margin: 0 auto;
      padding: 1rem;
      background-color: #f8f9fa;
    }
    header {
      background-color: #2c3e50;
      color: white;
      padding: 1rem;
      text-align: center;
      border-radius: 5px;
      margin-bottom: 2rem;
    }
    h1 {
      margin: 0;
    }
    .last-updated {
      font-size: 0.9rem;
      color: #eee;
      margin-top: 0.5rem;
    }
    .sources-info {
      font-size: 0.9rem;
      color: #eee;
      margin-top: 0.2rem;
    }
    .news-container {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 1.5rem;
    }
    .news-item {
      background-color: white;
      border-radius: 5px;
      padding: 1.5rem;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s;
    }
    .news-item:hover {
      transform: translateY(-5px);
    }
    .news-source {
      display: inline-block;
      background-color: #e9ecef;
      padding: 0.25rem 0.5rem;
      border-radius: 3px;
      font-size: 0.8rem;
      margin-bottom: 0.5rem;
    }
    .news-title {
      font-size: 1.1rem;
      margin: 0.5rem 0;
    }
    .news-title a {
      color: #2c3e50;
      text-decoration: none;
    }
    .news-title a:hover {
      text-decoration: underline;
    }
    .news-date {
      color: #6c757d;
      font-size: 0.8rem;
    }
    .news-summary {
      margin-top: 0.5rem;
      font-size: 0.9rem;
      color: #495057;
    }
    footer {
      margin-top: 2rem;
      text-align: center;
      color: #6c757d;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>Cybersecurity News Aggregator</h1>
    <p class="last-updated">Last updated: ${new Date().toLocaleString()}</p>
  </header>
  
  <div class="news-container">
    ${newsItems.length > 0 ? newsItems.map(item => `
      <div class="news-item">
        <span class="news-source">${item.source}</span>
        <h2 class="news-title"><a href="${item.link}" target="_blank" rel="noopener">${item.title}</a></h2>
        <div class="news-date">${moment(item.date).format('MMMM D, YYYY - h:mm A')}</div>
        ${item.summary ? `<p class="news-summary">${item.summary}</p>` : ''}
      </div>
    `).join('') : `
      <div class="news-item" style="grid-column: 1 / -1; text-align: center;">
        <h2>No news items found</h2>
        <p>No news could be fetched from the configured sources. This could be due to temporary feed issues or network problems. The site will try again on the next update cycle.</p>
      </div>
    `}
  </div>
  
  <footer>
    <p>Powered by GitHub Actions | Automatically updates every 3 hours</p>
  </footer>
</body>
</html>
  `;
  
  return html;
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
    const html = generateHTML(newsItems);
    
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

main();