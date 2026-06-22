const fs = require('fs');
const path = require('path');

function readText(label, filePath, repoRoot, failures) {
  if (!fs.existsSync(filePath)) {
    fail(failures, `${label} is missing at ${path.relative(repoRoot, filePath)}`);
    return null;
  }

  return fs.readFileSync(filePath, 'utf8');
}

function fail(failures, message) {
  failures.push(message);
}

function readJson(label, filePath, repoRoot, failures) {
  const text = readText(label, filePath, repoRoot, failures);
  if (text === null) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(failures, `${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidDate(value) {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function decodeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return null;
  }

  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (entity, hex) => decodeCodePoint(hex, 16) ?? entity)
    .replace(/&#([0-9]+);?/g, (entity, decimal) => decodeCodePoint(decimal, 10) ?? entity)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function isSafeGeneratedArticleHref(value) {
  const href = decodeHtmlEntities(value).trim();
  if (href === '#') {
    return true;
  }

  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractArticleHrefs(indexHtml) {
  const hrefs = [];
  const articlePattern = /<article\b[^>]*class="[^"]*\bnews-item\b[^"]*"[^>]*>[\s\S]*?<\/article>/gi;
  const hrefPattern = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  let articleMatch;

  while ((articleMatch = articlePattern.exec(indexHtml)) !== null) {
    let hrefMatch;
    while ((hrefMatch = hrefPattern.exec(articleMatch[0])) !== null) {
      hrefs.push(hrefMatch[2]);
    }
  }

  return hrefs;
}

function extractFeedItemLinks(feedXml) {
  const links = [];
  const itemPattern = /<item\b[^>]*>[\s\S]*?<\/item>/gi;
  const linkPattern = /<link\b[^>]*>([\s\S]*?)<\/link>/i;
  let itemMatch;

  while ((itemMatch = itemPattern.exec(feedXml)) !== null) {
    const linkMatch = linkPattern.exec(itemMatch[0]);
    links.push(linkMatch ? decodeHtmlEntities(linkMatch[1].trim()) : '');
  }

  return links;
}

function assertLinksMatchNewsData(label, actualLinks, newsData, failures, linkLabel = 'link') {
  if (actualLinks.length !== newsData.length) {
    fail(failures, `${label} has ${actualLinks.length} article links, expected ${newsData.length}`);
    return;
  }

  actualLinks.forEach((actualLink, index) => {
    const expectedLink = newsData[index].link;
    if (actualLink !== expectedLink) {
      fail(failures, `${label} item ${index + 1} ${linkLabel} ${actualLink} does not match news-data.json link ${expectedLink}`);
    }
  });
}

function validateArtifacts(repoRoot = path.join(__dirname, '..')) {
  const artifacts = {
    config: path.join(repoRoot, 'config/news-sources.json'),
    newsData: path.join(repoRoot, 'news-data.json'),
    feedInfo: path.join(repoRoot, 'feed-info.json'),
    feedXml: path.join(repoRoot, 'feed.xml'),
    indexHtml: path.join(repoRoot, 'index.html'),
  };
  const failures = [];
  const config = readJson('config/news-sources.json', artifacts.config, repoRoot, failures);
  const newsData = readJson('news-data.json', artifacts.newsData, repoRoot, failures);
  const feedInfo = readJson('feed-info.json', artifacts.feedInfo, repoRoot, failures);
  const feedXml = readText('feed.xml', artifacts.feedXml, repoRoot, failures);
  const indexHtml = readText('index.html', artifacts.indexHtml, repoRoot, failures);

  let enabledSources = [];
  let maxNewsItems = 30;

  if (config) {
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      fail(failures, 'config/news-sources.json must define at least one source');
    } else {
      enabledSources = config.sources.filter((source) => source.enabled);
      enabledSources.forEach((source, index) => {
        const label = `config source ${index + 1}`;
        if (!source.name || typeof source.name !== 'string') {
          fail(failures, `${label} must have a string name`);
        }
        if (!source.url || !isValidHttpUrl(source.url)) {
          fail(failures, `${label} must have an http(s) url`);
        }
        if (source.type !== 'rss') {
          fail(failures, `${label} has unsupported type "${source.type}"`);
        }
      });
    }

    if (config.settings && config.settings.maxNewsItems !== undefined) {
      maxNewsItems = config.settings.maxNewsItems;
    }

    if (!Number.isInteger(maxNewsItems) || maxNewsItems <= 0) {
      fail(failures, 'settings.maxNewsItems must be a positive integer');
    }
  }

  if (newsData) {
    if (!Array.isArray(newsData)) {
      fail(failures, 'news-data.json must be an array');
    } else {
      if (newsData.length > maxNewsItems) {
        fail(failures, `news-data.json has ${newsData.length} items, which exceeds maxNewsItems ${maxNewsItems}`);
      }

      const links = new Set();
      const enabledSourceNames = new Set(enabledSources.map((source) => source.name));

      newsData.forEach((article, index) => {
        const label = `news-data item ${index + 1}`;
        if (!article || typeof article !== 'object' || Array.isArray(article)) {
          fail(failures, `${label} must be an object`);
          return;
        }

        if (!article.title || typeof article.title !== 'string') {
          fail(failures, `${label} must have a string title`);
        }
        if (!article.link || !isValidHttpUrl(article.link)) {
          fail(failures, `${label} must have an http(s) link`);
        } else if (links.has(article.link)) {
          fail(failures, `${label} duplicates link ${article.link}`);
        } else {
          links.add(article.link);
        }
        if (!article.date || !isValidDate(article.date)) {
          fail(failures, `${label} must have a valid date`);
        }
        if (!article.source || typeof article.source !== 'string') {
          fail(failures, `${label} must have a string source`);
        } else if (enabledSourceNames.size > 0 && !enabledSourceNames.has(article.source)) {
          fail(failures, `${label} source "${article.source}" is not enabled in config`);
        }
        if (article.summary !== undefined && typeof article.summary !== 'string') {
          fail(failures, `${label} summary must be a string when present`);
        }

        if (index > 0 && isValidDate(article.date) && isValidDate(newsData[index - 1].date)) {
          const previous = new Date(newsData[index - 1].date).getTime();
          const current = new Date(article.date).getTime();
          if (current > previous) {
            fail(failures, `${label} is newer than the previous item; news-data.json must be newest-first`);
          }
        }
      });
    }
  }

  if (feedInfo && newsData && Array.isArray(newsData)) {
    if (feedInfo.itemCount !== newsData.length) {
      fail(failures, `feed-info.json itemCount ${feedInfo.itemCount} does not match news-data.json length ${newsData.length}`);
    }

    if (!Array.isArray(feedInfo.sources)) {
      fail(failures, 'feed-info.json sources must be an array');
    } else {
      const expectedSources = enabledSources.map((source) => source.name).sort();
      const actualSources = [...feedInfo.sources].sort();
      if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
        fail(failures, 'feed-info.json sources must match enabled config sources');
      }
    }

    if (!feedInfo.lastUpdated || !isValidDate(feedInfo.lastUpdated)) {
      fail(failures, 'feed-info.json lastUpdated must be a valid date');
    }
  }

  if (feedXml && newsData && Array.isArray(newsData)) {
    if (!feedXml.includes('<rss') || !feedXml.includes('<channel>')) {
      fail(failures, 'feed.xml must contain an RSS channel');
    }

    const feedItemCount = countMatches(feedXml, /<item>/g);
    if (feedItemCount !== newsData.length) {
      fail(failures, `feed.xml has ${feedItemCount} items, expected ${newsData.length}`);
    }

    assertLinksMatchNewsData('feed.xml', extractFeedItemLinks(feedXml), newsData, failures);

    if (!feedXml.includes('https://ricomanifesto.github.io/SentryDigest/feed.xml')) {
      fail(failures, 'feed.xml must advertise the public SentryDigest feed URL');
    }
  }

  if (indexHtml && newsData && Array.isArray(newsData)) {
    if (!indexHtml.includes('SentryDigest')) {
      fail(failures, 'index.html must identify SentryDigest');
    }
    if (!indexHtml.includes('href="./feed.xml"')) {
      fail(failures, 'index.html must link to feed.xml');
    }

    const articleCount = countMatches(indexHtml, /<article class="news-item"/g);
    if (newsData.length > 0 && articleCount !== newsData.length) {
      fail(failures, `index.html renders ${articleCount} article cards, expected ${newsData.length}`);
    }

    extractArticleHrefs(indexHtml).forEach((href) => {
      if (!isSafeGeneratedArticleHref(href)) {
        fail(failures, `index.html contains unsafe article href ${decodeHtmlEntities(href)}`);
      }
    });

    assertLinksMatchNewsData('index.html article', extractArticleHrefs(indexHtml), newsData, failures, 'href');
  }

  const itemCount = Array.isArray(newsData) ? newsData.length : 0;

  return {
    valid: failures.length === 0,
    failures,
    itemCount,
    enabledSourceCount: enabledSources.length,
  };
}

function runCli() {
  const result = validateArtifacts();

  if (!result.valid) {
    console.error('Artifact validation failed:');
    result.failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log(`Artifact validation passed for ${result.itemCount} news items across ${result.enabledSourceCount} enabled sources.`);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  extractFeedItemLinks,
  extractArticleHrefs,
  isSafeGeneratedArticleHref,
  validateArtifacts,
};
