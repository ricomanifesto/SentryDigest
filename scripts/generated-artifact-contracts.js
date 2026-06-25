const SOURCE_COVERAGE_ANCHOR_ID = 'sourceCoverage';

const ISSUE_TRAIL_CONTRACT = Object.freeze({
  cadenceText: '3h cadence',
  feedHref: './feed.xml',
  navClass: 'issue-trail',
  navSelector: '.issue-trail',
  sourceCoverageAnchorId: SOURCE_COVERAGE_ANCHOR_ID,
  sourceCoverageHref: `#${SOURCE_COVERAGE_ANCHOR_ID}`,
});

module.exports = {
  ISSUE_TRAIL_CONTRACT,
};
