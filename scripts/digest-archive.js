const fs = require('node:fs');
const path = require('node:path');

const { articleFragment, normalizeArticleUrl } = require('./reporting-identity');
const { assertInsightSyncContext, loadInsightSyncContext } = require('./insight-sync-context');
const { generateHTML } = require('./render-news-html');
const { assertNoVirtualEventPromotions } = require('./feed-content-policy');

const PUBLIC_ROOT = 'https://ricomanifesto.github.io/SentryDigest/';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateArticle(article, index) {
  assertNoVirtualEventPromotions([article]);
  const label = `Digest article ${index + 1}`;
  for (const field of ['title', 'source', 'link', 'date']) {
    if (!String(article?.[field] ?? '').trim()) {
      throw new Error(`${label} is missing ${field}`);
    }
  }
  const date = new Date(article.date);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} has an invalid date`);
  }
  const link = normalizeArticleUrl(article.link);
  return {
    id: articleFragment(link),
    title: String(article.title).trim(),
    link,
    date: date.toISOString(),
    source: String(article.source).trim(),
    summary: String(article.summary ?? '').trim(),
    firstSeen: article.firstSeen ? new Date(article.firstSeen).toISOString() : undefined,
  };
}

function listDigestIssueDates(outputRoot) {
  const archiveRoot = path.join(outputRoot, 'archive');
  return fs.existsSync(archiveRoot)
    ? fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    : [];
}

function renderArchiveIndex(issues) {
  return generateHTML([], { view: { kind: 'archive', issues } });
}

function writeArchiveIndex(outputRoot) {
  const issueDates = listDigestIssueDates(outputRoot);
  const issues = issueDates.map((issueDate) => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(outputRoot, 'archive', issueDate, 'index.json'),
      'utf8',
    ));
    return { issue_date: issueDate, article_count: manifest.articles.length };
  });
  fs.writeFileSync(path.join(outputRoot, 'archive', 'index.html'), renderArchiveIndex(issues));
  return issueDates;
}

function renderArchivePage(manifest, retainedIssueDates = []) {
  const insightContext = manifest.schema_version >= 2
    ? assertInsightSyncContext(manifest.insight_context)
    : undefined;
  return generateHTML(manifest.articles, {
    generatedAt: new Date(manifest.generated_at),
    insightContext,
    retainedIssueDates,
    // Historical context stamps do not contain a verified current finding set.
    currentInsightCves: null,
    view: { kind: 'issue', issueDate: manifest.issue_date },
  });
}

// Refresh presentation only. Retained manifests remain the source of truth.
function refreshArchivePresentation(outputRoot) {
  const issueDates = listDigestIssueDates(outputRoot);
  for (const issueDate of issueDates) {
    const issueRoot = path.join(outputRoot, 'archive', issueDate);
    const manifest = loadExistingManifest(path.join(issueRoot, 'index.json'), issueDate);
    fs.writeFileSync(path.join(issueRoot, 'index.html'), renderArchivePage(manifest, issueDates));
  }
  if (issueDates.length > 0) writeArchiveIndex(outputRoot);
  return issueDates;
}

function loadExistingManifest(manifestPath, issueDate) {
  if (!fs.existsSync(manifestPath)) {
    return { schema_version: 1, issue_date: issueDate, generated_at: '', articles: [] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (![1, 2].includes(manifest.schema_version)
      || manifest.issue_date !== issueDate
      || !Array.isArray(manifest.articles)) {
    throw new Error(`Existing digest archive ${issueDate} does not satisfy a supported schema version`);
  }
  if (manifest.schema_version === 2) {
    assertInsightSyncContext(manifest.insight_context);
  }
  return manifest;
}

function writeSitemap(outputRoot) {
  const issueDates = listDigestIssueDates(outputRoot);
  const urls = [PUBLIC_ROOT, ...issueDates.map((date) => `${PUBLIC_ROOT}archive/${date}/`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url>\n    <loc>${escapeHtml(url)}</loc>\n    <changefreq>daily</changefreq>\n  </url>`).join('\n')}\n</urlset>\n`;
  fs.writeFileSync(path.join(outputRoot, 'sitemap.xml'), xml);
}

function writeDigestArchive({ newsItems, outputRoot, generatedAt, insightContext }) {
  if (!Array.isArray(newsItems)) {
    throw new Error('Digest archive input must be an array');
  }
  if (newsItems.length === 0) {
    throw new Error('Digest archive input must be a non-empty array');
  }
  const generated = new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) {
    throw new Error('Digest archive generatedAt must be a valid timestamp');
  }
  const validatedInsightContext = assertInsightSyncContext(insightContext);
  const issueDate = generated.toISOString().slice(0, 10);
  const issueRoot = path.join(outputRoot, 'archive', issueDate);
  const manifestPath = path.join(issueRoot, 'index.json');
  const previous = loadExistingManifest(manifestPath, issueDate);
  const byLink = new Map(previous.articles.map((article) => [normalizeArticleUrl(article.link), validateArticle(article, 0)]));
  newsItems.map(validateArticle).forEach((article) => byLink.set(article.link, article));
  const articles = Array.from(byLink.values()).sort((left, right) => (
    right.date.localeCompare(left.date) || left.link.localeCompare(right.link)
  ));
  const manifest = {
    schema_version: 2,
    issue_date: issueDate,
    generated_at: generated.toISOString(),
    insight_context: validatedInsightContext,
    articles,
  };
  fs.mkdirSync(issueRoot, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const issueDates = refreshArchivePresentation(outputRoot);
  writeSitemap(outputRoot);
  return { issueDate, issueRoot, issueDates, articleCount: articles.length };
}

function main() {
  const outputRoot = path.resolve(__dirname, '..');
  const newsItems = JSON.parse(fs.readFileSync(path.join(outputRoot, 'news-data.json'), 'utf8'));
  const feedInfo = JSON.parse(fs.readFileSync(path.join(outputRoot, 'feed-info.json'), 'utf8'));
  const insightSnapshotPath = path.join(outputRoot, 'sentryinsight-findings.json');
  const insightContextPath = path.join(outputRoot, 'sentryinsight-context.json');
  const insightContext = loadInsightSyncContext(insightContextPath);
  const result = process.argv.includes('--presentation-only') ? {
    issueDates: refreshArchivePresentation(outputRoot),
  } : writeDigestArchive({
    newsItems,
    outputRoot,
    generatedAt: new Date(feedInfo.lastUpdated),
    insightContext,
  });
  const { generateHTML } = require('./render-news-html');
  const {
    getCurrentInsightCves,
    loadCurrentInsightFindings,
  } = require('./current-insight-findings');
  const generatedAt = new Date(feedInfo.lastUpdated);
  fs.writeFileSync(
    path.join(outputRoot, 'index.html'),
    generateHTML(newsItems, {
      currentInsightCves: fs.existsSync(insightSnapshotPath)
        ? getCurrentInsightCves(loadCurrentInsightFindings(insightSnapshotPath), generatedAt)
        : null,
      generatedAt,
      insightContext,
      retainedIssueDates: result.issueDates,
      sourceHealth: feedInfo.sourceHealth,
    }),
  );
  console.log(`Rendered reader and ${result.issueDates.length} retained issues`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error generating digest archive: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  articleFragment,
  listDigestIssueDates,
  normalizeArticleUrl,
  renderArchiveIndex,
  renderArchivePage,
  refreshArchivePresentation,
  writeDigestArchive,
};
