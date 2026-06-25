const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const {
  DASHBOARD_RSS_LINK_CONTRACT,
  FEED_INFO_CONTRACT,
  FEED_METADATA_CONTRACT,
  ISSUE_TRAIL_CONTRACT,
  RSS_CHANNEL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
} = require('./generated-artifact-contracts');
const {
  DEFAULT_MAX_NEWS_ITEMS,
  isValidHttpUrl,
  validateSourceConfig,
} = require('./source-config-contract');

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

function normalizeGeneratedArticleLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    // Unsafe or malformed generated hrefs are reported by the safety check.
  }

  return value;
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

function extractFeedItemMetadata(feedXml) {
  const items = [];
  const itemPattern = /<item\b[^>]*>[\s\S]*?<\/item>/gi;
  const linkPattern = /<link\b[^>]*>([\s\S]*?)<\/link>/i;
  const pubDatePattern = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i;
  const dcDatePattern = /<dc:date\b[^>]*>([\s\S]*?)<\/dc:date>/i;
  let itemMatch;

  while ((itemMatch = itemPattern.exec(feedXml)) !== null) {
    const itemXml = itemMatch[0];
    const linkMatch = linkPattern.exec(itemXml);
    const pubDateMatch = pubDatePattern.exec(itemXml);
    const dcDateMatch = dcDatePattern.exec(itemXml);
    items.push({
      link: linkMatch ? decodeHtmlEntities(linkMatch[1].trim()) : '',
      pubDate: pubDateMatch ? decodeHtmlEntities(pubDateMatch[1].trim()) : '',
      dcDate: dcDateMatch ? decodeHtmlEntities(dcDateMatch[1].trim()) : '',
    });
  }

  return items;
}

function assertLinksMatchNewsData(label, actualLinks, newsData, failures, linkLabel = 'link') {
  if (actualLinks.length !== newsData.length) {
    fail(failures, `${label} has ${actualLinks.length} article links, expected ${newsData.length}`);
    return;
  }

  actualLinks.forEach((actualLink, index) => {
    const article = newsData[index];
    if (!article || typeof article !== 'object' || Array.isArray(article) || typeof article.link !== 'string') {
      return;
    }

    const expectedLink = article.link;
    if (actualLink !== expectedLink) {
      fail(failures, `${label} item ${index + 1} ${linkLabel} ${actualLink} does not match news-data.json link ${expectedLink}`);
    }
  });
}

function assertFeedItemMetadataMatchesNewsData(feedItems, newsData, failures) {
  if (feedItems.length !== newsData.length) {
    return;
  }

  feedItems.forEach((feedItem, index) => {
    const article = newsData[index];
    if (!article || typeof article !== 'object' || Array.isArray(article) || !isValidDate(article.date)) {
      return;
    }

    const articleDate = new Date(article.date);
    const expectedTime = Math.floor(articleDate.getTime() / 1000);
    const expectedDay = articleDate.toISOString().slice(0, 10);
    const itemLabel = `feed.xml item ${index + 1}`;

    if (!feedItem.pubDate || !isValidDate(feedItem.pubDate)) {
      fail(failures, `${itemLabel} pubDate must be a valid date`);
    } else if (Math.floor(new Date(feedItem.pubDate).getTime() / 1000) !== expectedTime) {
      fail(failures, `${itemLabel} pubDate ${feedItem.pubDate} does not match news-data.json date ${article.date}`);
    }

    if (!feedItem.dcDate || !isValidDate(feedItem.dcDate)) {
      fail(failures, `${itemLabel} dc:date must be a valid date`);
    } else if (new Date(feedItem.dcDate).toISOString().slice(0, 10) !== expectedDay) {
      fail(failures, `${itemLabel} dc:date ${feedItem.dcDate} does not match news-data.json date ${expectedDay}`);
    }
  });
}

function validateIssueTrailContract(indexHtml, failures) {
  const $ = cheerio.load(indexHtml);
  const trail = $(ISSUE_TRAIL_CONTRACT.navSelector);
  const sourceCoverageAnchor = $(`#${ISSUE_TRAIL_CONTRACT.sourceCoverageAnchorId}`);
  const feedLink = trail.find(`a[href="${ISSUE_TRAIL_CONTRACT.feedHref}"]`);
  const sourceCoverageLink = trail.find(`a[href="${ISSUE_TRAIL_CONTRACT.sourceCoverageHref}"]`);
  const updatedTime = trail.find('time[datetime]');
  const trailText = trail.text().replace(/\s+/g, ' ').trim();

  if (
    trail.length === 0
    || feedLink.length === 0
    || sourceCoverageLink.length === 0
    || sourceCoverageAnchor.length === 0
    || updatedTime.length === 0
    || !isValidDate(updatedTime.attr('datetime'))
    || !trailText.includes(ISSUE_TRAIL_CONTRACT.cadenceText)
  ) {
    fail(failures, 'index.html must render the digest archive trail contract');
  }
}

function isDashboardRssLink($, element) {
  if (element.tagName === 'link') {
    return true;
  }

  return /\b(rss|feed)\b/i.test($(element).text());
}

function validateDashboardRssLinkContract(indexHtml, failures) {
  const $ = cheerio.load(indexHtml);

  DASHBOARD_RSS_LINK_CONTRACT.linkSelectors.forEach((selector) => {
    let rssLinkCount = 0;

    $(selector).each((index, element) => {
      if (!isDashboardRssLink($, element)) {
        return;
      }

      rssLinkCount += 1;
      const href = $(element).attr('href') || '';
      if (href !== DASHBOARD_RSS_LINK_CONTRACT.feedHref) {
        fail(
          failures,
          `index.html RSS link ${selector} href ${href || 'missing'} must match the dashboard RSS link contract`
        );
      }
    });

    if (rssLinkCount === 0) {
      fail(failures, `index.html must render RSS link ${selector} for the dashboard RSS link contract`);
    }
  });
}

function getGeneratedMetadataTimestamps(indexHtml, failures = []) {
  const $ = cheerio.load(indexHtml);
  const selectors = [
    ['stats', FEED_METADATA_CONTRACT.statsTimeSelector],
    ['issue strip', FEED_METADATA_CONTRACT.issueStripTimeSelector],
    ['issue trail', FEED_METADATA_CONTRACT.issueTrailTimeSelector],
  ];
  const timestamps = new Set();

  selectors.forEach(([label, selector]) => {
    const elements = $(selector);
    if (elements.length === 0) {
      fail(failures, `index.html must render generated metadata timestamp for ${label}`);
      return;
    }

    elements.each((index, element) => {
      const value = $(element).attr('datetime');
      if (isValidDate(value)) {
        timestamps.add(value);
      } else {
        fail(failures, `index.html generated metadata timestamp for ${label} must be a valid date`);
      }
    });
  });

  return [...timestamps];
}

function validateFeedMetadataContract(feedInfo, indexHtml, failures) {
  const feedUpdatedAt = new Date(feedInfo.lastUpdated).getTime();
  const generatedTimestamps = getGeneratedMetadataTimestamps(indexHtml, failures);

  if (generatedTimestamps.length === 0) {
    fail(failures, 'index.html must render generated metadata timestamps');
    return;
  }

  generatedTimestamps.forEach((timestamp) => {
    const generatedAt = new Date(timestamp).getTime();
    const driftMs = Math.abs(feedUpdatedAt - generatedAt);
    if (driftMs > FEED_METADATA_CONTRACT.maxTimestampDriftMs) {
      fail(
        failures,
        `feed-info.json lastUpdated must align with generated index.html metadata; ${feedInfo.lastUpdated} differs from ${timestamp} by ${driftMs}ms`
      );
    }
  });
}

function getExpectedSourceCounts(newsData, enabledSources) {
  const counts = new Map();
  enabledSources.forEach((source) => {
    if (source && typeof source.name === 'string') {
      counts.set(source.name, 0);
    }
  });

  newsData.forEach((article) => {
    if (!article || typeof article !== 'object' || Array.isArray(article) || typeof article.source !== 'string') {
      return;
    }
    counts.set(article.source, (counts.get(article.source) || 0) + 1);
  });

  return counts;
}

function validateSourceCoverageContract(indexHtml, newsData, enabledSources, failures) {
  const $ = cheerio.load(indexHtml);
  const section = $(SOURCE_COVERAGE_CONTRACT.sectionSelector);
  if (section.length === 0) {
    fail(failures, 'index.html must render the source coverage contract');
    return;
  }

  const expectedCounts = getExpectedSourceCounts(newsData, enabledSources);
  const seenSources = new Set();
  section.find(SOURCE_COVERAGE_CONTRACT.buttonSelector).each((index, element) => {
    const button = $(element);
    const source = button.attr(SOURCE_COVERAGE_CONTRACT.buttonDataAttribute) || '';
    const countText = button.find('strong').first().text().trim();
    const count = /^\d+$/.test(countText) ? Number.parseInt(countText, 10) : null;

    if (seenSources.has(source)) {
      fail(failures, `index.html source coverage duplicates source ${source}`);
      return;
    }
    seenSources.add(source);

    if (!expectedCounts.has(source)) {
      fail(failures, `index.html source coverage includes unexpected source ${source}`);
      return;
    }

    const expectedCount = expectedCounts.get(source);
    if (count !== expectedCount) {
      fail(failures, `index.html source coverage count for ${source} ${countText || 'missing'} does not match news-data.json count ${expectedCount}`);
    }

    const filterOption = $(`${SOURCE_COVERAGE_CONTRACT.sourceFilterSelector} option`)
      .filter((optionIndex, option) => $(option).attr('value') === source);
    if (expectedCount > 0 && filterOption.length === 0) {
      fail(failures, `index.html source coverage source ${source} is not available in the source filter`);
    }

    if (expectedCount === 0 && (button.attr('disabled') === undefined || button.attr('aria-disabled') !== 'true')) {
      fail(failures, `index.html source coverage source ${source} with zero items must be disabled`);
    }
  });

  expectedCounts.forEach((count, source) => {
    if (!seenSources.has(source)) {
      fail(failures, `index.html source coverage is missing source ${source}`);
    }
  });
}

function getRssChannelIdentity(feedXml) {
  const $ = cheerio.load(feedXml, { xmlMode: true });
  const channel = $('channel').first();
  return {
    atomSelfLink: channel.children('atom\\:link[rel="self"]').attr('href') || '',
    description: channel.children('description').first().text().trim(),
    link: channel.children('link').first().text().trim(),
    title: channel.children('title').first().text().trim(),
  };
}

function validateRssChannelContract(channelIdentity, failures) {
  const {
    atomSelfLink,
    description,
    link,
    title,
  } = channelIdentity;

  if (title !== RSS_CHANNEL_CONTRACT.title) {
    fail(failures, 'feed.xml channel title must match the RSS channel contract');
  }

  if (description !== RSS_CHANNEL_CONTRACT.description) {
    fail(failures, 'feed.xml channel description must match the RSS channel contract');
  }

  if (link !== RSS_CHANNEL_CONTRACT.publicSiteUrl) {
    fail(failures, 'feed.xml channel link must match the public SentryDigest site URL');
  }

  if (atomSelfLink !== RSS_CHANNEL_CONTRACT.publicFeedUrl) {
    fail(failures, 'feed.xml atom self link must match the public SentryDigest feed URL');
  }
}

function validateFeedIdentityCrossArtifactContract(feedInfo, channelIdentity, failures) {
  if (feedInfo.url !== channelIdentity.atomSelfLink) {
    fail(failures, 'feed-info.json url must match feed.xml atom self link');
  }
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
  let maxNewsItems = DEFAULT_MAX_NEWS_ITEMS;

  if (config) {
    const sourceConfig = validateSourceConfig(config, failures);
    enabledSources = sourceConfig.enabledRssSources;
    maxNewsItems = sourceConfig.maxNewsItems;
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
    if (feedInfo.title !== FEED_INFO_CONTRACT.title) {
      fail(failures, 'feed-info.json title must match the feed info contract');
    }

    if (feedInfo.url !== FEED_INFO_CONTRACT.publicFeedUrl) {
      fail(failures, 'feed-info.json url must match the public SentryDigest feed URL');
    }

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
    } else if (indexHtml) {
      validateFeedMetadataContract(feedInfo, indexHtml, failures);
    }
  }

  if (feedXml && newsData && Array.isArray(newsData)) {
    if (!feedXml.includes('<rss') || !feedXml.includes('<channel>')) {
      fail(failures, 'feed.xml must contain an RSS channel');
    } else {
      const channelIdentity = getRssChannelIdentity(feedXml);
      validateRssChannelContract(channelIdentity, failures);
      if (feedInfo) {
        validateFeedIdentityCrossArtifactContract(feedInfo, channelIdentity, failures);
      }
    }

    const feedItemCount = countMatches(feedXml, /<item>/g);
    if (feedItemCount !== newsData.length) {
      fail(failures, `feed.xml has ${feedItemCount} items, expected ${newsData.length}`);
    }

    const feedItems = extractFeedItemMetadata(feedXml);
    assertLinksMatchNewsData('feed.xml', feedItems.map((item) => item.link), newsData, failures);
    assertFeedItemMetadataMatchesNewsData(feedItems, newsData, failures);

  }

  if (indexHtml && newsData && Array.isArray(newsData)) {
    if (!indexHtml.includes('SentryDigest')) {
      fail(failures, 'index.html must identify SentryDigest');
    }
    if (!indexHtml.includes('href="./feed.xml"')) {
      fail(failures, 'index.html must link to feed.xml');
    }
    validateDashboardRssLinkContract(indexHtml, failures);
    validateIssueTrailContract(indexHtml, failures);
    validateSourceCoverageContract(indexHtml, newsData, enabledSources, failures);

    const articleCount = countMatches(indexHtml, /<article class="news-item"/g);
    if (newsData.length > 0 && articleCount !== newsData.length) {
      fail(failures, `index.html renders ${articleCount} article cards, expected ${newsData.length}`);
    }

    const articleHrefs = extractArticleHrefs(indexHtml);
    articleHrefs.forEach((href) => {
      if (!isSafeGeneratedArticleHref(href)) {
        fail(failures, `index.html contains unsafe article href ${decodeHtmlEntities(href)}`);
      }
    });

    const normalizedArticleHrefs = articleHrefs
      .map(decodeHtmlEntities)
      .map(normalizeGeneratedArticleLink);
    const normalizedNewsData = newsData.map((article) => {
      if (!article || typeof article !== 'object' || Array.isArray(article) || typeof article.link !== 'string') {
        return article;
      }

      return {
        ...article,
        link: normalizeGeneratedArticleLink(article.link),
      };
    });

    assertLinksMatchNewsData('index.html article', normalizedArticleHrefs, normalizedNewsData, failures, 'href');
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
  extractFeedItemMetadata,
  extractArticleHrefs,
  getGeneratedMetadataTimestamps,
  isSafeGeneratedArticleHref,
  normalizeGeneratedArticleLink,
  validateArtifacts,
};
