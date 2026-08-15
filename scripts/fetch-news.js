const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { generateHTML } = require('./render-news-html');
const { assertNewsDataContract } = require('./news-data-contract');
const { assertSourceConfigContract } = require('./source-config-contract');
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

function normalizeFeedText(value) {
  let normalized = String(value ?? '');

  for (let pass = 0; pass < 3; pass += 1) {
    const document = cheerio.load(normalized, null, false);
    document('style, script, noscript, template').remove();
    const decoded = document.text();
    if (decoded === normalized) {
      break;
    }
    normalized = decoded;
  }

  return normalized.replace(/\s+/g, ' ').trim();
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

// Function to fetch RSS feed content
async function fetchRSSFeed(source) {
  const Parser = require('rss-parser');
  const parser = new Parser();
  const feed = await parser.parseURL(source.url);
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
      allNewsArrays.push(result.value);
      sourceContributions.push({
        name: sources[index].name,
        lastContributedAt: newestContributionTimestamp(
          Array.isArray(result.value) ? result.value.map((article) => article?.date) : []
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
