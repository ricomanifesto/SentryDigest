const fs = require('node:fs');
const path = require('node:path');
const { isVirtualEventPromotion } = require('./feed-content-policy');
const { assertNewsDataContract } = require('./news-data-contract');
const { assertSourceConfigContract } = require('./source-config-contract');
const { newestContributionTimestamp, normalizeContributionTimestamp } = require('./source-health');
const { listDigestIssueDates, renderArchiveIndex, renderArchivePage } = require('./digest-archive');
const { generateRSSFeed } = require('./generate-rss');
const { generateHTML } = require('./render-news-html');
const { getCurrentInsightCves, loadCurrentInsightFindings } = require('./current-insight-findings');
const { loadInsightSyncContext } = require('./insight-sync-context');
const { validateArtifacts } = require('./validate-artifacts');

function cleanVirtualEventArtifacts({ outputRoot = path.resolve(__dirname, '..') } = {}) {
  const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(outputRoot, relative), 'utf8'));
  const config = readJson('config/news-sources.json');
  const { enabledRssSources, maxNewsItems } = assertSourceConfigContract(config);
  const previousNews = readJson('news-data.json');
  if (!Array.isArray(previousNews)) throw new Error('news-data.json must be an array');
  const news = previousNews.filter((article) => !isVirtualEventPromotion(article));
  assertNewsDataContract(news, enabledRssSources, maxNewsItems);
  const removed = previousNews.filter(isVirtualEventPromotion);
  const retained = [...news];
  const issueDates = listDigestIssueDates(outputRoot);
  const archiveChanges = [];
  const issues = issueDates.map((issueDate) => {
    const relative = `archive/${issueDate}/index.json`;
    const manifest = readJson(relative);
    const articles = manifest.articles.filter((article) => !isVirtualEventPromotion(article));
    const excluded = manifest.articles.filter(isVirtualEventPromotion);
    if (excluded.length && articles.length === 0) {
      throw new Error(`archive/${issueDate} has no publishable articles; preserve a non-empty issue`);
    }
    retained.push(...articles);
    removed.push(...excluded);
    if (excluded.length) {
      archiveChanges.push({ relative, manifest: { ...manifest, articles }, removed: excluded.length });
    }
    return { issue_date: issueDate, article_count: articles.length };
  });

  // Only repair history proven to reference excluded records, using retained evidence.
  for (const source of config.sources) {
    const previousTimestamp = normalizeContributionTimestamp(source.lastContributedAt);
    if (previousTimestamp && removed.some((article) => article.source === source.name
        && normalizeContributionTimestamp(article.date) === previousTimestamp)) {
      source.lastContributedAt = newestContributionTimestamp(
        retained.filter((article) => article.source === source.name).map((article) => article.date),
      );
    }
  }

  const result = {
    removedCurrent: previousNews.length - news.length,
    currentCount: news.length,
    archives: archiveChanges.map(({ manifest, removed: count }) => ({
      issueDate: manifest.issue_date, removed: count, remaining: manifest.articles.length,
    })),
    changedFiles: [],
  };
  if (!removed.length) {
    const validation = validateArtifacts(outputRoot);
    if (!validation.valid) throw new Error(validation.failures.join('; '));
    return result;
  }

  const files = [
    'news-data.json', 'index.html', 'feed.xml', 'feed-info.json', 'config/news-sources.json',
    'sitemap.xml', 'sentryinsight-context.json', 'sentryinsight-findings.json', 'archive/index.html',
    ...issueDates.flatMap((date) => [`archive/${date}/index.json`, `archive/${date}/index.html`]),
  ];
  const original = new Map(files.map((file) => [file, fs.readFileSync(path.join(outputRoot, file))]));
  const stage = fs.mkdtempSync(path.join(outputRoot, '.virtual-event-cleanup-'));
  try {
    for (const [file, contents] of original) {
      fs.mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
      fs.writeFileSync(path.join(stage, file), contents);
    }
    fs.writeFileSync(path.join(stage, 'news-data.json'), JSON.stringify(news, null, 2));
    fs.writeFileSync(path.join(stage, 'config/news-sources.json'), JSON.stringify(config, null, 2));
    for (const { relative, manifest } of archiveChanges) {
      fs.writeFileSync(path.join(stage, relative), `${JSON.stringify(manifest, null, 2)}\n`);
      fs.writeFileSync(path.join(stage, path.dirname(relative), 'index.html'), renderArchivePage(manifest));
    }
    fs.writeFileSync(path.join(stage, 'archive/index.html'), renderArchiveIndex(issues));
    const feedInfo = readJson('feed-info.json');
    const generatedAt = new Date(feedInfo.lastUpdated);
    const rss = generateRSSFeed({
      newsDataPath: path.join(stage, 'news-data.json'),
      configPath: path.join(stage, 'config/news-sources.json'),
      rssOutputPath: path.join(stage, 'feed.xml'),
      feedInfoPath: path.join(stage, 'feed-info.json'),
      now: new Date(feedInfo.lastUpdated),
      logger: { log() {} },
    });
    fs.writeFileSync(path.join(stage, 'index.html'), generateHTML(news, {
      generatedAt,
      currentInsightCves: getCurrentInsightCves(
        loadCurrentInsightFindings(path.join(stage, 'sentryinsight-findings.json')), generatedAt,
      ),
      insightContext: loadInsightSyncContext(path.join(stage, 'sentryinsight-context.json')),
      retainedIssueDates: issueDates,
      sourceHealth: rss.feedInfo.sourceHealth,
    }));
    const validation = validateArtifacts(stage);
    if (!validation.valid) throw new Error(validation.failures.join('; '));

    const changes = files.filter((file) => !fs.readFileSync(path.join(stage, file)).equals(original.get(file)));
    // Detect concurrent artifact edits before replacing any validated staged output.
    for (const [file, contents] of original) {
      if (!fs.readFileSync(path.join(outputRoot, file)).equals(contents)) {
        throw new Error(`Artifact changed during cleanup: ${file}`);
      }
    }
    for (const file of changes) fs.renameSync(path.join(stage, file), path.join(outputRoot, file));
    result.changedFiles = changes;
    return result;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(cleanVirtualEventArtifacts(), null, 2));
  } catch (error) {
    console.error(`Artifact cleanup aborted: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { cleanVirtualEventArtifacts };
