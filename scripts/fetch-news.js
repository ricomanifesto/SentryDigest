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
  const uniqueSources = Array.from(new Set(newsItems.map(n => n.source)));
  const totalItems = newsItems.length;
  const sourceOptions = uniqueSources
    .map(src => `<option value="${src}">${src}</option>`) 
    .join('');
  const nowIso = new Date().toISOString();

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SentryDigest | Cybersecurity News</title>
  <meta name="description" content="Latest cybersecurity news from top sources">
  <link rel="alternate" type="application/rss+xml" title="Cybersecurity News RSS Feed" href="./feed.xml" />
  <link rel="icon" type="image/png" href="./assets/logo.png">
  <link rel="apple-touch-icon" href="./assets/logo.png">
  <style>
    :root { 
      --bg: #f7f8fa; 
      --fg: #1f2937; 
      --muted: #6b7280; 
      --card: #ffffff; 
      --card-border: #e5e7eb; 
      --accent: #2563eb; 
      --accent-contrast: #ffffff; 
      --chip: #e5e7eb;
    }
    [data-theme="dark"] {
      --bg: #0b1020;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --card: #141b2f;
      --card-border: #26304a;
      --accent: #60a5fa;
      --accent-contrast: #0b1020;
      --chip: #1f2937;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: var(--fg); margin: 0; background: radial-gradient(1200px 600px at 20% -10%, rgba(37,99,235,.08), transparent 50%), var(--bg); }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    header.site-header { background: linear-gradient(180deg, rgba(37,99,235,0.15), rgba(37,99,235,0.0)); border-bottom: 1px solid var(--card-border); position: sticky; top: 0; z-index: 10; backdrop-filter: saturate(140%) blur(8px); }
    .masthead { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand img { width: 28px; height: 28px; border-radius: 6px; }
    .brand .title { font-weight: 700; letter-spacing: 0.2px; }
    .brand .subtitle { color: var(--muted); font-size: 0.9rem; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .search { display: flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--card-border); padding: 8px 10px; border-radius: 10px; }
    .search input { border: none; outline: none; background: transparent; color: var(--fg); min-width: 220px; }
    .select { border: 1px solid var(--card-border); background: var(--card); color: var(--fg); padding: 8px 10px; border-radius: 10px; }
    .btn { border: 1px solid var(--card-border); background: var(--card); color: var(--fg); padding: 8px 10px; border-radius: 10px; cursor: pointer; }
    .btn:hover { border-color: var(--accent); }
    .stats { color: var(--muted); font-size: 0.9rem; margin-top: 6px; }
    .news-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 18px; }
    .news-item { background: var(--card); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px; transition: transform .2s ease, box-shadow .2s ease; }
    .news-item:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(2,8,23,0.08); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); color: var(--fg); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .news-title { font-size: 1.06rem; margin: 6px 0 8px; }
    .news-title a { color: var(--fg); text-decoration: none; }
    .news-title a:hover { text-decoration: underline; }
    .news-meta { color: var(--muted); font-size: 0.85rem; display: flex; gap: 8px; align-items: baseline; }
    .badge-new { color: #16a34a; font-weight: 600; font-size: 0.8rem; }
    .news-summary { margin-top: 8px; color: var(--fg); opacity: 0.9; }
    footer { border-top: 1px solid var(--card-border); color: var(--muted); font-size: 0.9rem; padding: 18px 0; margin-top: 22px; }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="container masthead">
      <div class="brand">
        <img src="./assets/logo.png" alt="SentryDigest" />
        <div>
          <div class="title">SentryDigest</div>
          <div class="subtitle">Cybersecurity News Aggregator</div>
        </div>
      </div>
      <div class="controls">
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="7.5" stroke="currentColor" stroke-width="2"/></svg>
          <input id="search" type="text" placeholder="Search title or summary..." aria-label="Search" />
        </div>
        <select id="sourceFilter" class="select" aria-label="Filter by source">
          <option value="">All sources</option>
          ${sourceOptions}
        </select>
        <a class="btn" href="./feed.xml">RSS</a>
        <button id="themeToggle" class="btn" aria-label="Toggle theme">Theme</button>
      </div>
    </div>
  </header>

  <main class="container">
    <div class="stats" id="stats">Showing ${totalItems} of ${totalItems} articles from ${uniqueSources.length} sources • Last updated <time datetime="${nowIso}">${new Date().toLocaleString()}</time></div>

    <div class="news-container" id="newsContainer">
      ${newsItems.length > 0 ? newsItems.map(item => {
        const hostname = (() => { try { return new URL(item.link).hostname.replace(/^www\./,''); } catch { return ''; } })();
        const isNew = (Date.now() - new Date(item.date).getTime()) < (24 * 60 * 60 * 1000);
        const dateText = moment(item.date).format('MMMM D, YYYY - h:mm A');
        const dateIso = new Date(item.date).toISOString();
        const sourceAttr = item.source;
        return `
        <article class="news-item" data-source="${sourceAttr}" data-host="${hostname}" data-title="${(item.title||'').replace(/"/g,'&quot;')}" data-summary="${(item.summary||'').replace(/"/g,'&quot;')}">
          <div class="chips">
            <span class="chip"><span class="dot"></span>${item.source}</span>
            ${hostname ? `<span class="chip">${hostname}</span>` : ''}
          </div>
          <h2 class="news-title"><a href="${item.link}" target="_blank" rel="noopener">${item.title}</a></h2>
          <div class="news-meta">
            <time datetime="${dateIso}">${dateText}</time>
            ${isNew ? `<span class="badge-new">NEW</span>` : ''}
          </div>
          ${item.summary ? `<p class="news-summary">${item.summary}</p>` : ''}
        </article>`;
      }).join('') : `
        <div class="news-item" style="grid-column: 1 / -1; text-align: center;">
          <h2>No news items found</h2>
          <p>No news could be fetched from the configured sources. This could be due to temporary feed issues or network problems. The site will try again on the next update cycle.</p>
        </div>
      `}
    </div>
  </main>
  
  <footer>
    <div class="container">
      Powered by GitHub Actions • Updates every 3 hours • <a href="./feed.xml">RSS Feed</a>
    </div>
  </footer>

  <script>
    (function(){
      const root = document.documentElement;
      const themeKey = 'sentrydigest:theme';
      const saved = localStorage.getItem(themeKey);
      if (saved === 'dark' || (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        root.setAttribute('data-theme','dark');
      }
      const btn = document.getElementById('themeToggle');
      btn && btn.addEventListener('click', function(){
        const dark = root.getAttribute('data-theme') === 'dark';
        root.setAttribute('data-theme', dark ? 'light' : 'dark');
        localStorage.setItem(themeKey, dark ? 'light' : 'dark');
      });

      const q = (sel) => document.querySelector(sel);
      const qa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
      const search = q('#search');
      const filter = q('#sourceFilter');
      const stats = q('#stats');
      const cards = qa('.news-item');

      function update(){
        const term = (search && search.value || '').toLowerCase().trim();
        const src = filter && filter.value || '';
        let visible = 0;
        cards.forEach(card => {
          const matchesText = !term || (card.getAttribute('data-title').toLowerCase().includes(term) || card.getAttribute('data-summary').toLowerCase().includes(term));
          const matchesSource = !src || card.getAttribute('data-source') === src;
          const show = matchesText && matchesSource;
          card.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        const total = ${totalItems};
        const srcCount = ${uniqueSources.length};
        if (stats) stats.textContent = `Showing ${'${'}visible${'}'} of ${'${'}total${'}'} articles from ${'${'}srcCount${'}'} sources • Last updated ` + (new Date('${nowIso}').toLocaleString());
      }
      if (search) search.addEventListener('input', debounce(update, 120));
      if (filter) filter.addEventListener('change', update);
      update();

      function debounce(fn, wait){ let t; return function(){ clearTimeout(t); t=setTimeout(fn, wait); } }
    })();
  </script>
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
