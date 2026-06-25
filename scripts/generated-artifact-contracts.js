const SOURCE_COVERAGE_ANCHOR_ID = 'sourceCoverage';

const DASHBOARD_RSS_LINK_CONTRACT = Object.freeze({
  feedHref: './feed.xml',
  linkSelectors: Object.freeze([
    'link[rel="alternate"][type="application/rss+xml"]',
    'a.btn',
    '.issue-strip a.issue-link',
    '.source-coverage a.feed-link',
    'footer a',
  ]),
});

const ISSUE_TRAIL_CONTRACT = Object.freeze({
  cadenceText: '3h cadence',
  feedHref: DASHBOARD_RSS_LINK_CONTRACT.feedHref,
  navClass: 'issue-trail',
  navSelector: '.issue-trail',
  sourceCoverageAnchorId: SOURCE_COVERAGE_ANCHOR_ID,
  sourceCoverageHref: `#${SOURCE_COVERAGE_ANCHOR_ID}`,
});

const SOURCE_COVERAGE_CONTRACT = Object.freeze({
  activeSourcesAttribute: 'data-active-sources',
  buttonDataAttribute: 'data-source-filter',
  buttonSelector: '[data-source-filter]',
  healthNoteSelector: '.source-health-note',
  healthNoteText: 'health only',
  healthSelector: '.source-health-summary',
  quietSourcesAttribute: 'data-quiet-sources',
  sectionClass: 'source-coverage',
  sectionSelector: '.source-coverage',
  sourceFilterSelector: '#sourceFilter',
  statusSelector: '[data-source-filter-status]',
  statusText: 'Source shortcut: All active feeds',
});

const FEED_METADATA_CONTRACT = Object.freeze({
  issueStripTimeSelector: '.issue-strip time[datetime]',
  issueTrailTimeSelector: `${ISSUE_TRAIL_CONTRACT.navSelector} time[datetime]`,
  maxTimestampDriftMs: 5 * 60 * 1000,
  statsTimeSelector: '#stats time[datetime]',
});

const FEED_INFO_CONTRACT = Object.freeze({
  publicFeedUrl: 'https://ricomanifesto.github.io/SentryDigest/feed.xml',
  title: 'Cybersecurity News Aggregator RSS Feed',
});

const RSS_CHANNEL_CONTRACT = Object.freeze({
  description: 'Latest cybersecurity news from top sources',
  imageUrl: 'https://ricomanifesto.github.io/SentryDigest/icon.png',
  publicFeedUrl: FEED_INFO_CONTRACT.publicFeedUrl,
  publicSiteUrl: 'https://ricomanifesto.github.io/SentryDigest/',
  title: 'Cybersecurity News Aggregator',
});

module.exports = {
  DASHBOARD_RSS_LINK_CONTRACT,
  FEED_INFO_CONTRACT,
  FEED_METADATA_CONTRACT,
  ISSUE_TRAIL_CONTRACT,
  RSS_CHANNEL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
};
