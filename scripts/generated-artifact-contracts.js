const SOURCE_COVERAGE_ANCHOR_ID = 'sourceCoverage';

const ISSUE_TRAIL_CONTRACT = Object.freeze({
  cadenceText: '3h cadence',
  feedHref: './feed.xml',
  navClass: 'issue-trail',
  navSelector: '.issue-trail',
  sourceCoverageAnchorId: SOURCE_COVERAGE_ANCHOR_ID,
  sourceCoverageHref: `#${SOURCE_COVERAGE_ANCHOR_ID}`,
});

const SOURCE_COVERAGE_CONTRACT = Object.freeze({
  buttonDataAttribute: 'data-source-filter',
  buttonSelector: '[data-source-filter]',
  sectionClass: 'source-coverage',
  sectionSelector: '.source-coverage',
  sourceFilterSelector: '#sourceFilter',
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

module.exports = {
  FEED_INFO_CONTRACT,
  FEED_METADATA_CONTRACT,
  ISSUE_TRAIL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
};
