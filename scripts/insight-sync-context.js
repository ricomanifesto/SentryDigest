const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const MODES = new Set(['current', 'retained', 'stale', 'unavailable']);

function isUtcTimestamp(value) {
  return typeof value === 'string'
    && value.endsWith('Z')
    && Number.isFinite(Date.parse(value));
}

function assertInsightSyncContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SentryInsight sync context must be a JSON object');
  }
  const expectedKeys = [
    'checked_at',
    'manifest_generated_at',
    'mode',
    'report_date',
    'schema_version',
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('SentryInsight sync context has an unexpected shape');
  }
  if (value.schema_version !== SCHEMA_VERSION || !MODES.has(value.mode)) {
    throw new Error('SentryInsight sync context must use schema version 1 and a known mode');
  }
  if (!isUtcTimestamp(value.checked_at)) {
    throw new Error('SentryInsight sync context checked_at must be a UTC timestamp');
  }
  const hasSnapshot = value.mode !== 'unavailable';
  if (hasSnapshot) {
    if (!isUtcTimestamp(value.manifest_generated_at)
        || typeof value.report_date !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(value.report_date)) {
      throw new Error('SentryInsight sync context snapshot provenance is invalid');
    }
  } else if (value.manifest_generated_at !== null || value.report_date !== null) {
    throw new Error('Unavailable SentryInsight sync context cannot claim snapshot provenance');
  }
  return value;
}

function createInsightSyncContext({ mode, checkedAt, manifest = null }) {
  return assertInsightSyncContext({
    schema_version: SCHEMA_VERSION,
    mode,
    checked_at: new Date(checkedAt).toISOString(),
    report_date: manifest?.report_date ?? null,
    manifest_generated_at: manifest?.generated_at ?? null,
  });
}

function loadInsightSyncContext(filePath) {
  return assertInsightSyncContext(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeInsightSyncContext(filePath, context) {
  const validated = assertInsightSyncContext(context);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
  return validated;
}

module.exports = {
  assertInsightSyncContext,
  createInsightSyncContext,
  loadInsightSyncContext,
  writeInsightSyncContext,
};
