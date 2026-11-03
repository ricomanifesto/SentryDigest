// digest_content_digest: the semantic identity of a digest's article content.
//
// Each article becomes the canonical archive record {id, link, title, date,
// source, summary} (normalized link, trimmed text, ISO-8601 UTC date, id from
// the link), serialized as JSON with sorted keys and no insignificant
// whitespace. Records are sorted bytewise, joined by newlines and hashed with
// SHA-256. firstSeen, feed metadata, timestamps, origins and hosting files are
// excluded by construction, so only an article content change alters it.
const crypto = require('node:crypto');

const { canonicalArchiveArticle } = require('./digest-archive');

function canonicalRecord(article, index) {
  const { id, link, title, date, source, summary } = canonicalArchiveArticle(article, index);
  return JSON.stringify({ date, id, link, source, summary, title });
}

function digestContentDigest(newsData) {
  if (!Array.isArray(newsData)) throw new Error('news-data.json must be an array of articles');
  const records = newsData.map(canonicalRecord).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return crypto.createHash('sha256').update(records.join('\n')).digest('hex');
}

module.exports = { digestContentDigest };
