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

module.exports = {
  ISSUE_TRAIL_CONTRACT,
  SOURCE_COVERAGE_CONTRACT,
};
