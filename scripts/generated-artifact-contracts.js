const SOURCE_COVERAGE_ANCHOR_ID = 'sourceCoverage';

const DIGEST_LEGEND_CONTRACT = Object.freeze({
  handoffCueDetails: Object.freeze({
    'SentryInsight: incident watch': 'Potential incident or compromise follow-up',
    'SentryInsight: vuln triage': 'Vulnerability or exploitation review',
    'SentryInsight: vendor watch': 'Vendor or product-owner tracking',
    'GRCInsight: governance watch': 'Regulatory, privacy, or audit relevance',
    'SentryInsight: monitor': 'Low-signal item worth monitoring',
  }),
  handoffCueDetailSelector: '.handoff-cue-detail',
  handoffCueGroupSelector: '.handoff-cue-legend',
  handoffCueNameSelector: '.handoff-cue-name',
  handoffCueSelector: '.handoff-cue-legend-chip',
  selector: '.digest-legend',
  sourceSignalDetails: Object.freeze({
    'Vendor advisory': 'Vendor or product-owner guidance',
    'Research team': 'Threat research or lab analysis',
    'Industry media': 'Security news reporting',
    'General source': 'Monitor for added context',
  }),
  sourceSignalDetailSelector: '.source-signal-detail',
  sourceSignalGroupSelector: '.source-signal-legend',
  sourceSignalNameSelector: '.source-signal-name',
  sourceSignalSelector: '.source-signal-chip',
});

const DASHBOARD_RSS_LINK_CONTRACT = Object.freeze({
  feedHref: './feed.xml',
  linkLabels: Object.freeze({
    'a.btn': 'Open generated RSS feed',
    '.issue-strip a.issue-link': 'Open generated RSS archive',
    'footer a': 'Open generated RSS feed',
  }),
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

const OPERATOR_LANE_CONTRACT = Object.freeze({
  countSelector: '[data-lane-count]',
  cueAttribute: 'data-lane-cue',
  headingSelector: '.operator-lane-heading',
  labelAttribute: 'data-lane',
  lanes: Object.freeze([
    Object.freeze({
      cue: 'SentryInsight: incident watch',
      label: 'Incident watch',
    }),
    Object.freeze({
      cue: 'SentryInsight: vuln triage',
      label: 'Vulnerability triage',
    }),
    Object.freeze({
      cue: 'GRCInsight: governance watch',
      label: 'Governance watch',
    }),
  ]),
  laneSelector: '.operator-lane',
  latestLinkSelector: '[data-lane-link]',
  sectionSelector: '.operator-lanes',
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
  statusAllSourcesText: 'Source shortcut: All active feeds',
  statusSelector: '[data-source-filter-status]',
  statusTextPrefix: 'Source shortcut: ',
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

function formatSourceShortcutStatus(label, count, options = {}) {
  const articleLabel = options.filtered
    ? (count === 1 ? 'filtered article' : 'filtered articles')
    : (count === 1 ? 'article' : 'articles');
  return `${label} (${count} ${articleLabel})`;
}

module.exports = {
  DASHBOARD_RSS_LINK_CONTRACT,
  DIGEST_LEGEND_CONTRACT,
  FEED_INFO_CONTRACT,
  FEED_METADATA_CONTRACT,
  formatSourceShortcutStatus,
  ISSUE_TRAIL_CONTRACT,
  OPERATOR_LANE_CONTRACT,
  RSS_CHANNEL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
};
