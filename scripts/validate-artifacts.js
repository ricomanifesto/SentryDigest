const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const {
  DASHBOARD_RSS_LINK_CONTRACT,
  DIGEST_LEGEND_CONTRACT,
  FEED_INFO_CONTRACT,
  FEED_METADATA_CONTRACT,
  formatSourceShortcutStatus,
  HANDOFF_DESTINATION_CONTRACT,
  ISSUE_TRAIL_CONTRACT,
  OPERATOR_LANE_CONTRACT,
  RSS_CHANNEL_CONTRACT,
  SITE_METADATA_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
  SUMMARY_CONTINUATION_CONTRACT,
} = require('./generated-artifact-contracts');
const {
  collectOperatorLanes,
  collectSourceCoverage,
  deriveArticleFacets,
  getHandoffDestination,
  renderInsightContext,
} = require('./render-news-html');
const {
  DEFAULT_MAX_NEWS_ITEMS,
  validateSourceConfig,
} = require('./source-config-contract');
const {
  collectNewsDataFailures,
  isValidDate,
} = require('./news-data-contract');
const { collectSourceHealth, describeSourceHealth } = require('./source-health');
const { articleFragment, normalizeArticleUrl } = require('./reporting-identity');
const {
  assertCurrentInsightFindings,
  getCurrentInsightCves,
} = require('./current-insight-findings');
const { assertInsightSyncContext } = require('./insight-sync-context');

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

function parseArtifactCount(value) {
  return /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
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
  const anchorPattern = /<a\b([^>]*)>/gi;
  const hrefPattern = /\bhref\s*=\s*(["'])(.*?)\1/i;
  let articleMatch;

  while ((articleMatch = articlePattern.exec(indexHtml)) !== null) {
    let anchorMatch;
    while ((anchorMatch = anchorPattern.exec(articleMatch[0])) !== null) {
      if (/\bclass\s*=\s*(["'])[^"']*\b(?:handoff-cue|item-permalink|summary-continuation)\b[^"']*\1/i.test(anchorMatch[1])) {
        continue;
      }
      const hrefMatch = hrefPattern.exec(anchorMatch[1]);
      if (hrefMatch) {
        hrefs.push(hrefMatch[2]);
      }
    }
  }

  return hrefs;
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

function validateIssueTrailContract(indexHtml, failures, issueDates = [], generatedAt = null) {
  const $ = cheerio.load(indexHtml);
  const trail = $(ISSUE_TRAIL_CONTRACT.navSelector);
  const sourceCoverageAnchor = $(`#${ISSUE_TRAIL_CONTRACT.sourceCoverageAnchorId}`);
  const feedLink = trail.find(`a[href="${ISSUE_TRAIL_CONTRACT.feedHref}"]`);
  const sourceCoverageLink = trail.find(`a[href="${ISSUE_TRAIL_CONTRACT.sourceCoverageHref}"]`);
  const updatedTime = trail.find('time[datetime]');
  const trailText = trail.text().replace(/\s+/g, ' ').trim();
  const currentIssueDate = isValidDate(generatedAt)
    ? new Date(generatedAt).toISOString().slice(0, 10)
    : '';
  const previousIssueDate = issueDates.filter((value) => value < currentIssueDate).at(-1);
  const previousIssues = trail.find(`a[href="${ISSUE_TRAIL_CONTRACT.archiveHref}"]`);
  const previousIssue = previousIssueDate
    ? trail.find(`a[href="./archive/${previousIssueDate}/"]`)
    : cheerio.load('<span></span>')('missing');

  if (
    trail.length === 0
    || feedLink.length === 0
    || sourceCoverageLink.length === 0
    || sourceCoverageAnchor.length === 0
    || updatedTime.length === 0
    || !isValidDate(updatedTime.attr('datetime'))
    || !trailText.includes(ISSUE_TRAIL_CONTRACT.cadenceText)
    || (previousIssueDate && (previousIssues.length !== 1 || previousIssue.length !== 1))
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

      const expectedLabel = DASHBOARD_RSS_LINK_CONTRACT.linkLabels[selector];
      if (expectedLabel) {
        const label = $(element).attr('aria-label') || '';
        if (label !== expectedLabel) {
          fail(failures, `index.html RSS link ${selector} label ${label || 'missing'} must match ${expectedLabel}`);
        }
      }
    });

    if (rssLinkCount === 0) {
      fail(failures, `index.html must render RSS link ${selector} for the dashboard RSS link contract`);
    }
  });
}

function validateFilterInsightsContract(indexHtml, failures) {
  const $ = cheerio.load(indexHtml);
  const filterInsights = $('#filterInsights').first();

  if (filterInsights.length === 0) {
    fail(failures, 'index.html must render the filter insights region');
    return;
  }

  if (filterInsights.attr('hidden') === undefined) {
    fail(failures, 'index.html filter insights region must render hidden by default');
  }
}

function getExpectedDigestLegendEntries(newsData) {
  const sourceSignals = new Map();
  const handoffCues = new Map(Object.entries(DIGEST_LEGEND_CONTRACT.handoffCueDetails));

  newsData.forEach((article) => {
    if (!article || typeof article !== 'object' || Array.isArray(article)) {
      return;
    }

    const sourceSignal = deriveArticleFacets(article).sourceSignal;
    const sourceSignalDetail = DIGEST_LEGEND_CONTRACT.sourceSignalDetails[sourceSignal];
    if (sourceSignalDetail) {
      sourceSignals.set(sourceSignal, sourceSignalDetail);
    }

  });

  return { handoffCues, sourceSignals };
}

function validateDigestLegendGroup($, legend, expectedEntries, options, failures) {
  if (expectedEntries.size === 0) {
    return;
  }

  const group = legend.find(options.groupSelector).first();
  if (group.length === 0) {
    fail(failures, `index.html must render the ${options.label} legend`);
    return;
  }

  const seenEntries = new Set();
  group.find(options.itemSelector).each((index, element) => {
    const item = $(element);
    const name = item.find(options.nameSelector).first().text().trim();
    const detail = item.find(options.detailSelector).first().text().trim();

    if (seenEntries.has(name)) {
      fail(failures, `index.html ${options.label} legend duplicates ${name}`);
      return;
    }
    seenEntries.add(name);

    if (!expectedEntries.has(name)) {
      fail(failures, `index.html ${options.label} legend includes unexpected ${name || 'missing'}`);
      return;
    }

    const expectedDetail = expectedEntries.get(name);
    if (detail !== expectedDetail) {
      fail(failures, `index.html ${options.label} legend detail for ${name} ${detail || 'missing'} does not match expected ${expectedDetail}`);
    }
  });

  expectedEntries.forEach((detail, name) => {
    if (!seenEntries.has(name)) {
      fail(failures, `index.html ${options.label} legend is missing ${name}`);
    }
  });
}

function validateDigestLegendContract(indexHtml, newsData, failures) {
  const expectedEntries = getExpectedDigestLegendEntries(newsData);
  if (expectedEntries.sourceSignals.size === 0 && expectedEntries.handoffCues.size === 0) {
    return;
  }

  const $ = cheerio.load(indexHtml);
  const legend = $(DIGEST_LEGEND_CONTRACT.selector).first();
  if (legend.length === 0) {
    fail(failures, 'index.html must render the digest legend contract');
    return;
  }

  validateDigestLegendGroup($, legend, expectedEntries.sourceSignals, {
    detailSelector: DIGEST_LEGEND_CONTRACT.sourceSignalDetailSelector,
    groupSelector: DIGEST_LEGEND_CONTRACT.sourceSignalGroupSelector,
    itemSelector: DIGEST_LEGEND_CONTRACT.sourceSignalSelector,
    label: 'source signal',
    nameSelector: DIGEST_LEGEND_CONTRACT.sourceSignalNameSelector,
  }, failures);

  validateDigestLegendGroup($, legend, expectedEntries.handoffCues, {
    detailSelector: DIGEST_LEGEND_CONTRACT.handoffCueDetailSelector,
    groupSelector: DIGEST_LEGEND_CONTRACT.handoffCueGroupSelector,
    itemSelector: DIGEST_LEGEND_CONTRACT.handoffCueSelector,
    label: 'handoff cue',
    nameSelector: DIGEST_LEGEND_CONTRACT.handoffCueNameSelector,
  }, failures);
}

function validateOperatorLaneContract(indexHtml, newsData, failures, currentInsightCves = null) {
  const validArticles = newsData.filter((article) => (
    article
    && typeof article === 'object'
    && !Array.isArray(article)
  ));
  const expectedLanes = collectOperatorLanes(validArticles, currentInsightCves);
  const shouldRenderLanes = expectedLanes.length > 0;
  const $ = cheerio.load(indexHtml);
  const section = $(OPERATOR_LANE_CONTRACT.sectionSelector).first();

  if (!shouldRenderLanes) {
    if (section.length > 0) {
      fail(failures, 'index.html must omit operator scan lanes when no lane has matching articles');
    }
    return;
  }

  if (section.length === 0) {
    fail(failures, 'index.html must render the operator scan lanes contract');
    return;
  }

  const expectedByLabel = new Map(expectedLanes.map((lane) => [
    lane.label,
    {
      ...lane,
    },
  ]));
  const seenLanes = new Set();

  section.find(OPERATOR_LANE_CONTRACT.laneSelector).each((index, element) => {
    const lane = $(element);
    const label = lane.attr(OPERATOR_LANE_CONTRACT.labelAttribute) || '';
    const heading = lane.find(OPERATOR_LANE_CONTRACT.headingSelector).first().text().trim();
    const cue = lane.attr(OPERATOR_LANE_CONTRACT.cueAttribute) || '';
    const countText = lane.find(`${OPERATOR_LANE_CONTRACT.countSelector} strong`).first().text().trim();
    const count = parseArtifactCount(countText);
    const latestLink = lane.find(OPERATOR_LANE_CONTRACT.latestLinkSelector).first();
    const latestHref = latestLink.attr('href') || '';
    const latestTitle = latestLink.text().trim();

    if (seenLanes.has(label)) {
      fail(failures, `index.html operator lane duplicates ${label}`);
      return;
    }
    seenLanes.add(label);

    if (!expectedByLabel.has(label)) {
      fail(failures, `index.html operator lane includes unexpected ${label || 'missing'}`);
      return;
    }

    const expected = expectedByLabel.get(label);

    if (heading !== expected.label) {
      fail(failures, `index.html operator lane ${label} heading ${heading || 'missing'} does not match expected ${expected.label}`);
    }

    if (cue !== expected.cue) {
      fail(failures, `index.html operator lane ${label} cue ${cue || 'missing'} does not match expected ${expected.cue}`);
    }

    if (count !== expected.count) {
      fail(failures, `index.html operator lane ${label} count ${countText || 'missing'} does not match expected ${expected.count}`);
    }

    if (latestHref !== expected.latestLink) {
      fail(failures, `index.html operator lane ${label} latest link ${latestHref || 'missing'} does not match expected ${expected.latestLink}`);
    }

    const expectedTitle = expected.latestTitle || 'No current match';
    if (latestTitle !== expectedTitle) {
      fail(failures, `index.html operator lane ${label} latest title ${latestTitle || 'missing'} does not match expected ${expectedTitle}`);
    }
  });

  expectedByLabel.forEach((expected, label) => {
    if (!seenLanes.has(label)) {
      fail(failures, `index.html operator lane is missing ${label}`);
    }
  });
}

function getGeneratedMetadataTimestamps(indexHtml, failures = []) {
  const $ = cheerio.load(indexHtml);
  const selectors = [
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

function validateSourceCoverageContract(indexHtml, newsData, enabledSources, failures) {
  const $ = cheerio.load(indexHtml);
  const section = $(SOURCE_COVERAGE_CONTRACT.sectionSelector);
  if (section.length === 0) {
    fail(failures, 'index.html must render the source coverage contract');
    return;
  }

  const generatedAt = $(FEED_METADATA_CONTRACT.issueStripTimeSelector).first().attr('datetime');
  const sourceHealth = describeSourceHealth(
    collectSourceHealth(newsData, enabledSources),
    isValidDate(generatedAt) ? generatedAt : new Date(0),
  );
  const expectedCounts = new Map(
    sourceHealth
      .map(({ name, itemCount }) => [name, itemCount])
  );
  const expectedActiveSources = Array.from(expectedCounts.values()).filter((count) => count > 0).length;
  const expectedQuietSources = Array.from(expectedCounts.values()).filter((count) => count === 0).length;
  const sourceHealthSummary = section.find(SOURCE_COVERAGE_CONTRACT.healthSelector).first();
  const sourceFilterStatus = section.find(SOURCE_COVERAGE_CONTRACT.statusSelector).first();
  const seenSources = new Set();

  if (sourceHealthSummary.length === 0) {
    fail(failures, 'index.html must render the source health summary');
  } else {
    const activeCountText = sourceHealthSummary.attr(SOURCE_COVERAGE_CONTRACT.activeSourcesAttribute) || '';
    const quietCountText = sourceHealthSummary.attr(SOURCE_COVERAGE_CONTRACT.quietSourcesAttribute) || '';
    const activeCount = parseArtifactCount(activeCountText);
    const quietCount = parseArtifactCount(quietCountText);
    const visibleCounts = sourceHealthSummary.find('strong')
      .map((index, element) => $(element).text().trim())
      .get();
    const visibleActiveCount = parseArtifactCount(visibleCounts[0] || '');
    const visibleQuietCount = parseArtifactCount(visibleCounts[1] || '');

    if (activeCount !== expectedActiveSources) {
      fail(failures, `index.html source health active count ${activeCountText || 'missing'} does not match expected ${expectedActiveSources}`);
    }

    if (quietCount !== expectedQuietSources) {
      fail(failures, `index.html source health quiet count ${quietCountText || 'missing'} does not match expected ${expectedQuietSources}`);
    }

    if (visibleActiveCount !== expectedActiveSources) {
      fail(failures, `index.html source health visible active count ${visibleCounts[0] || 'missing'} does not match expected ${expectedActiveSources}`);
    }

    if (visibleQuietCount !== expectedQuietSources) {
      fail(failures, `index.html source health visible quiet count ${visibleCounts[1] || 'missing'} does not match expected ${expectedQuietSources}`);
    }
  }

  const sourceFilterStatusText = sourceFilterStatus.text().trim();
  const expectedSourceFilterStatus = formatSourceShortcutStatus(SOURCE_COVERAGE_CONTRACT.statusAllSourcesText, newsData.length);
  if (sourceFilterStatusText !== expectedSourceFilterStatus) {
    fail(failures, `index.html source filter status ${sourceFilterStatusText || 'missing'} does not match expected ${expectedSourceFilterStatus}`);
  }

  section.find(SOURCE_COVERAGE_CONTRACT.buttonSelector).each((index, element) => {
    const button = $(element);
    const source = button.attr(SOURCE_COVERAGE_CONTRACT.buttonDataAttribute) || '';
    const countText = button.find('strong').first().text().trim();
    const count = parseArtifactCount(countText);

    if (seenSources.has(source)) {
      fail(failures, `index.html source coverage duplicates source ${source}`);
      return;
    }
    seenSources.add(source);

    if (!expectedCounts.has(source) || expectedCounts.get(source) === 0) {
      fail(failures, `index.html source coverage includes unexpected source ${source}`);
      return;
    }

    const expectedCount = expectedCounts.get(source);
    if (count !== expectedCount) {
      fail(failures, `index.html source coverage count for ${source} ${countText || 'missing'} does not match news-data.json count ${expectedCount}`);
    }

    const expectedArticleLabel = expectedCount === 1 ? 'article' : 'articles';
    const expectedSourceLabel = `Filter to ${source} source, ${expectedCount} ${expectedArticleLabel}`;
    const sourceLabel = button.attr('aria-label') || '';
    if (sourceLabel !== expectedSourceLabel) {
      fail(failures, `index.html source coverage label for ${source} ${sourceLabel || 'missing'} does not match expected ${expectedSourceLabel}`);
    }

    const filterOption = $(`${SOURCE_COVERAGE_CONTRACT.sourceFilterSelector} option`)
      .filter((optionIndex, option) => $(option).attr('value') === source);
    if (filterOption.length === 0) {
      fail(failures, `index.html source coverage source ${source} is not available in the source filter`);
    }
  });

  expectedCounts.forEach((count, source) => {
    if (count > 0 && !seenSources.has(source)) {
      fail(failures, `index.html source coverage is missing source ${source}`);
    }
  });

  const expectedHealth = new Map(
    sourceHealth
      .filter(({ itemCount }) => itemCount === 0)
      .map((health) => [health.name, health])
  );
  const seenQuietSources = new Set();
  section.find(SOURCE_COVERAGE_CONTRACT.quietSourceSelector).each((index, element) => {
    const quietSource = $(element);
    const source = quietSource.attr(SOURCE_COVERAGE_CONTRACT.quietSourceAttribute) || '';
    const lastContributedAt = quietSource.attr(SOURCE_COVERAGE_CONTRACT.quietSourceLastContributedAttribute) || null;
    const status = quietSource.attr(SOURCE_COVERAGE_CONTRACT.healthStatusAttribute) || '';
    const quietForDaysText = quietSource.attr(SOURCE_COVERAGE_CONTRACT.quietSourceDaysAttribute) ?? '';
    seenQuietSources.add(source);

    if (!expectedHealth.has(source)) {
      fail(failures, `index.html source health includes unexpected quiet source ${source || 'missing'}`);
      return;
    }

    const expected = expectedHealth.get(source);
    if (lastContributedAt !== expected.lastContributedAt) {
      fail(failures, `index.html quiet source ${source} last contribution ${lastContributedAt || 'missing'} does not match config ${expected.lastContributedAt || 'missing'}`);
    }
    if (status !== expected.status) {
      fail(failures, `index.html quiet source ${source} health status ${status || 'missing'} does not match expected ${expected.status}`);
    }
    if (quietForDaysText !== (expected.quietForDays === null ? '' : String(expected.quietForDays))) {
      fail(failures, `index.html quiet source ${source} quiet days ${quietForDaysText || 'missing'} does not match expected ${expected.quietForDays}`);
    }
    if (expected.status === 'quiet' && !/\bquiet since\b/i.test(quietSource.text())) {
      fail(failures, `index.html quiet source ${source} must say when it became quiet`);
    }
    if (expected.status === 'stale' && !/\bfeed may have moved\b/i.test(quietSource.text())) {
      fail(failures, `index.html stale source ${source} must warn that the feed may have moved`);
    }
    if (expected.status === 'unobserved' && !/\bno contribution recorded\b/i.test(quietSource.text())) {
      fail(failures, `index.html unobserved source ${source} must say no contribution is recorded`);
    }
  });

  expectedHealth.forEach((health, source) => {
    if (!seenQuietSources.has(source)) {
      fail(failures, `index.html source health is missing quiet source ${source}`);
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

function validateSiteMetadata(indexHtml, sitemapXml, failures) {
  if (indexHtml) {
    const $ = cheerio.load(indexHtml);
    const exactValues = [
      ['index.html title', $('title').first().text().trim(), SITE_METADATA_CONTRACT.title],
      ['index.html description', $('meta[name="description"]').attr('content'), SITE_METADATA_CONTRACT.description],
      ['index.html canonical URL', $('link[rel="canonical"]').attr('href'), SITE_METADATA_CONTRACT.publicSiteUrl],
      ['index.html Open Graph type', $('meta[property="og:type"]').attr('content'), 'website'],
      ['index.html Open Graph title', $('meta[property="og:title"]').attr('content'), SITE_METADATA_CONTRACT.title],
      ['index.html Open Graph description', $('meta[property="og:description"]').attr('content'), SITE_METADATA_CONTRACT.description],
      ['index.html Open Graph URL', $('meta[property="og:url"]').attr('content'), SITE_METADATA_CONTRACT.publicSiteUrl],
      ['index.html Open Graph image', $('meta[property="og:image"]').attr('content'), SITE_METADATA_CONTRACT.imageUrl],
      ['index.html Twitter card', $('meta[name="twitter:card"]').attr('content'), 'summary_large_image'],
      ['index.html Twitter title', $('meta[name="twitter:title"]').attr('content'), SITE_METADATA_CONTRACT.title],
      ['index.html Twitter description', $('meta[name="twitter:description"]').attr('content'), SITE_METADATA_CONTRACT.description],
      ['index.html Twitter image', $('meta[name="twitter:image"]').attr('content'), SITE_METADATA_CONTRACT.imageUrl],
    ];

    for (const [label, actual, expected] of exactValues) {
      if (actual !== expected) {
        fail(failures, `${label} ${actual || 'missing'} must match ${expected}`);
      }
    }

    const jsonLdText = $('script[type="application/ld+json"]').first().text().trim();
    if (!jsonLdText) {
      fail(failures, 'index.html must publish JSON-LD project identity');
    } else {
      try {
        const identity = JSON.parse(jsonLdText);
        if (
          identity['@context'] !== 'https://schema.org'
          || identity['@type'] !== 'WebSite'
          || identity.name !== 'SentryDigest'
          || identity.url !== SITE_METADATA_CONTRACT.publicSiteUrl
          || identity.description !== SITE_METADATA_CONTRACT.description
          || identity.author?.name !== SITE_METADATA_CONTRACT.authorName
          || identity.author?.url !== SITE_METADATA_CONTRACT.authorUrl
          || identity.publisher?.name !== 'Rico Manifesto'
          || identity.publisher?.url !== SITE_METADATA_CONTRACT.authorUrl
          || identity.sameAs !== SITE_METADATA_CONTRACT.githubUrl
        ) {
          fail(failures, 'index.html JSON-LD must match the public SentryDigest identity contract');
        }
      } catch (error) {
        fail(failures, `index.html JSON-LD is not valid JSON: ${error.message}`);
      }
    }

    const attribution = $(`footer a[href="${SITE_METADATA_CONTRACT.authorUrl}"]`)
      .filter((_, element) => $(element).text().trim() === SITE_METADATA_CONTRACT.authorName);
    if (attribution.length !== 1) {
      fail(failures, 'index.html footer must link Michael Rico to the canonical portfolio');
    }
  }

  if (sitemapXml) {
    const $xml = cheerio.load(sitemapXml, { xmlMode: true });
    const locations = $xml('urlset > url > loc')
      .map((_, element) => $xml(element).text().trim())
      .get();
    const archivePattern = new RegExp(`^${SITE_METADATA_CONTRACT.publicSiteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}archive/\\d{4}-\\d{2}-\\d{2}/$`);
    const expectedOrder = [
      SITE_METADATA_CONTRACT.publicSiteUrl,
      ...locations.slice(1).sort(),
    ];
    if (
      locations.length === 0
      || locations[0] !== SITE_METADATA_CONTRACT.publicSiteUrl
      || locations.slice(1).some((location) => !archivePattern.test(location))
      || new Set(locations).size !== locations.length
      || locations.some((location, index) => location !== expectedOrder[index])
    ) {
      fail(failures, 'sitemap.xml must contain the canonical project URL followed by unique dated archive URLs');
    }
  }
}

function validateDigestArchives(repoRoot, sitemapXml, failures) {
  const archiveRoot = path.join(repoRoot, 'archive');
  if (!fs.existsSync(archiveRoot)) {
    return [];
  }
  const entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
  const issueDates = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'index.html') {
      continue;
    }
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
      fail(failures, `archive contains unexpected entry ${entry.name}`);
      continue;
    }
    const issueDate = entry.name;
    issueDates.push(issueDate);
    const issueRoot = path.join(archiveRoot, issueDate);
    const manifest = readJson(
      `archive/${issueDate}/index.json`,
      path.join(issueRoot, 'index.json'),
      repoRoot,
      failures,
    );
    const issueHtml = readText(
      `archive/${issueDate}/index.html`,
      path.join(issueRoot, 'index.html'),
      repoRoot,
      failures,
    );
    if (!manifest || !issueHtml) {
      continue;
    }
    if (
      manifest.schema_version !== 1
      || manifest.issue_date !== issueDate
      || !isValidDate(manifest.generated_at)
      || !Array.isArray(manifest.articles)
    ) {
      fail(failures, `archive/${issueDate}/index.json must satisfy dated archive schema version 1`);
      continue;
    }
    if (!manifest.generated_at.startsWith(`${issueDate}T`)) {
      fail(failures, `archive/${issueDate}/index.json generated_at must use its UTC issue date`);
    }
    const $ = cheerio.load(issueHtml);
    const expectedCanonical = `${SITE_METADATA_CONTRACT.publicSiteUrl}archive/${issueDate}/`;
    if ($('link[rel="canonical"]').attr('href') !== expectedCanonical) {
      fail(failures, `archive/${issueDate}/index.html must publish its dated canonical URL`);
    }
    if ($('script').length !== 0 || issueHtml.includes('fetch(')) {
      fail(failures, `archive/${issueDate}/index.html must remain meaningful without JavaScript`);
    }
    if ($('article.reporting-item').length !== manifest.articles.length) {
      fail(failures, `archive/${issueDate}/index.html article count must match index.json`);
    }
    const seenIds = new Set();
    manifest.articles.forEach((article, index) => {
      const label = `archive/${issueDate} article ${index + 1}`;
      try {
        const normalizedLink = normalizeArticleUrl(article.link);
        const expectedId = articleFragment(normalizedLink);
        if (article.id !== expectedId || seenIds.has(expectedId)) {
          fail(failures, `${label} must use a unique URL-derived reporting ID`);
        }
        seenIds.add(expectedId);
        const card = $(`article#${expectedId}`);
        if (card.length !== 1) {
          fail(failures, `${label} is missing its rendered stable fragment`);
          return;
        }
        const sourceLink = card.find('h2 a').first();
        if (
          normalizeArticleUrl(sourceLink.attr('href')) !== normalizedLink
          || sourceLink.attr('rel') !== 'noopener noreferrer'
        ) {
          fail(failures, `${label} rendered source link must match its safe original URL`);
        }
      } catch (error) {
        fail(failures, `${label} is invalid: ${error.message}`);
      }
    });
  }
  const archiveIndex = readText(
    'archive/index.html',
    path.join(archiveRoot, 'index.html'),
    repoRoot,
    failures,
  );
  if (archiveIndex) {
    const $ = cheerio.load(archiveIndex);
    if ($('link[rel="canonical"]').attr('href') !== `${SITE_METADATA_CONTRACT.publicSiteUrl}archive/`
        || $('script').length !== 0
        || archiveIndex.includes('fetch(')) {
      fail(failures, 'archive/index.html must be a canonical no-JavaScript issue index');
    }
    const actualDates = $('main ol a[href]')
      .map((_, element) => $(element).attr('href'))
      .get()
      .map((href) => /^\.\/(\d{4}-\d{2}-\d{2})\/$/.exec(href)?.[1])
      .filter(Boolean);
    if (JSON.stringify(actualDates) !== JSON.stringify(issueDates.slice().sort().reverse())) {
      fail(failures, 'archive/index.html links must match retained digest issues newest first');
    }
  }
  if (sitemapXml) {
    const expected = issueDates
      .sort()
      .map((date) => `${SITE_METADATA_CONTRACT.publicSiteUrl}archive/${date}/`);
    const $xml = cheerio.load(sitemapXml, { xmlMode: true });
    const actual = $xml('urlset > url > loc')
      .map((_, element) => $xml(element).text().trim())
      .get()
      .slice(1);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(failures, 'sitemap.xml dated URLs must match retained digest archive directories');
    }
  }
  return issueDates.sort();
}

function validateInsightContextContract(indexHtml, context, findings, failures) {
  if (!context || !indexHtml) {
    return;
  }
  try {
    const validated = assertInsightSyncContext(context);
    if (validated.mode !== 'unavailable' && (
      validated.report_date !== findings?.report_date
      || validated.manifest_generated_at !== findings?.generated_at
    )) {
      fail(failures, 'sentryinsight-context.json provenance must match the retained findings snapshot');
    }
    const expected = renderInsightContext(validated);
    const hasContextLine = indexHtml.includes('class="insight-context"');
    if (validated.mode === 'current' ? hasContextLine : !indexHtml.includes(expected)) {
      fail(failures, 'index.html must name non-current SentryInsight context and hide current mode');
    }
  } catch (error) {
    fail(failures, `sentryinsight-context.json is invalid: ${error.message}`);
  }
}

const ENCODED_HTML_ENTITY_PATTERN = /&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/i;
const FEED_TRUNCATION_PATTERN = /\[(?:\.{3}|…)]/;

function validateReaderExperience(indexHtml, newsData = [], failures = [], options = {}) {
  newsData.forEach((article, index) => {
    if (!article || typeof article !== 'object' || Array.isArray(article)) {
      return;
    }

    if (typeof article.title === 'string' && ENCODED_HTML_ENTITY_PATTERN.test(article.title)) {
      fail(failures, `news-data.json item ${index + 1} title contains an encoded HTML entity`);
    }
    if (typeof article.summary === 'string') {
      if (ENCODED_HTML_ENTITY_PATTERN.test(article.summary)) {
        fail(failures, `news-data.json item ${index + 1} summary contains an encoded HTML entity`);
      }
      if (FEED_TRUNCATION_PATTERN.test(article.summary)) {
        fail(failures, `news-data.json item ${index + 1} summary contains a feed truncation artifact`);
      }
      if (/[.,;:!?]+…$/u.test(article.summary.trim())) {
        fail(failures, `news-data.json item ${index + 1} summary has redundant punctuation before a truncation ellipsis`);
      }
    }
  });

  if (!indexHtml) {
    return failures;
  }

  const $ = cheerio.load(indexHtml);
  if ($('a[href="#"]').length > 0) {
    fail(failures, 'index.html contains a hash-only link control');
  }

  $('.news-title').each((index, element) => {
    if (ENCODED_HTML_ENTITY_PATTERN.test($(element).text())) {
      fail(failures, `index.html article title ${index + 1} exposes an encoded HTML entity`);
    }
  });

  $('.summary-disclosure .summary-full').each((index, element) => {
    const remainder = $(element).text().replace(/\s+/g, ' ').trim();
    const wordCount = remainder.split(/\s+/).filter(Boolean).length;
    if (remainder.length < 48 || wordCount < 6 || FEED_TRUNCATION_PATTERN.test(remainder)) {
      fail(failures, `index.html summary disclosure ${index + 1} has no meaningful remainder`);
    }
  });

  $('.news-summary').each((index, element) => {
    if (/[.,;:!?]+…$/u.test($(element).text().trim())) {
      fail(failures, `index.html summary ${index + 1} has redundant punctuation before a truncation ellipsis`);
    }
  });

  const validateHandoffLink = (element, cue, location, expectedHref = HANDOFF_DESTINATION_CONTRACT.destinations[cue]) => {
    const link = $(element);
    if (element.tagName !== 'a') {
      fail(failures, `index.html ${location} ${cue || 'missing'} must be a link`);
      return;
    }
    if (!expectedHref || link.attr('href') !== expectedHref) {
      fail(failures, `index.html ${location} ${cue || 'missing'} must link to its downstream product`);
    }
  };

  $('article.news-item').each((cardIndex, cardElement) => {
    const card = $(cardElement);
    const article = newsData[cardIndex];
    const plainSummary = card.children('p.news-summary').first();
    const continuation = card.find(SUMMARY_CONTINUATION_CONTRACT.selector);
    const summaryIsTruncated = plainSummary.length > 0 && plainSummary.text().trim().endsWith('…');

    if (summaryIsTruncated) {
      if (continuation.length !== 1) {
        fail(failures, `index.html truncated summary ${cardIndex + 1} must have one continuation link`);
      } else if (article && typeof article === 'object') {
        const expectedArticleHref = normalizeGeneratedArticleLink(article.link);
        const actualArticleHref = normalizeGeneratedArticleLink(continuation.attr('href') || '');
        if (actualArticleHref !== expectedArticleHref) {
          fail(failures, `index.html truncated summary ${cardIndex + 1} continuation must link to its article`);
        }
        const expectedAriaLabel = `${SUMMARY_CONTINUATION_CONTRACT.ariaLabelPrefix}${article.source}`;
        if (continuation.attr('aria-label') !== expectedAriaLabel) {
          fail(failures, `index.html truncated summary ${cardIndex + 1} continuation must name its source`);
        }
        if (!continuation.text().trim().startsWith(`${SUMMARY_CONTINUATION_CONTRACT.visibleTextPrefix}${article.source}`)) {
          fail(failures, `index.html truncated summary ${cardIndex + 1} continuation must visibly name its source`);
        }
      }
    } else if (continuation.length > 0) {
      fail(failures, `index.html complete summary ${cardIndex + 1} must not render a continuation link`);
    }

    card.find('.handoff-cue').each((cueIndex, element) => {
      const cue = $(element).text().trim();
      validateHandoffLink(
        element,
        cue,
        `card ${cardIndex + 1} handoff cue ${cueIndex + 1}`,
        getHandoffDestination(cue, article, options.currentInsightCves),
      );
    });
  });
  $('.handoff-cue-legend-chip').each((index, element) => {
    const cue = $(element).find('.handoff-cue-name').first().text().trim();
    validateHandoffLink(element, cue, `legend handoff cue ${index + 1}`);
  });
  const expectedLaneDestinations = new Map(
    collectOperatorLanes(
      newsData.filter((article) => article && typeof article === 'object' && !Array.isArray(article)),
      options.currentInsightCves,
    ).map((lane) => [lane.cue, lane.destination])
  );
  $('.operator-lane-heading').each((index, element) => {
    const cue = $(element).closest('.operator-lane').attr(OPERATOR_LANE_CONTRACT.cueAttribute) || '';
    validateHandoffLink(element, cue, `operator lane ${index + 1}`, expectedLaneDestinations.get(cue));
  });

  $('time[datetime]').each((index, element) => {
    const label = $(element).text().replace(/\s+/g, ' ').trim();
    if (/\b\d{1,2}:\d{2}\b/.test(label) && !/\bUTC\b/.test(label)) {
      fail(failures, `index.html visible timestamp ${index + 1} must include a UTC timezone label`);
    }
  });

  $('a[href="./feed.xml"]').each((index, element) => {
    if (/archive/i.test($(element).text())) {
      fail(failures, `index.html rolling feed link ${index + 1} must not promise an archive`);
    }
  });

  if (/\.toLocaleString\s*\(/.test(indexHtml)) {
    fail(failures, 'index.html must not contain locale-dependent generated timestamp rendering');
  }

  return failures;
}

function validateRollingPermalinks(indexHtml, newsData, failures) {
  const $ = cheerio.load(indexHtml);
  const cards = $('article.news-item');
  cards.each((index, element) => {
    const article = newsData[index];
    if (!article || typeof article.link !== 'string') {
      return;
    }
    let expectedId;
    try {
      expectedId = articleFragment(article.link);
    } catch {
      expectedId = `article-${index}`;
    }
    const card = $(element);
    const permalink = card.find('a.item-permalink');
    if (card.attr('id') !== expectedId) {
      fail(failures, `index.html article ${index + 1} must expose stable id ${expectedId}`);
    }
    if (permalink.length !== 1
        || permalink.attr('href') !== `#${expectedId}`
        || permalink.attr('aria-label') !== 'Permalink to this reporting item'
        || permalink.text().trim() !== 'Permalink'
        || permalink.attr('target')) {
      fail(failures, `index.html article ${index + 1} must expose one same-page reporting permalink`);
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
    insightFindings: path.join(repoRoot, 'sentryinsight-findings.json'),
    insightContext: path.join(repoRoot, 'sentryinsight-context.json'),
    sitemapXml: path.join(repoRoot, 'sitemap.xml'),
  };
  const failures = [];
  const config = readJson('config/news-sources.json', artifacts.config, repoRoot, failures);
  const newsData = readJson('news-data.json', artifacts.newsData, repoRoot, failures);
  const feedInfo = readJson('feed-info.json', artifacts.feedInfo, repoRoot, failures);
  const feedXml = readText('feed.xml', artifacts.feedXml, repoRoot, failures);
  const indexHtml = readText('index.html', artifacts.indexHtml, repoRoot, failures);
  const insightFindings = readJson(
    'sentryinsight-findings.json',
    artifacts.insightFindings,
    repoRoot,
    failures,
  );
  const insightContext = readJson(
    'sentryinsight-context.json',
    artifacts.insightContext,
    repoRoot,
    failures,
  );
  const sitemapXml = readText('sitemap.xml', artifacts.sitemapXml, repoRoot, failures);

  let currentInsightCves = null;
  if (insightFindings) {
    try {
      const manifest = assertCurrentInsightFindings(insightFindings);
      const generatedAt = feedInfo?.lastUpdated || config?.settings?.lastUpdated || new Date(0);
      currentInsightCves = getCurrentInsightCves(manifest, generatedAt);
    } catch (error) {
      fail(failures, `sentryinsight-findings.json is invalid: ${error.message}`);
    }
  }

  validateReaderExperience(
    indexHtml,
    Array.isArray(newsData) ? newsData : [],
    failures,
    { currentInsightCves, insightContext },
  );
  validateInsightContextContract(indexHtml, insightContext, insightFindings, failures);
  validateSiteMetadata(indexHtml, sitemapXml, failures);
  const issueDates = validateDigestArchives(repoRoot, sitemapXml, failures);

  let enabledSources = [];
  let maxNewsItems = DEFAULT_MAX_NEWS_ITEMS;

  if (config) {
    const sourceConfig = validateSourceConfig(config, failures);
    enabledSources = sourceConfig.enabledRssSources;
    maxNewsItems = sourceConfig.maxNewsItems;
  }

  if (newsData) {
    failures.push(
      ...collectNewsDataFailures(newsData, enabledSources, maxNewsItems)
    );
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
      const expectedSources = Array.from(new Set(newsData.map((article) => article?.source).filter(Boolean))).sort();
      const actualSources = [...feedInfo.sources].sort();
      if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
        fail(failures, 'feed-info.json sources must match sources represented in news-data.json');
      }
    }

    const expectedSourceHealth = describeSourceHealth(
      collectSourceHealth(newsData, enabledSources),
      isValidDate(feedInfo.lastUpdated) ? feedInfo.lastUpdated : new Date(0),
    );
    if (!Array.isArray(feedInfo.sourceHealth)) {
      fail(failures, 'feed-info.json sourceHealth must be an array');
    } else if (JSON.stringify(feedInfo.sourceHealth) !== JSON.stringify(expectedSourceHealth)) {
      fail(failures, 'feed-info.json sourceHealth must match configured source contribution history');
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
    validateIssueTrailContract(indexHtml, failures, issueDates, feedInfo?.lastUpdated);
    validateFilterInsightsContract(indexHtml, failures);
    validateDigestLegendContract(indexHtml, newsData, failures);
    validateOperatorLaneContract(indexHtml, newsData, failures, currentInsightCves);
    validateSourceCoverageContract(indexHtml, newsData, enabledSources, failures);

    const articleCount = countMatches(indexHtml, /<article class="news-item"/g);
    if (newsData.length > 0 && articleCount !== newsData.length) {
      fail(failures, `index.html renders ${articleCount} article cards, expected ${newsData.length}`);
    }
    validateRollingPermalinks(indexHtml, newsData, failures);

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
  validateArtifacts,
  validateReaderExperience,
};
