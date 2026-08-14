const fs = require('node:fs');
const path = require('node:path');

const { articleFragment, normalizeArticleUrl } = require('./reporting-identity');

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

function formatIssueDate(issueDate) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${issueDate}T00:00:00.000Z`));
}

function renderArchivePage(manifest) {
  const issueLabel = formatIssueDate(manifest.issue_date);
  const cards = manifest.articles.map((article) => `
      <article class="reporting-item" id="${escapeHtml(article.id)}">
        <p class="source">${escapeHtml(article.source)} · <time datetime="${escapeHtml(article.date)}">${escapeHtml(article.date.slice(0, 10))}</time></p>
        <h2><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a></h2>
        ${article.summary ? `<p>${escapeHtml(article.summary)}</p>` : ''}
        <a class="permalink" href="#${escapeHtml(article.id)}" aria-label="Link to this reporting item">Permalink</a>
      </article>`).join('');
  const canonical = `${PUBLIC_ROOT}archive/${manifest.issue_date}/`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SentryDigest for ${escapeHtml(issueLabel)}</title>
  <meta name="description" content="Reporting retained by SentryDigest on ${escapeHtml(issueLabel)}.">
  <link rel="canonical" href="${canonical}">
  <style>
    :root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}body{margin:0;background:#f7f8fa;color:#172033}main,header,footer{max-width:900px;margin:auto;padding:1.25rem}.reporting-item{background:#fff;border:1px solid #d9deea;border-radius:12px;margin:1rem 0;padding:1rem;scroll-margin-top:1rem}.source,.permalink{color:#59647a;font-size:.9rem}h1,h2{line-height:1.2}h2{font-size:1.15rem}a{color:#1458c0}@media(prefers-color-scheme:dark){body{background:#0b1020;color:#e5e7eb}.reporting-item{background:#141b2f;border-color:#26304a}.source,.permalink{color:#aeb8cd}a{color:#8bb8ff}}
  </style>
</head>
<body>
  <header>
    <p><a href="../../">SentryDigest</a> · retained daily context</p>
    <h1>Digest for ${escapeHtml(issueLabel)}</h1>
    <p>${manifest.articles.length} reporting item${manifest.articles.length === 1 ? '' : 's'} retained from the rolling digest on this UTC day.</p>
  </header>
  <main>${cards}</main>
  <footer><p>Original publisher links are preserved for traceability. <a href="index.json">Machine-readable issue data</a>.</p></footer>
</body>
</html>
`;
}

function loadExistingManifest(manifestPath, issueDate) {
  if (!fs.existsSync(manifestPath)) {
    return { schema_version: 1, issue_date: issueDate, generated_at: '', articles: [] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.issue_date !== issueDate || !Array.isArray(manifest.articles)) {
    throw new Error(`Existing digest archive ${issueDate} does not satisfy schema version 1`);
  }
  return manifest;
}

function writeSitemap(outputRoot) {
  const archiveRoot = path.join(outputRoot, 'archive');
  const issueDates = fs.existsSync(archiveRoot)
    ? fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    : [];
  const urls = [PUBLIC_ROOT, ...issueDates.map((date) => `${PUBLIC_ROOT}archive/${date}/`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url>\n    <loc>${escapeHtml(url)}</loc>\n    <changefreq>daily</changefreq>\n  </url>`).join('\n')}\n</urlset>\n`;
  fs.writeFileSync(path.join(outputRoot, 'sitemap.xml'), xml);
}

function writeDigestArchive({ newsItems, outputRoot, generatedAt }) {
  if (!Array.isArray(newsItems)) {
    throw new Error('Digest archive input must be an array');
  }
  const generated = new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) {
    throw new Error('Digest archive generatedAt must be a valid timestamp');
  }
  const issueDate = generated.toISOString().slice(0, 10);
  const issueRoot = path.join(outputRoot, 'archive', issueDate);
  const manifestPath = path.join(issueRoot, 'index.json');
  fs.mkdirSync(issueRoot, { recursive: true });
  const previous = loadExistingManifest(manifestPath, issueDate);
  const byLink = new Map(previous.articles.map((article) => [normalizeArticleUrl(article.link), validateArticle(article, 0)]));
  newsItems.map(validateArticle).forEach((article) => byLink.set(article.link, article));
  const articles = Array.from(byLink.values()).sort((left, right) => (
    right.date.localeCompare(left.date) || left.link.localeCompare(right.link)
  ));
  const manifest = {
    schema_version: 1,
    issue_date: issueDate,
    generated_at: generated.toISOString(),
    articles,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(issueRoot, 'index.html'), renderArchivePage(manifest));
  writeSitemap(outputRoot);
  return { issueDate, issueRoot, articleCount: articles.length };
}

function main() {
  const outputRoot = path.resolve(__dirname, '..');
  const newsItems = JSON.parse(fs.readFileSync(path.join(outputRoot, 'news-data.json'), 'utf8'));
  const feedInfo = JSON.parse(fs.readFileSync(path.join(outputRoot, 'feed-info.json'), 'utf8'));
  const result = writeDigestArchive({
    newsItems,
    outputRoot,
    generatedAt: new Date(feedInfo.lastUpdated),
  });
  const { generateHTML } = require('./render-news-html');
  fs.writeFileSync(
    path.join(outputRoot, 'index.html'),
    generateHTML(newsItems, {
      generatedAt: new Date(feedInfo.lastUpdated),
      sourceHealth: feedInfo.sourceHealth,
    }),
  );
  console.log(`Generated dated digest archive ${result.issueDate} with ${result.articleCount} items`);
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
  normalizeArticleUrl,
  renderArchivePage,
  writeDigestArchive,
};
