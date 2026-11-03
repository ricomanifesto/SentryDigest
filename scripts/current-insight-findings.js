const fs = require('node:fs');

const { acceptedOrigins, emittedOrigin } = require('./public-site');

const CURRENT_FINDINGS_SCHEMA_VERSION = 1;
// The emitted SentryInsight origin is where findings are fetched and linked;
// either configured origin is an accepted report_url during the transition.
const INSIGHT_REPORT_URL = emittedOrigin('SentryInsight');
const INSIGHT_REPORT_URLS = Object.freeze(acceptedOrigins('SentryInsight'));
const CURRENT_FINDINGS_URL = `${INSIGHT_REPORT_URL}current-findings.json`;
const MAX_REPORT_AGE_DAYS = 2;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CVE_PATTERN = /^CVE-\d{4}-\d{4,}$/;

function assertCurrentInsightFindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Current SentryInsight findings must be a JSON object');
  }

  const expectedKeys = [
    'complete_cve_count',
    'cve_ids',
    'finding_count',
    'generated_at',
    'report_date',
    'report_url',
    'schema_version',
  ];
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('Current SentryInsight findings has an unexpected shape');
  }
  if (value.schema_version !== CURRENT_FINDINGS_SCHEMA_VERSION) {
    throw new Error('Current SentryInsight findings must satisfy schema version 1');
  }
  const parsedReportDate = new Date(`${value.report_date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.report_date)
      || Number.isNaN(parsedReportDate.getTime())
      || parsedReportDate.toISOString().slice(0, 10) !== value.report_date) {
    throw new Error('Current SentryInsight findings report_date must be a UTC date');
  }
  if (typeof value.generated_at !== 'string'
      || !value.generated_at.endsWith('Z')
      || Number.isNaN(Date.parse(value.generated_at))) {
    throw new Error('Current SentryInsight findings generated_at must be a UTC timestamp');
  }
  if (!INSIGHT_REPORT_URLS.includes(value.report_url)) {
    throw new Error('Current SentryInsight findings report_url must use the canonical report');
  }
  if (!Number.isInteger(value.finding_count) || value.finding_count < 1) {
    throw new Error('Current SentryInsight findings finding_count must be positive');
  }
  if (!Number.isInteger(value.complete_cve_count) || value.complete_cve_count < 0) {
    throw new Error('Current SentryInsight findings complete_cve_count must be non-negative');
  }
  if (!Array.isArray(value.cve_ids)
      || value.cve_ids.some((cve) => typeof cve !== 'string' || !CVE_PATTERN.test(cve))
      || new Set(value.cve_ids).size !== value.cve_ids.length
      || value.cve_ids.length !== value.complete_cve_count) {
    throw new Error('Current SentryInsight findings cve_ids must be unique complete CVE IDs matching the count');
  }

  return value;
}

function getCurrentInsightCves(value, generatedAt = new Date()) {
  const manifest = assertCurrentInsightFindings(value);
  const generatedDate = new Date(generatedAt);
  if (Number.isNaN(generatedDate.getTime())) {
    throw new Error('Digest generatedAt must be a valid timestamp');
  }
  if (Date.parse(manifest.generated_at) > generatedDate.getTime() + MAX_CLOCK_SKEW_MS) {
    return null;
  }

  const reportDay = Date.parse(`${manifest.report_date}T00:00:00Z`);
  const digestDay = Date.UTC(
    generatedDate.getUTCFullYear(),
    generatedDate.getUTCMonth(),
    generatedDate.getUTCDate(),
  );
  const ageDays = Math.floor((digestDay - reportDay) / (24 * 60 * 60 * 1000));
  if (ageDays < 0 || ageDays > MAX_REPORT_AGE_DAYS) {
    return null;
  }
  return new Set(manifest.cve_ids);
}

function loadCurrentInsightFindings(filePath) {
  return assertCurrentInsightFindings(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

module.exports = {
  assertCurrentInsightFindings,
  CURRENT_FINDINGS_URL,
  getCurrentInsightCves,
  INSIGHT_REPORT_URL,
  INSIGHT_REPORT_URLS,
  loadCurrentInsightFindings,
};
