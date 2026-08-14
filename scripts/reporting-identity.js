const crypto = require('node:crypto');

function normalizeArticleUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? '').trim());
  } catch {
    throw new Error('Reporting links must use an absolute http or https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Reporting links must use an absolute http or https URL without credentials');
  }
  parsed.hash = '';
  return parsed.toString();
}

function articleFragment(value) {
  const normalized = normalizeArticleUrl(value);
  return `reporting-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

function articleSourceKey(value) {
  const normalized = normalizeArticleUrl(value);
  return `source-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

module.exports = {
  articleFragment,
  articleSourceKey,
  normalizeArticleUrl,
};
