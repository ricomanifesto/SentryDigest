const fs = require('fs');
const path = require('path');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { isVirtualEventPromotion, normalizeFeedText } = require('./feed-content-policy');
const { generateHTML } = require('./render-news-html');
const { assertNewsDataContract } = require('./news-data-contract');
const { assertPublicFeedUrl, assertSourceConfigContract, isPublicIpAddress } = require('./source-config-contract');
const {
  getCurrentInsightCves,
  loadCurrentInsightFindings,
} = require('./current-insight-findings');
const { loadInsightSyncContext } = require('./insight-sync-context');
const { listDigestIssueDates } = require('./digest-archive');
const {
  newestContributionTimestamp,
  updateSourceContributionHistory,
  collectSourceHealth,
} = require('./source-health');

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
        lastContributedAt: null,
      },
      {
        name: 'The Hacker News',
        url: 'https://feeds.feedburner.com/TheHackersNews',
        type: 'rss',
        enabled: true,
        lastContributedAt: null,
      },
      {
        name: 'Bleeping Computer',
        url: 'https://www.bleepingcomputer.com/feed/',
        type: 'rss',
        enabled: true,
        lastContributedAt: null,
      },
      {
        name: 'Dark Reading',
        url: 'https://www.darkreading.com/rss.xml',
        type: 'rss',
        enabled: true,
        lastContributedAt: null,
      },
      {
        name: 'ZDNet Security',
        url: 'https://www.zdnet.com/topic/security/rss.xml',
        type: 'rss',
        enabled: true,
        lastContributedAt: null,
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

function normalizeSummary(value) {
  const normalized = normalizeFeedText(value);
  const truncationMarker = /\[(?:\.{3}|…)]/g;
  const hadTruncationMarker = truncationMarker.test(normalized);
  truncationMarker.lastIndex = 0;

  let summary = normalized.replace(truncationMarker, ' ').replace(/\s+/g, ' ').trim();
  if (hadTruncationMarker) {
    summary = summary
      .replace(/\s*(?:\.{3}|…)+\s*$/g, '')
      .replace(/[.,;:!?]+\s*$/g, '')
      .trim();
    return summary ? `${summary}…` : '';
  }

  if (
    summary.length > 160
    && !/[.!?…](?:["'’”)\]}]*)$/.test(summary)
  ) {
    return `${summary.replace(/[.,;:!?]+$/g, '').trim()}…`;
  }

  return summary;
}

function assignFirstSeen(newsItems, previousNewsItems = [], generatedAt = new Date()) {
  const generatedAtIso = new Date(generatedAt).toISOString();
  const previousByLink = new Map(
    previousNewsItems
      .filter((item) => item && typeof item === 'object' && typeof item.link === 'string')
      .map((item) => [item.link, item])
  );

  return newsItems.map((article) => {
    const previous = previousByLink.get(article.link);
    const candidates = [article.firstSeen, previous?.firstSeen, previous?.date];
    const firstSeen = candidates.find((value) => value && !Number.isNaN(new Date(value).getTime()));

    return {
      ...article,
      firstSeen: firstSeen ? new Date(firstSeen).toISOString() : generatedAtIso,
    };
  });
}

const FEED_FETCH_LIMITS = Object.freeze({ timeoutMs: 15000, maxRedirects: 5, maxBytes: 5 * 1024 * 1024 });

// Validate the answers used by the connection itself, rather than resolving
// once for a preflight and letting the HTTP client resolve a second time.
function publicFeedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
      callback(new Error('Feed destination did not resolve exclusively to public addresses'));
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function fetchFeedXml(value, options = {}) {
  const { timeoutMs, maxRedirects, maxBytes } = { ...FEED_FETCH_LIMITS, ...options };
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(maxBytes) || maxBytes <= 0
      || !Number.isInteger(maxRedirects) || maxRedirects < 0) {
    return Promise.reject(new Error('Invalid feed fetch limits'));
  }
  return new Promise((resolve, reject) => {
    let activeRequest;
    let activeResponse;
    let settled = false;
    const finish = (error, xml) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        activeResponse?.destroy();
        activeRequest?.destroy();
        reject(error);
      } else resolve(xml);
    };
    // One wall-clock budget covers DNS, headers, redirects and response body.
    const deadline = setTimeout(() => finish(new Error(`Feed fetch timed out after ${timeoutMs}ms`)), timeoutMs);
    const visit = (next, redirects) => {
      let url;
      try {
        url = assertPublicFeedUrl(next);
      } catch (error) {
        finish(error);
        return;
      }
      const transport = url.protocol === 'https:' ? https : http;
      let disposed = false;
      const failCurrentHop = (error) => { if (!disposed) finish(error); };
      try {
        activeRequest = transport.request(url, {
          agent: false,
          lookup: publicFeedLookup,
          headers: { 'User-Agent': 'rss-parser', Accept: 'application/rss+xml', 'Accept-Encoding': 'identity' },
        }, (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          activeResponse = response;
          response.on('error', failCurrentHop);
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            disposed = true;
            response.destroy();
            if (redirects >= maxRedirects) {
              finish(new Error('Feed exceeded redirect limit'));
              return;
            }
            try {
              visit(new URL(response.headers.location, url).toString(), redirects + 1);
            } catch (error) {
              finish(error);
            }
            return;
          }
          response.on('aborted', () => finish(new Error('Feed response was aborted')));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish(new Error(`Feed returned status ${response.statusCode}`));
            return;
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            finish(new Error('Feed returned unsupported content encoding'));
            return;
          }
          if (Number(response.headers['content-length']) > maxBytes) {
            finish(new Error(`Feed body exceeds ${maxBytes} bytes`));
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBytes) finish(new Error(`Feed body exceeds ${maxBytes} bytes`));
            else chunks.push(buffer);
          });
          response.on('end', () => {
            try {
              const charset = response.headers['content-type']?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] || 'utf-8';
              finish(null, new TextDecoder(charset).decode(Buffer.concat(chunks)));
            } catch (error) {
              finish(error);
            }
          });
        });
        activeRequest.on('error', failCurrentHop);
        activeRequest.on('socket', (socket) => {
          // Literal IPs bypass lookup. Check the actual peer as well, before
          // Node flushes the request on connect; agent:false prevents reuse.
          socket.prependOnceListener('connect', () => {
            if (!isPublicIpAddress(socket.remoteAddress)) {
              finish(new Error('Feed connected to a nonpublic destination'));
            }
          });
        });
        activeRequest.end();
      } catch (error) {
        finish(error);
      }
    };
    visit(value, 0);
  });
}

// Parse only XML returned by the bounded, public-destination transport.
async function fetchRSSFeed(source) {
  const Parser = require('rss-parser');
  const parser = new Parser();
  const feed = await parser.parseString(await fetchFeedXml(source.url));
  return feed.items.map(article => ({
    title: normalizeFeedText(article.title),
    link: article.link,
    date: normalizeArticleDate(article),
    source: source.name,
    summary: normalizeSummary(article.contentSnippet || article.content || article.description || '')
  }));
}

async function fetchNewsSnapshot(options = {}) {
  const {
    sourceConfig = loadSourceConfig(options),
    fetchFeed = fetchRSSFeed,
    logger = console,
  } = options;
  const sources = sourceConfig.enabledRssSources;
  const allNewsPromises = sources.map(source => {
    return fetchFeed(source);
  });

  const fetchResults = await Promise.allSettled(allNewsPromises);
  const allNewsArrays = [];
  const sourceContributions = [];

  fetchResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const eligibleArticles = result.value.filter((article) => !isVirtualEventPromotion(article));
      allNewsArrays.push(eligibleArticles);
      sourceContributions.push({
        name: sources[index].name,
        lastContributedAt: newestContributionTimestamp(
          eligibleArticles.map((article) => article?.date)
        ),
      });
      return;
    }

    logger.error(`Error fetching from ${sources[index].name}:`, result.reason?.message || result.reason);
  });

  if (allNewsArrays.length === 0) {
    throw new Error(`Failed to fetch all ${sources.length} enabled RSS sources`);
  }
  
  // Flatten the array of arrays into a single array
  let allNews = allNewsArrays.flat();

  if (allNews.length === 0) {
    throw new Error('No publishable news remains after feed content exclusions; retaining existing artifacts');
  }
  
  // Sort by date and cap to max
  allNews.sort((a, b) => b.date - a.date);
  allNews = allNews.slice(0, sourceConfig.maxNewsItems);
  
  return {
    newsItems: allNews,
    sourceContributions,
  };
}

// Compatibility helper for callers that only need the rolling article list.
async function fetchAllNews(options = {}) {
  const snapshot = await fetchNewsSnapshot(options);
  return snapshot.newsItems;
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
    previousNewsItems,
    sourceContributions = [],
    currentInsightCves = null,
    insightContext = null,
    retainedIssueDates = [],
  } = options;
  const config = sourceConfig.config;
  const sources = sourceConfig.enabledRssSources;
  let previousItems = previousNewsItems;

  if (!Array.isArray(previousItems)) {
    try {
      previousItems = fs.existsSync(outputNewsDataPath)
        ? JSON.parse(fs.readFileSync(outputNewsDataPath, 'utf8'))
        : [];
    } catch {
      previousItems = [];
    }
  }

  const generatedNewsItems = assignFirstSeen(newsItems, previousItems, now);

  assertNewsDataContract(generatedNewsItems, sources, sourceConfig.maxNewsItems);

  updateSourceContributionHistory(config, sourceContributions, generatedNewsItems);
  const sourceHealth = collectSourceHealth(generatedNewsItems, sources);

  const html = generateHTML(generatedNewsItems, {
    currentInsightCves,
    generatedAt: now,
    insightContext,
    retainedIssueDates,
    sourceHealth,
  });

  fs.writeFileSync(outputIndexHtmlPath, html);
  logger.log('Generated index.html');

  fs.writeFileSync(outputNewsDataPath, JSON.stringify(generatedNewsItems, null, 2));
  logger.log('Generated news-data.json');

  updateConfigLastUpdated(config, now);
  fs.mkdirSync(path.dirname(outputConfigPath), { recursive: true });
  fs.writeFileSync(outputConfigPath, JSON.stringify(config, null, 2));
  logger.log('Updated config file with timestamp');
}

// Main function
async function main() {
  try {
    const now = new Date();
    const sourceConfig = loadSourceConfig();
    const sources = sourceConfig.enabledRssSources;
    
    // Fetch news
    console.log('Fetching news...');
    const snapshot = await fetchNewsSnapshot({ sourceConfig });
    console.log(`Fetched ${snapshot.newsItems.length} news items from ${sources.length} active sources`);

    const insightSnapshotPath = path.join(__dirname, '../sentryinsight-findings.json');
    const insightContextPath = path.join(__dirname, '../sentryinsight-context.json');
    const currentInsightCves = fs.existsSync(insightSnapshotPath)
      ? getCurrentInsightCves(loadCurrentInsightFindings(insightSnapshotPath), now)
      : null;
    writeGeneratedNewsArtifacts({
      currentInsightCves,
      insightContext: fs.existsSync(insightContextPath)
        ? loadInsightSyncContext(insightContextPath)
        : null,
      newsItems: snapshot.newsItems,
      now,
      retainedIssueDates: listDigestIssueDates(path.resolve(__dirname, '..')),
      sourceConfig,
      sourceContributions: snapshot.sourceContributions,
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
  assignFirstSeen,
  fetchAllNews,
  fetchFeedXml,
  FEED_FETCH_LIMITS,
  fetchNewsSnapshot,
  fetchRSSFeed,
  INVALID_FEED_DATE_FALLBACK,
  createDefaultSourceConfig,
  loadSourceConfig,
  normalizeArticleDate,
  normalizeFeedText,
  normalizeFeedDate,
  normalizeSummary,
  updateConfigLastUpdated,
  writeGeneratedNewsArtifacts,
};
