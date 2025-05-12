const fs = require('fs');
const path = require('path');
const RSS = require('rss');
const moment = require('moment');

// Path to the news data file
const newsDataPath = path.join(__dirname, '../news-data.json');
const rssOutputPath = path.join(__dirname, '../feed.xml');

// Create RSS feed
function generateRSSFeed() {
  try {
    // Read the news data from the JSON file
    if (!fs.existsSync(newsDataPath)) {
      console.error('News data file not found. Run fetch-news.js first.');
      process.exit(1);
    }

    const newsData = JSON.parse(fs.readFileSync(newsDataPath, 'utf8'));
    const configPath = path.join(__dirname, '../config/news-sources.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Create a new RSS feed
    const feed = new RSS({
      title: 'Cybersecurity News Aggregator',
      description: 'Latest cybersecurity news from top sources',
      feed_url: 'https://ricomanifesto.github.io/SentryDigest/feed.xml',
      site_url: 'https://ricomanifesto.github.io/SentryDigest/',
      image_url: 'https://ricomanifesto.github.io/SentryDigest/icon.png',
      language: 'en',
      pubDate: new Date(),
      ttl: '180', // Time to live in minutes (3 hours)
      custom_namespaces: {
        'dc': 'http://purl.org/dc/elements/1.1/'
      }
    });

    // Add information about the sources
    const activeSources = config.sources
      .filter(source => source.enabled)
      .map(source => source.name)
      .join(', ');
    
    feed.custom_elements.push(
      {'comment': `News aggregated from: ${activeSources}`}
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
          {'dc:date': moment(item.date).format('YYYY-MM-DD')}
        ]
      });
    });

    // Generate the XML and write to file
    const xml = feed.xml({ indent: true });
    fs.writeFileSync(rssOutputPath, xml);
    console.log(`Generated RSS feed at ${rssOutputPath}`);

    // Create a JSON file with RSS feed information (for reference)
    const feedInfo = {
      title: 'Cybersecurity News Aggregator RSS Feed',
      url: 'https://ricomanifesto.github.io/SentryDigest/feed.xml',
      itemCount: newsData.length,
      sources: activeSources.split(', '),
      lastUpdated: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(__dirname, '../feed-info.json'),
      JSON.stringify(feedInfo, null, 2)
    );
    console.log('Generated feed-info.json');

  } catch (error) {
    console.error('Error generating RSS feed:', error.message);
    process.exit(1);
  }
}

generateRSSFeed();