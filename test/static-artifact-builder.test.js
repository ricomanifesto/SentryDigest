const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const BUILDER = path.join(__dirname, '..', 'scripts', 'build-static-artifact.js');
const {
  DEPLOY_CONFIG,
  assertWellFormedXml,
  buildStaticArtifact,
  classifyTrackedPath,
  readCurrentBuild,
} = require('../scripts/build-static-artifact');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z',
};

const PUBLIC_FILES = {
  'index.html': '<!doctype html><title>SentryDigest</title><article id="reporting-0123456789ab"></article>\n',
  'archive/index.html': '<!doctype html><h1>Previous issues</h1>\n',
  'archive/2026-01-01/index.html': '<!doctype html><article id="reporting-aaaaaaaaaaaa"></article>\n',
  'archive/2026-01-01/index.json': '{"schema_version":1,"issue_date":"2026-01-01","articles":[]}\n',
  'archive/2026-01-02/index.html': '<!doctype html><article id="reporting-bbbbbbbbbbbb"></article>\n',
  'archive/2026-01-02/index.json': '{"schema_version":1,"issue_date":"2026-01-02","articles":[]}\n',
  'feed.xml': '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>\n',
  'feed-info.json': '{"lastUpdated":"2026-01-02T00:00:00Z"}\n',
  'news-data.json': '[]\n',
  'sentryinsight-findings.json': '{"schema_version":1}\n',
  'sentryinsight-context.json': '{"schema_version":2}\n',
  'sitemap.xml': '<?xml version="1.0"?><urlset></urlset>\n',
  'site.webmanifest': '{"name":"SentryDigest"}\n',
  'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  'assets/favicon.ico': 'ico',
  'config/news-sources.json': '{"sources":[]}\n',
  'contracts/reporting-identity-v1.json': '{"version":1}\n',
  LICENSE: 'MIT License\n',
};

const PRIVATE_OR_SOURCE_FILES = {
  'README.md': '# SentryDigest\n',
  '.gitignore': 'node_modules/\n',
  '.github/workflows/update-news.yml': 'name: Update\n',
  'contracts/README.md': '# Contracts\n',
  'contracts/reporting-identity-verifier-v1.py': 'print("verify")\n',
  'package.json': '{"name":"fixture"}\n',
  'package-lock.json': '{}\n',
  'playwright.config.js': 'module.exports = {};\n',
  // Local fake of the repository validator; real content runs the real one below.
  'scripts/validate-artifacts.js': 'exports.validateArtifacts = () => ({ valid: true, failures: [] });\n',
  'test/example.test.js': '// test\n',
  'tests/browser/example.spec.js': '// spec\n',
};

function git(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function commitAll(source, message) {
  git(source, 'add', '--all');
  git(source, 'commit', '--quiet', '--no-gpg-sign', '-m', message);
  return git(source, 'rev-parse', 'HEAD');
}

function createSource(t) {
  const workspace = makeTempDir(t, 'digest-artifact-');
  const source = path.join(workspace, 'source');
  fs.mkdirSync(source);
  git(source, 'init', '--quiet', '--initial-branch=main');
  for (const [relativePath, contents] of Object.entries({ ...PUBLIC_FILES, ...PRIVATE_OR_SOURCE_FILES })) {
    writeFile(source, relativePath, contents);
  }
  const revision = commitAll(source, 'fixture');
  return {
    workspace,
    source,
    revision,
    output: path.join(workspace, 'store'),
    receipts: path.join(workspace, 'receipts'),
  };
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.push(path.relative(root, entryPath).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files.sort();
}

function snapshot(root) {
  return Object.fromEntries(listFiles(root).map((relativePath) => [
    relativePath,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex'),
  ]));
}

// Independently confirmed to pass the earlier checker and the repository
// validator inside the real sitemap.
const CONFIRMED_MALFORMED_FRAGMENTS = [
  ['an undefined entity', '<extra>&bogus;</extra>'],
  ['a forbidden NUL character reference', '<extra>&#0;</extra>'],
  ['a double hyphen inside a comment', '<!-- a--b -->'],
  ['a CDATA terminator in character data', '<extra>abc]]>def</extra>'],
];

// Inserts text immediately after the XML declaration.
function afterXmlDeclaration(insert) {
  return (text) => {
    const end = text.indexOf('?>') + 2;
    return `${text.slice(0, end)}${insert}${text.slice(end)}`;
  };
}

function build(fixture, overrides = {}) {
  return buildStaticArtifact({
    source: fixture.source,
    revision: fixture.revision,
    output: fixture.output,
    receipts: fixture.receipts,
    ...overrides,
  });
}

test('publishes exactly the allowlisted files tracked at the pinned revision', (t) => {
  const fixture = createSource(t);
  writeFile(fixture.source, '.env', 'TOKEN=private\n');
  writeFile(fixture.source, 'AGENTS.md', 'private\n');
  writeFile(fixture.source, 'test-results/x.html', '<p>private</p>\n');
  writeFile(fixture.source, 'archive/2026-01-03/index.html', '<p>untracked issue</p>\n');
  writeFile(fixture.source, 'build-receipt.json', '{"inventory_digest":"0"}\n');

  const result = build(fixture);

  assert.deepEqual(listFiles(result.artifactDir), Object.keys(PUBLIC_FILES).sort());
  for (const [relativePath, contents] of Object.entries(PUBLIC_FILES)) {
    assert.equal(fs.readFileSync(path.join(result.artifactDir, relativePath), 'utf8'), contents);
  }
  assert.deepEqual(result.excludedPaths, Object.keys(PRIVATE_OR_SOURCE_FILES).sort());
  assert.equal(result.fileCount, Object.keys(PUBLIC_FILES).length);
  assert.equal(
    result.totalBytes,
    Object.values(PUBLIC_FILES).reduce((total, contents) => total + Buffer.byteLength(contents), 0),
  );
  assert.equal(readCurrentBuild(fixture.output).inventoryDigest, result.inventoryDigest);
  assert.equal(fs.existsSync(path.join(fixture.output, '.lock')), false);
});

test('rebuilds the same revision into another store with identical bytes and digest', (t) => {
  const fixture = createSource(t);
  const first = build(fixture);
  const second = build({ ...fixture, output: path.join(fixture.workspace, 'second-store') });

  assert.match(first.inventoryDigest, /^[0-9a-f]{64}$/);
  assert.equal(second.inventoryDigest, first.inventoryDigest);
  assert.deepEqual(snapshot(second.artifactDir), snapshot(first.artifactDir));
  assert.deepEqual(snapshot(second.deployDir), snapshot(first.deployDir));

  const repeat = build(fixture);
  assert.equal(repeat.inventoryDigest, first.inventoryDigest);
  assert.equal(repeat.reusedExistingBuild, true);
  assert.equal(repeat.buildDir, first.buildDir);
});

test('emits a prebuilt deploy layout whose static files equal the artifact', (t) => {
  const fixture = createSource(t);
  const result = build(fixture);

  assert.deepEqual(DEPLOY_CONFIG, { version: 3 });
  const deployFiles = listFiles(result.deployDir);
  assert.deepEqual(
    deployFiles,
    ['.vercel/output/config.json', ...Object.keys(PUBLIC_FILES).sort().map((file) => `.vercel/output/static/${file}`)].sort(),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(result.deployDir, '.vercel/output/config.json'), 'utf8')),
    { version: 3 },
  );
  assert.deepEqual(snapshot(path.join(result.deployDir, '.vercel/output/static')), snapshot(result.artifactDir));
});

test('writes a receipt outside the artifact that binds site, revision and inventory', (t) => {
  const fixture = createSource(t);
  const result = build(fixture);
  const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));

  assert.equal(path.dirname(result.receiptPath), fs.realpathSync(fixture.receipts));
  assert.equal(receipt.site, 'SentryDigest');
  assert.equal(receipt.source_revision, fixture.revision);
  assert.equal(receipt.inventory_digest, result.inventoryDigest);
  assert.equal(receipt.file_count, result.fileCount);
  assert.equal(receipt.total_bytes, result.totalBytes);
  assert.deepEqual(receipt.inventory.map((entry) => entry.path), Object.keys(PUBLIC_FILES).sort());
  for (const entry of receipt.inventory) {
    assert.equal(
      entry.sha256,
      crypto.createHash('sha256').update(PUBLIC_FILES[entry.path]).digest('hex'),
    );
    assert.equal(entry.bytes, Buffer.byteLength(PUBLIC_FILES[entry.path]));
  }
  const expectedDigest = crypto.createHash('sha256')
    .update(receipt.inventory.map((entry) => `${entry.sha256} ${entry.bytes} ${entry.path}\n`).join(''))
    .digest('hex');
  assert.equal(receipt.inventory_digest, expectedDigest);
  assert.deepEqual(receipt.deploy_layout.config, { version: 3 });
  assert.equal(receipt.deploy_layout.static_inventory_digest, result.inventoryDigest);
  assert.ok(receipt.commands.length > 0);
  assert.ok(receipt.commands.every((command) => command.exit_status === 0));
  assert.equal(listFiles(result.artifactDir).some((file) => /receipt/i.test(file)), false);
});

test('fails on a public file that differs from the pinned revision and keeps the last good build', (t) => {
  const fixture = createSource(t);
  const accepted = build(fixture);
  const before = snapshot(fixture.output);
  writeFile(fixture.source, 'index.html', '<p>locally edited</p>\n');

  assert.throws(() => build(fixture), /index\.html.*differs from pinned revision/);
  assert.deepEqual(snapshot(fixture.output), before);
  assert.equal(readCurrentBuild(fixture.output).inventoryDigest, accepted.inventoryDigest);
});

test('fails on a staged public change even when the worktree matches the revision', (t) => {
  const fixture = createSource(t);
  writeFile(fixture.source, 'feed.xml', '<rss>staged</rss>\n');
  git(fixture.source, 'add', 'feed.xml');
  writeFile(fixture.source, 'feed.xml', PUBLIC_FILES['feed.xml']);

  assert.throws(() => build(fixture), /feed\.xml.*index differs from pinned revision/);
});

test('fails on a missing public file and keeps the last good build', (t) => {
  const fixture = createSource(t);
  build(fixture);
  const before = snapshot(fixture.output);
  fs.rmSync(path.join(fixture.source, 'feed.xml'));

  assert.throws(() => build(fixture), /feed\.xml.*missing/);
  assert.deepEqual(snapshot(fixture.output), before);
});

test('fails when the pinned revision lacks a required public file', (t) => {
  const fixture = createSource(t);
  git(fixture.source, 'rm', '--quiet', 'sentryinsight-context.json');
  const revision = commitAll(fixture.source, 'drop context');

  assert.throws(() => build({ ...fixture, revision }), /sentryinsight-context\.json.*required/);
});

test('fails on a dated issue without its JSON companion', (t) => {
  const fixture = createSource(t);
  git(fixture.source, 'rm', '--quiet', 'archive/2026-01-02/index.json');
  const revision = commitAll(fixture.source, 'drop issue json');

  assert.throws(() => build({ ...fixture, revision }), /archive\/2026-01-02\/index\.json.*required/);
});

test('refuses a tracked symlink in the public set', (t) => {
  const fixture = createSource(t);
  fs.symlinkSync('icon.svg', path.join(fixture.source, 'assets', 'linked.svg'));
  const revision = commitAll(fixture.source, 'symlink');

  assert.throws(() => build({ ...fixture, revision }), /assets\/linked\.svg.*symlink/);
});

test('refuses unclassified tracked paths and private names', (t) => {
  for (const relativePath of ['.env', 'AGENTS.md', 'robots.txt', 'test-results/x.html', 'assets/.hidden.svg']) {
    const fixture = createSource(t);
    writeFile(fixture.source, relativePath, 'planted\n');
    git(fixture.source, 'add', '--force', relativePath);
    const revision = commitAll(fixture.source, `plant ${relativePath}`);
    const escaped = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    assert.throws(() => build({ ...fixture, revision }), new RegExp(escaped), relativePath);
    assert.equal(fs.existsSync(path.join(fixture.output, 'current.json')), false, relativePath);
  }
});

test('refuses receipt, log or screenshot files inside a public directory', (t) => {
  for (const relativePath of ['assets/build-receipt.json', 'assets/build.log', 'assets/screenshot-home.png']) {
    const fixture = createSource(t);
    writeFile(fixture.source, relativePath, '{}\n');
    const revision = commitAll(fixture.source, `plant ${relativePath}`);

    assert.throws(() => build({ ...fixture, revision }), /private evidence/, relativePath);
  }
});

test('fails explicitly when a file or the total exceeds the size ceiling', (t) => {
  const fixture = createSource(t);
  assert.throws(() => build(fixture, { limits: { maxFileBytes: 64, maxTotalBytes: 1 << 20 } }), /exceeds .*64/);
  assert.throws(() => build(fixture, { limits: { maxFileBytes: 1 << 20, maxTotalBytes: 128 } }), /total .*exceeds .*128/);
});

test('keeps the accepted build when promotion fails before or during the pointer swap', (t) => {
  for (const hook of ['beforePromote', 'beforePointerSwap']) {
    const fixture = createSource(t);
    const accepted = build(fixture);
    const before = snapshot(path.join(fixture.output, accepted.buildDir));
    writeFile(fixture.source, 'news-data.json', '[{"id":"next"}]\n');
    const revision = commitAll(fixture.source, 'next issue');

    assert.throws(
      () => build({ ...fixture, revision }, { hooks: { [hook]: () => { throw new Error(`injected ${hook}`); } } }),
      new RegExp(`injected ${hook}`),
    );
    assert.equal(readCurrentBuild(fixture.output).inventoryDigest, accepted.inventoryDigest, hook);
    assert.deepEqual(snapshot(path.join(fixture.output, accepted.buildDir)), before, hook);
    assert.deepEqual(
      fs.readdirSync(fixture.output).filter((name) => name.startsWith('.staging-') || name === '.lock'),
      [],
      hook,
    );
  }
});

function runChildBuild(fixture, revision, hookSource) {
  const script = `
    const { buildStaticArtifact } = require(${JSON.stringify(BUILDER)});
    buildStaticArtifact({
      source: ${JSON.stringify(fixture.source)},
      revision: ${JSON.stringify(revision)},
      output: ${JSON.stringify(fixture.output)},
      receipts: ${JSON.stringify(fixture.receipts)},
      hooks: { ${hookSource} },
    });
  `;
  return childProcess.spawn(process.execPath, ['-e', script], { env: GIT_ENV, stdio: 'ignore' });
}

function waitForExit(child) {
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('an interrupted promotion leaves the accepted build and blocks until the stale lock is cleared', async (t) => {
  const fixture = createSource(t);
  const accepted = build(fixture);
  const before = snapshot(path.join(fixture.output, accepted.buildDir));
  writeFile(fixture.source, 'news-data.json', '[{"id":"interrupted"}]\n');
  const revision = commitAll(fixture.source, 'interrupted issue');

  const exit = await waitForExit(runChildBuild(
    fixture,
    revision,
    "beforePointerSwap: () => process.kill(process.pid, 'SIGKILL')",
  ));

  assert.equal(exit.signal, 'SIGKILL');
  assert.equal(readCurrentBuild(fixture.output).inventoryDigest, accepted.inventoryDigest);
  assert.deepEqual(snapshot(path.join(fixture.output, accepted.buildDir)), before);
  assert.throws(() => build({ ...fixture, revision }), /locked by pid \d+.*not running/s);

  fs.rmSync(path.join(fixture.output, '.lock'));
  const recovered = build({ ...fixture, revision });
  assert.notEqual(recovered.inventoryDigest, accepted.inventoryDigest);
  assert.equal(readCurrentBuild(fixture.output).inventoryDigest, recovered.inventoryDigest);
  assert.deepEqual(fs.readdirSync(fixture.output).filter((name) => name.startsWith('.staging-')), []);
});

test('a second writer on the same store fails while the first holds the lock', async (t) => {
  const fixture = createSource(t);
  const paused = path.join(fixture.workspace, 'paused');
  const release = path.join(fixture.workspace, 'release');
  const child = runChildBuild(
    fixture,
    fixture.revision,
    `beforePromote: () => {
      require('node:fs').writeFileSync(${JSON.stringify(paused)}, '');
      while (!require('node:fs').existsSync(${JSON.stringify(release)})) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }`,
  );
  const exited = waitForExit(child);
  await waitForFile(paused);

  assert.throws(() => build(fixture), /locked by pid \d+/);
  fs.writeFileSync(release, '');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.ok(readCurrentBuild(fixture.output).inventoryDigest);
});

test('refuses unsafe outputs and revisions that are not full commit ids', (t) => {
  const fixture = createSource(t);

  assert.throws(() => build(fixture, { output: path.join(fixture.source, 'public') }), /inside the source tree/);
  assert.throws(() => build(fixture, { receipts: path.join(fixture.output, 'receipts') }), /receipts .*output store/);
  assert.throws(() => build(fixture, { revision: 'HEAD' }), /full commit id/);
  assert.throws(() => build(fixture, { revision: '0'.repeat(40) }), /not a commit/);
});

test('classifies every tracked and candidate path of this repository', () => {
  const root = path.join(__dirname, '..');
  const listed = [
    ...git(root, 'ls-files', '-z').split('\0'),
    ...git(root, 'ls-files', '-z', '--others', '--exclude-standard').split('\0'),
  ].filter(Boolean);
  const unclassified = listed.filter((relativePath) => classifyTrackedPath(relativePath) === null);

  assert.deepEqual(unclassified, []);
  assert.equal(classifyTrackedPath('playwright.artifact.config.js'), 'exclude');
});

test('builds a revision that commits the static artifact tooling without publishing it', (t) => {
  const fixture = createSource(t);
  const tooling = {
    'playwright.artifact.config.js': 'module.exports = {};\n',
    'scripts/build-static-artifact.js': '// builder\n',
    'scripts/serve-static-artifact.js': '// server\n',
    'test/static-artifact-builder.test.js': '// test\n',
    'tests/artifact-browser/reader.spec.js': '// spec\n',
    'tests/static-artifact/acceptance.test.js': '// acceptance\n',
  };
  for (const [relativePath, contents] of Object.entries(tooling)) writeFile(fixture.source, relativePath, contents);
  const revision = commitAll(fixture.source, 'commit tooling');

  const result = build({ ...fixture, revision });

  assert.deepEqual(listFiles(result.artifactDir), Object.keys(PUBLIC_FILES).sort());
  for (const relativePath of Object.keys(tooling)) assert.ok(result.excludedPaths.includes(relativePath), relativePath);
});

// Real committed content and the real repository validator, from a disposable clone.
test('content gate on committed content keeps the accepted build', async (t) => {
  const root = path.join(__dirname, '..');
  const workspace = makeTempDir(t, 'digest-content-');
  const template = path.join(workspace, 'template');
  git(root, 'clone', '--quiet', '--shared', '--no-checkout', root, template);
  git(template, 'checkout', '--quiet', 'HEAD', '--', '.');
  const issueDates = git(template, 'ls-files', 'archive')
    .split('\n')
    .map((name) => name.match(/^archive\/(\d{4}-\d{2}-\d{2})\/index\.json$/)?.[1])
    .filter(Boolean)
    .sort();
  const newestIssue = `archive/${issueDates.at(-1)}/index.json`;

  // Each case removes its own copy (about 40 MB) when it finishes.
  function acceptedFixture(subtest, name) {
    subtest.after(() => fs.rmSync(path.join(workspace, name), { recursive: true, force: true }));
    const source = path.join(workspace, name, 'source');
    fs.cpSync(template, source, { recursive: true, verbatimSymlinks: true });
    const fixture = {
      workspace: path.join(workspace, name),
      source,
      revision: git(source, 'rev-parse', 'HEAD'),
      output: path.join(workspace, name, 'store'),
      receipts: path.join(workspace, name, 'receipts'),
    };
    const accepted = build(fixture);
    return { fixture, accepted, before: snapshot(fixture.output) };
  }

  function commitChange(fixture, relativePath, change) {
    const filePath = path.join(fixture.source, relativePath);
    fs.writeFileSync(filePath, change(fs.readFileSync(filePath, 'utf8')));
    return commitAll(fixture.source, `change ${relativePath}`);
  }

  await t.test('the committed content passes the real validator before promotion', (subtest) => {
    const { fixture, accepted } = acceptedFixture(subtest, 'accepted');
    const receipt = JSON.parse(fs.readFileSync(accepted.receiptPath, 'utf8'));
    assert.ok(receipt.commands.some((command) => command.argv.join(' ').includes('validate-artifacts.js')));
    assert.equal(readCurrentBuild(fixture.output).inventoryDigest, accepted.inventoryDigest);
  });

  await t.test('XML whitespace after the declarations of the real feed and sitemap still promotes', (subtest) => {
    const { fixture, accepted } = acceptedFixture(subtest, 'xml-whitespace-control');
    for (const relativePath of ['feed.xml', 'sitemap.xml']) {
      const filePath = path.join(fixture.source, relativePath);
      fs.writeFileSync(filePath, afterXmlDeclaration(' \t\r\n')(fs.readFileSync(filePath, 'utf8')));
    }
    const revision = commitAll(fixture.source, 'XML whitespace in the prolog');

    const promoted = build({ ...fixture, revision });
    assert.notEqual(promoted.inventoryDigest, accepted.inventoryDigest);
    assert.equal(readCurrentBuild(fixture.output).inventoryDigest, promoted.inventoryDigest);
  });

  for (const [name, relativePath, change, expected] of [
    ['malformed news JSON', 'news-data.json', (text) => text.slice(0, -20), /news-data\.json is not valid JSON/],
    ['malformed dated issue JSON', newestIssue, (text) => `${text}}`, /archive\/\d{4}-\d{2}-\d{2}\/index\.json is not valid JSON/],
    ['malformed sitemap XML', 'sitemap.xml', (text) => text.replace('</urlset>', ''), /sitemap\.xml is not well-formed XML/],
    ['malformed feed XML', 'feed.xml', (text) => text.replace('</channel>', '</chanel>'), /feed\.xml is not well-formed XML/],
    ...['feed.xml', 'sitemap.xml'].map((relativePath) => [
      `${relativePath} with U+00A0 after the XML declaration`,
      relativePath,
      afterXmlDeclaration('\u00A0'),
      new RegExp(`${relativePath.replace('.', '\\.')} is not well-formed XML`),
    ]),
    ...CONFIRMED_MALFORMED_FRAGMENTS.map(([fragmentName, fragment]) => [
      `sitemap with ${fragmentName}`,
      'sitemap.xml',
      (text) => text.replace('</urlset>', `${fragment}</urlset>`),
      /sitemap\.xml is not well-formed XML/,
    ]),
    [
      'current page that fails the repository validator',
      'index.html',
      (text) => text.replace('id="reporting-', 'id="broken-'),
      /failed scripts\/validate-artifacts\.js.*must expose stable id/s,
    ],
  ]) {
    await t.test(`${name} fails and keeps the accepted build`, (subtest) => {
      const { fixture, accepted, before } = acceptedFixture(subtest, name.replaceAll(' ', '-'));
      const revision = commitChange(fixture, relativePath, change);

      assert.throws(() => build({ ...fixture, revision }), expected);
      assert.deepEqual(snapshot(fixture.output), before);
      assert.equal(readCurrentBuild(fixture.output).inventoryDigest, accepted.inventoryDigest);
    });
  }
});

test('XML well-formedness rejects documents a conforming parser rejects', () => {
  const malformed = {
    ...Object.fromEntries(CONFIRMED_MALFORMED_FRAGMENTS.map(([name, fragment]) => [name, `<root>${fragment}</root>`])),
    'an undefined entity in an attribute': '<root a="&nbsp;"/>',
    'a surrogate character reference': '<root>&#xD800;</root>',
    'an out-of-range character reference': '<root>&#x110000;</root>',
    'a control character reference': '<root>&#x1;</root>',
    'a raw control character': '<root>\u0001</root>',
    'a raw U+FFFE': '<root>￾</root>',
    'a comment ending in a hyphen': '<root><!-- a ---></root>',
    'a comment that is not closed': '<root><!-- a </root>',
    'a CDATA terminator in an attribute-free text run': '<root><a/>]]></root>',
    'whitespace before an end-tag name': '<root></ root>',
    'a reserved processing-instruction target': '<root><?xml-ish ok?><?XML no?></root>',
    'an XML declaration after the start': '\n<?xml version="1.0"?><root/>',
    'an empty reference': '<root>&;</root>',
    'an unterminated reference': '<root>&amp</root>',
    'a document type declaration': '<!DOCTYPE root><root/>',
    'two root elements': '<root/><root/>',
    'mismatched tags': '<root><a></b></root>',
    'an unquoted attribute': '<root a=b/>',
    'a duplicate attribute': '<root a="1" a="2"/>',
    'a lone surrogate character': '<root>\uD800</root>',
    ...Object.fromEntries([' ', ' ', '\u0085', ' ', '　', '﻿'].flatMap((space) => {
      const label = `U+${space.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
      return [
        [`${label} after the XML declaration`, `<?xml version="1.0"?>${space}<root/>`],
        [`${label} after the root element`, `<root/>${space}`],
        [`${label} before an attribute`, `<root${space}a="1"/>`],
        [`${label} around an attribute equals sign`, `<root a${space}="1"/>`],
        [`${label} before the end of a start tag`, `<root a="1"${space}></root>`],
        [`${label} inside an end tag`, `<root></root${space}>`],
        [`${label} after a processing-instruction target`, `<root><?pi${space}data?></root>`],
        [`${label} inside the XML declaration`, `<?xml${space}version="1.0"?><root/>`],
      ];
    })),
  };
  for (const [name, xml] of Object.entries(malformed)) {
    assert.throws(() => assertWellFormedXml(xml, 'probe.xml'), /probe\.xml is not well-formed XML/, name);
  }

  const wellFormed = {
    'predefined entities': '<root a="&quot;&apos;">&amp;&lt;&gt;</root>',
    'legal character references': '<root>&#9;&#xA;&#13;&#x20;&#xD7FF;&#xE000;&#xFFFD;&#x10000;&#x1F600;&#x10FFFF;</root>',
    'brackets and greater-than in text': '<root>a ]] b > c ]> d ]]</root>',
    'CDATA with markup characters': '<root><![CDATA[<b>&bogus; ]] ]>]]></root>',
    'comments with single hyphens': '<!-- lead --><root><!-- a-b - c --></root><!-- trail -->',
    'a declaration, BOM and processing instruction': '﻿<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet href="s.xsl"?><root/>',
    'whitespace inside an end tag': '<root><a></a ></root >',
    'namespaced names and attributes': '<rss xmlns:atom="http://www.w3.org/2005/Atom"><atom:link rel="self" href="x?a=1&amp;b=2"/></rss>',
    'non-ASCII text': '<root>Café — 日本 😀</root>',
    'XML whitespace in every whitespace position':
      '<?xml version="1.0"\t encoding="UTF-8"\r\n?> \t\r\n<?pi \tdata?>\n<root\n\ta \r= "1"\t/>\r\n',
    'U+00A0 and other Unicode spaces in character data and attribute values':
      '<root a="   ">a b　c\u0085d</root>',
    'U+00A0 in comments, CDATA and processing-instruction data':
      '<root><!-- --><![CDATA[ ]]><?pi data more?></root>',
  };
  for (const [name, xml] of Object.entries(wellFormed)) {
    assert.doesNotThrow(() => assertWellFormedXml(xml, 'probe.xml'), name);
  }
  for (const relativePath of ['feed.xml', 'sitemap.xml']) {
    const committed = git(path.join(__dirname, '..'), 'show', `HEAD:${relativePath}`);
    assert.doesNotThrow(() => assertWellFormedXml(committed, relativePath), relativePath);
  }
});
