// Acceptance for a built static artifact. Not part of `npm test`: it needs a
// store produced by scripts/build-static-artifact.js and the pinned source.
//   STATIC_ARTIFACT_STORE=<store> STATIC_ARTIFACT_SOURCE=<repo> node --test tests/static-artifact/*.test.js
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const cheerio = require('cheerio');

const { readCurrentBuild } = require('../../scripts/build-static-artifact');
const { createArtifactServer } = require('../../scripts/serve-static-artifact');
const { validateArtifacts } = require('../../scripts/validate-artifacts');

const PUBLIC_ROOT = 'https://ricomanifesto.github.io/SentryDigest/';
const STORE = process.env.STATIC_ARTIFACT_STORE;
const SOURCE = process.env.STATIC_ARTIFACT_SOURCE;
const PUBLISHED_FILES = new Set([
  'LICENSE',
  'archive/index.html',
  'config/news-sources.json',
  'contracts/reporting-identity-v1.json',
  'feed-info.json',
  'feed.xml',
  'index.html',
  'news-data.json',
  'sentryinsight-context.json',
  'sentryinsight-findings.json',
  'site.webmanifest',
  'sitemap.xml',
]);
const CONTENT_TYPES = {
  '': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const NEGATIVE_ROUTES = [
  '/scripts/validate-artifacts.js',
  '/package.json',
  '/package-lock.json',
  '/playwright.config.js',
  '/README.md',
  '/contracts/README.md',
  '/contracts/reporting-identity-verifier-v1.py',
  '/test-results/',
  '/test-results/cadence.html',
  '/.git/HEAD',
  '/.github/workflows/update-news.yml',
  '/node_modules/',
  '/AGENTS.md',
  '/.env',
  '/src/',
  '/agent/',
  '/../package.json',
  '/assets/..%2f..%2fpackage.json',
  '/assets/',
  '/archive/2026-01-01/',
];

const skip = !STORE || !SOURCE ? 'STATIC_ARTIFACT_STORE and STATIC_ARTIFACT_SOURCE are required' : false;

function trackedFiles(revision) {
  return childProcess.execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', revision], {
    cwd: SOURCE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

function isPublished(relativePath) {
  return PUBLISHED_FILES.has(relativePath)
    || /^archive\/\d{4}-\d{2}-\d{2}\/index\.(html|json)$/.test(relativePath)
    || relativePath.startsWith('assets/');
}

function pinnedBytes(revision, relativePath) {
  return childProcess.execFileSync('git', ['cat-file', 'blob', `${revision}:${relativePath}`], {
    cwd: SOURCE,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      assert.ok(entry.isDirectory() || entry.isFile(), `${entryPath} must be a file or directory`);
      if (entry.isDirectory()) visit(entryPath);
      else files.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  };
  visit(root);
  return files.sort();
}

function get(baseUrl, route) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${route}`, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('static artifact acceptance', { skip }, async (t) => {
  const current = readCurrentBuild(STORE);
  const artifactDir = current.artifactDir;
  const revision = current.sourceRevision;
  const expected = trackedFiles(revision).filter(isPublished).sort();
  const datedIssues = expected
    .map((file) => file.match(/^archive\/(\d{4}-\d{2}-\d{2})\/index\.json$/)?.[1])
    .filter(Boolean)
    .sort();

  const server = createArtifactServer({
    root: artifactDir,
    site: 'SentryDigest',
    inventoryDigest: current.inventoryDigest,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  await t.test('inventory equals the tracked allowlist and every byte equals the pinned blob', () => {
    assert.deepEqual(listFiles(artifactDir), expected);
    for (const relativePath of expected) {
      assert.ok(fs.readFileSync(path.join(artifactDir, relativePath)).equals(pinnedBytes(revision, relativePath)), relativePath);
    }
  });

  await t.test('the existing artifact validator accepts the artifact as its root', () => {
    const result = validateArtifacts(artifactDir);
    assert.deepEqual(result.failures, []);
    assert.equal(result.valid, true);
  });

  await t.test('every artifact file is served with its bytes and content type', async () => {
    for (const relativePath of expected) {
      const response = await get(baseUrl, `/${relativePath}`);
      assert.equal(response.status, 200, relativePath);
      assert.ok(response.body.equals(fs.readFileSync(path.join(artifactDir, relativePath))), relativePath);
      assert.equal(response.headers['content-type'], CONTENT_TYPES[path.extname(relativePath)], relativePath);
      assert.equal(response.headers['x-static-artifact'], `SentryDigest ${current.inventoryDigest}`);
    }
    for (const route of ['/', '/archive/', `/archive/${datedIssues[0]}/`, `/archive/${datedIssues.at(-1)}/`]) {
      const response = await get(baseUrl, route);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers['content-type'], 'text/html; charset=utf-8', route);
    }
  });

  await t.test('feeds and JSON parse, and sitemap locations resolve inside the artifact', async () => {
    for (const relativePath of expected.filter((file) => /\.(json|webmanifest)$/.test(file))) {
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(artifactDir, relativePath), 'utf8')), relativePath);
    }
    const feed = cheerio.load(fs.readFileSync(path.join(artifactDir, 'feed.xml'), 'utf8'), { xmlMode: true });
    assert.equal(feed('rss > channel').length, 1);
    assert.equal(feed('rss > channel > link').first().text().trim(), PUBLIC_ROOT);
    assert.ok(feed('rss > channel > item').length > 0);

    const sitemap = cheerio.load(fs.readFileSync(path.join(artifactDir, 'sitemap.xml'), 'utf8'), { xmlMode: true });
    const locations = sitemap('urlset > url > loc').map((_, element) => sitemap(element).text().trim()).get();
    assert.ok(locations.length > 1);
    for (const location of locations) {
      assert.ok(location.startsWith(PUBLIC_ROOT), location);
      const response = await get(baseUrl, `/${location.slice(PUBLIC_ROOT.length)}`);
      assert.equal(response.status, 200, location);
    }
  });

  await t.test('oldest and newest issues keep committed reporting anchors and canonicals', async () => {
    for (const issueDate of [datedIssues[0], datedIssues.at(-1)]) {
      const issue = JSON.parse(pinnedBytes(revision, `archive/${issueDate}/index.json`).toString('utf8'));
      const page = (await get(baseUrl, `/archive/${issueDate}/`)).body.toString('utf8');
      assert.ok(issue.articles.length > 0, issueDate);
      for (const article of issue.articles) {
        assert.match(article.id, /^reporting-[0-9a-f]{12}$/, issueDate);
        assert.ok(page.includes(`id="${article.id}"`), `${issueDate} ${article.id}`);
      }
      assert.ok(page.includes(`<link rel="canonical" href="${PUBLIC_ROOT}archive/${issueDate}/">`), issueDate);
    }
    const index = (await get(baseUrl, '/')).body.toString('utf8');
    assert.ok(index.includes(`<link rel="canonical" href="${PUBLIC_ROOT}">`));
  });

  await t.test('implementation, private and unlisted paths return 404', async () => {
    for (const route of NEGATIVE_ROUTES) {
      const response = await get(baseUrl, route);
      assert.equal(response.status, 404, route);
    }
  });
});
