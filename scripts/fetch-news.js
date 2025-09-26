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
const globalSortMode = (config.settings && config.settings.sortMode) || 'recent'; // 'recent' or 'created'

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

// Function to fetch latest Threat Actor campaigns from VirusTotal TI (Enterprise)
async function fetchVirusTotalThreatActorCampaigns(source) {
  const apiKey = process.env.VIRUSTOTAL_API_KEY || process.env.VT_API_KEY;
  if (!apiKey) {
    console.warn('VIRUSTOTAL_API_KEY not set; skipping VirusTotal source');
    return [];
  }

  const baseUrl = 'https://www.virustotal.com/api/v3';
  const http = axios.create({
    baseURL: baseUrl,
    headers: { 'x-apikey': apiKey }
  });

  // Defaults can be overridden per-source via source.options
  const opts = Object.assign({
    actorsLimit: 5,
    campaignsPerActor: 3,
    // Fetch more from API then filter down by window and per-actor cap
    campaignFetchLimit: 20,
    // Order parameter removed to avoid 400s; VT may not support ordering here
    // Only include campaigns created within this many days
    daysWindow: 3,
    actorIds: null // if provided, only fetch for these IDs
  }, source.options || {});

  try {
    let actors = [];

    if (Array.isArray(opts.actorIds) && opts.actorIds.length > 0) {
      // Build synthetic actor entries when actor IDs are provided
      actors = opts.actorIds.map(id => ({ id, attributes: {} }));
    } else {
      // List latest actors (try canonical '/actors', then fallbacks)
      try {
        const resp = await http.get('/actors', { params: { limit: opts.actorsLimit } });
        actors = (resp.data && resp.data.data) || [];
      } catch (e0) {
        try {
          const resp = await http.get('/threat_actors', { params: { limit: opts.actorsLimit } });
          actors = (resp.data && resp.data.data) || [];
        } catch (e1) {
          try {
            const resp2 = await http.get('/threat-actors', { params: { limit: opts.actorsLimit } });
            actors = (resp2.data && resp2.data.data) || [];
          } catch (e2) {
            const s0 = e0.response && e0.response.status;
            const s1 = e1.response && e1.response.status;
            const s2 = e2.response && e2.response.status;
            console.warn(`VirusTotal: failed listing actors (statuses ${s0}, ${s1}, ${s2})`);
            actors = [];
          }
        }
      }
    }

    // For each actor, fetch recent campaigns
    const items = [];
    const createdAfterEpoch = Math.floor(Date.now() / 1000) - (Number(opts.daysWindow) * 24 * 60 * 60);

    for (const actor of actors) {
      const actorId = actor.id;
      let actorName = (actor.attributes && (actor.attributes.alias || actor.attributes.name)) || actorId;

      // Fetch campaigns related to the actor
      let campaigns = [];
      try {
        // Prefer relationships endpoint which many VT v3 resources use
        let campResp;
        try {
          campResp = await http.get(`/actors/${encodeURIComponent(actorId)}/relationships/campaigns`, {
            params: { limit: opts.campaignFetchLimit }
          });
        } catch (eRel0) {
          try {
            campResp = await http.get(`/actors/${encodeURIComponent(actorId)}/campaigns`, {
              params: { limit: opts.campaignFetchLimit }
            });
          } catch (eRelA) {
            try {
              campResp = await http.get(`/threat_actors/${encodeURIComponent(actorId)}/relationships/campaigns`, {
                params: { limit: opts.campaignFetchLimit }
              });
            } catch (eRel1) {
              try {
                campResp = await http.get(`/threat-actors/${encodeURIComponent(actorId)}/relationships/campaigns`, {
                  params: { limit: opts.campaignFetchLimit }
                });
              } catch (eRel2) {
                // Fallback to direct campaigns if relationships path isn't available
                campResp = await http.get(`/threat_actors/${encodeURIComponent(actorId)}/campaigns`, {
                  params: { limit: opts.campaignFetchLimit }
                });
              }
            }
          }
        }
        campaigns = (campResp.data && campResp.data.data) || [];
      } catch (err) {
        // If the campaigns relationship is not available or returns 404/403, skip gracefully
        const status = err.response && err.response.status;
        console.warn(`VirusTotal: campaigns fetch failed for actor ${actorId}${status ? ` (status ${status})` : ''}`);
        continue;
      }

      // Filter to campaigns created within the time window
      // Relationship items may not include full attributes; hydrate if needed
      async function hydrateCampaign(c) {
        if (c && c.attributes && typeof c.attributes.creation_date === 'number') return c;
        const id = c && c.id;
        if (!id) return c;
        try {
          const resp = await http.get(`/campaigns/${encodeURIComponent(id)}`);
          return (resp.data && resp.data.data) || c;
        } catch {
          return c;
        }
      }

      // Hydrate concurrently but cap per-actor concurrency by slice
      const hydrated = [];
      for (const c of campaigns.slice(0, opts.campaignFetchLimit)) {
        // eslint-disable-next-line no-await-in-loop
        hydrated.push(await hydrateCampaign(c));
      }

      const recent = hydrated.filter(c => (c.attributes && typeof c.attributes.creation_date === 'number' && c.attributes.creation_date >= createdAfterEpoch));

      // Cap items per actor after filtering
      for (const camp of recent.slice(0, opts.campaignsPerActor)) {
        const attrs = camp.attributes || {};
        const campaignId = camp.id;
        const campaignName = attrs.name || campaignId;
        const createdUnix = typeof attrs.creation_date === 'number' ? attrs.creation_date : null;
        const date = createdUnix ? new Date(createdUnix * 1000) : new Date();
        const description = attrs.description || attrs.summary || '';

        // Build a stable GUI link; fall back to the threat actor page with campaigns tab
        const link = `https://www.virustotal.com/gui/threat-actor/${encodeURIComponent(actorName)}`;

        items.push({
          title: `${actorName} campaign: ${campaignName}`,
          link,
          date,
          source: source.name || 'VirusTotal TI',
          summary: [
            `Actor: ${actorName}`,
            `Campaign: ${campaignName}`,
            createdUnix ? `Created: ${moment(new Date(createdUnix * 1000)).format('YYYY-MM-DD')}` : null,
            description ? description : null
          ].filter(Boolean).join(' • ')
        });
      }
    }

    return items;
  } catch (error) {
    const status = error.response && error.response.status;
    console.error(`VirusTotal fetch error${status ? ` (status ${status})` : ''}:`, error.message);
    return [];
  }
}

// Function to fetch latest campaigns directly from VirusTotal
async function fetchVirusTotalCampaigns(source) {
  const apiKey = process.env.VIRUSTOTAL_API_KEY || process.env.VT_API_KEY;
  if (!apiKey) {
    console.warn('VIRUSTOTAL_API_KEY not set; skipping VirusTotal source');
    return [];
  }

  const baseUrl = 'https://www.virustotal.com/api/v3';
  const http = axios.create({ baseURL: baseUrl, headers: { 'x-apikey': apiKey } });

  const opts = Object.assign({
    campaignsFetchLimit: 30,
    // Optional explicit endpoint override, e.g. "/intelligence/campaigns"
    campaignsEndpoint: null,
    // Pagination safety controls
    maxPages: 3
  }, source.options || {});
  
  // Treat VT like a normal feed: no days window or curation

  try {
    const pickDate = (attrs) => (typeof (attrs && attrs.creation_date) === 'number') ? attrs.creation_date : null;
    const collected = [];
    let pages = 0; let next = null;
    const endpoint = opts.campaignsEndpoint || '/collections';
    const baseParams = opts.campaignsEndpoint
      ? { limit: Math.max(opts.campaignsFetchLimit, 50) }
      : { limit: Math.max(opts.campaignsFetchLimit, 50), filter: 'collection_type:campaign' };
    do {
      const params = Object.assign({}, baseParams, { order: '-creation_date' }, next ? { cursor: next } : {});
      const resp = await http.get(endpoint, { params });
      const data = (resp.data && resp.data.data) || [];
      const meta = (resp.data && resp.data.meta) || {};
      for (const c of data) { if (pickDate(c.attributes) != null) collected.push(c); }
      next = meta.next || null; pages += 1;
    } while (next && pages < Number(opts.maxPages));
    const sorted = collected.sort((a, b) => (pickDate(b.attributes) || 0) - (pickDate(a.attributes) || 0));
    const take = sorted.slice(0, opts.campaignsFetchLimit);
    return take.map(c => {
      const attrs = c.attributes || {};
      const id = c.id;
      const name = attrs.name || id;
      const ts = pickDate(attrs);
      return {
        title: `Campaign: ${name}`,
        link: `https://www.virustotal.com/gui/collection/${encodeURIComponent(id)}`,
        date: ts ? new Date(ts * 1000) : new Date(),
        source: source.name || 'VirusTotal TI',
        summary: [ ts ? `Created: ${moment(new Date(ts * 1000)).format('YYYY-MM-DD')}` : null, attrs.description || attrs.summary || '' ].filter(Boolean).join(' • ')
      };
    });
  } catch (error) {
    console.error('VirusTotal campaigns fetch error:', error.message);
    return [];
  }
}

// Function to fetch news from all sources
async function fetchAllNews() {
  const allNewsPromises = sources.map(source => {
    if (source.type === 'rss') {
      return fetchRSSFeed(source);
    } else if (source.type === 'virustotal' && (source.mode === 'threat_actor_campaigns' || source.mode === 'threat-actor-campaigns')) {
      return fetchVirusTotalThreatActorCampaigns(source);
    } else if (source.type === 'virustotal' && (source.mode === 'campaigns')) {
      return fetchVirusTotalCampaigns(source);
    }
    // Add other types of fetching if needed (e.g., web scraping for non-RSS sources)
    return Promise.resolve([]);
  });

  const allNewsArrays = await Promise.all(allNewsPromises);
  
  // Flatten the array of arrays into a single array
  let allNews = allNewsArrays.flat();
  
  // Sort by date, newest first
  allNews.sort((a, b) => b.date - a.date);

  // Treat VT like RSS: no pinning
  
  // Enforce per-source minimum inclusion if configured
  const maxItems = config.settings.maxNewsItems || 30;
  const sourceMin = (config.settings && config.settings.sourceMinItems) || {};
  const picked = [];
  const used = new Set();
  const bySource = allNews.reduce((acc, item) => {
    const key = item.source || 'unknown';
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {});
  // For each source with a minimum, take that many newest items first
  for (const [src, min] of Object.entries(sourceMin)) {
    const arr = (bySource[src] || []).slice(0, Math.max(0, Number(min)));
    for (const it of arr) {
      const key = `${it.source}|${it.link}`;
      if (!used.has(key) && picked.length < maxItems) {
        picked.push(it); used.add(key);
      }
    }
  }
  // Fill the rest with remaining newest items
  for (const it of allNews) {
    const key = `${it.source}|${it.link}`;
    if (picked.length >= maxItems) break;
    if (!used.has(key)) { picked.push(it); used.add(key); }
  }
  allNews = picked;
  
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
        if (stats) stats.textContent = 'Showing ' + visible + ' of ' + total + ' articles from ' + srcCount + ' sources • Last updated ' + (new Date('${nowIso}').toLocaleString());
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
