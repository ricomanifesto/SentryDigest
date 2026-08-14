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

const HANDOFF_DESTINATION_CONTRACT = Object.freeze({
  cveContextCue: 'SentryInsight: incident watch',
  cveFragmentPattern: '#cve-YYYY-NNNN',
  destinations: Object.freeze({
    'SentryInsight: incident watch': 'https://ricomanifesto.github.io/SentryInsight/',
    'SentryInsight: vuln triage': 'https://ricomanifesto.github.io/SentryInsight/',
    'SentryInsight: vendor watch': 'https://ricomanifesto.github.io/SentryInsight/',
    'GRCInsight: governance watch': 'https://ricomanifesto.github.io/GRCInsight/',
    'SentryInsight: monitor': 'https://ricomanifesto.github.io/SentryInsight/',
  }),
  cardLinkSelector: 'a.handoff-cue',
  laneLinkSelector: 'a[data-lane-destination]',
  legendLinkSelector: 'a.handoff-cue-legend-chip',
});

const DASHBOARD_RSS_LINK_CONTRACT = Object.freeze({
  feedHref: './feed.xml',
  linkLabels: Object.freeze({
    'a.btn': 'Open generated RSS feed',
    '.issue-strip a.issue-link': 'Open rolling RSS feed',
    'footer a[data-rss-link]': 'Open generated RSS feed',
  }),
  linkSelectors: Object.freeze([
    'link[rel="alternate"][type="application/rss+xml"]',
    'a.btn',
    '.issue-strip a.issue-link',
    '.source-coverage a.feed-link',
    'footer a[data-rss-link]',
  ]),
});

const ISSUE_TRAIL_CONTRACT = Object.freeze({
  archiveHref: './archive/',
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
  healthSelector: '.source-health-summary',
  healthStatusAttribute: 'data-health-status',
  quietSourceAttribute: 'data-source-name',
  quietSourceLastContributedAttribute: 'data-last-contributed-at',
  quietSourceDaysAttribute: 'data-quiet-for-days',
  quietSourceSelector: '.source-health-note',
  quietSourcesAttribute: 'data-quiet-sources',
  sectionClass: 'source-coverage',
  sectionSelector: '.source-coverage',
  sourceFilterSelector: '#sourceFilter',
  statusAllSourcesText: 'All contributing feeds',
  statusSelector: '[data-source-filter-status]',
  statusTextPrefix: 'Source filter: ',
});

const SUMMARY_CONTINUATION_CONTRACT = Object.freeze({
  ariaLabelPrefix: 'Continue reading at ',
  selector: 'a.summary-continuation',
  visibleTextPrefix: 'Continues at ',
});

const FEED_METADATA_CONTRACT = Object.freeze({
  issueStripTimeSelector: '.issue-strip time[datetime]',
  issueTrailTimeSelector: `${ISSUE_TRAIL_CONTRACT.navSelector} .issue-trail-meta time[datetime]`,
  maxTimestampDriftMs: 5 * 60 * 1000,
});

const FEED_INFO_CONTRACT = Object.freeze({
  publicFeedUrl: 'https://ricomanifesto.github.io/SentryDigest/feed.xml',
  title: 'SentryDigest RSS Feed',
});

const RSS_CHANNEL_CONTRACT = Object.freeze({
  description: 'A fresh, scannable cybersecurity brief from trusted sources',
  imageUrl: 'https://ricomanifesto.github.io/SentryDigest/assets/icon-512.png',
  publicFeedUrl: FEED_INFO_CONTRACT.publicFeedUrl,
  publicSiteUrl: 'https://ricomanifesto.github.io/SentryDigest/',
  title: 'SentryDigest',
});

const SITE_METADATA_CONTRACT = Object.freeze({
  authorName: 'Michael Rico',
  authorUrl: 'https://ricomanifesto.com/',
  description: RSS_CHANNEL_CONTRACT.description,
  githubUrl: 'https://github.com/ricomanifesto/SentryDigest',
  imageUrl: 'https://ricomanifesto.github.io/SentryDigest/assets/social-preview.png',
  publicSiteUrl: RSS_CHANNEL_CONTRACT.publicSiteUrl,
  title: 'SentryDigest | Cybersecurity News',
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
  HANDOFF_DESTINATION_CONTRACT,
  ISSUE_TRAIL_CONTRACT,
  OPERATOR_LANE_CONTRACT,
  RSS_CHANNEL_CONTRACT,
  SITE_METADATA_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
  SUMMARY_CONTINUATION_CONTRACT,
};
