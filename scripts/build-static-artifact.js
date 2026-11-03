#!/usr/bin/env node
// Copy the committed public SentryDigest files at a pinned revision into an
// immutable static artifact plus a prebuilt deploy layout. Nothing is fetched,
// generated or re-rendered: every published byte equals the pinned Git blob.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SITE = 'SentryDigest';
const DEPLOY_CONFIG = Object.freeze({ version: 3 });
// Tripwires against accidental inclusion (node_modules, caches, evidence), not
// hosting limits. The measured public set is about 14 MB with 217 KB pages.
const DEFAULT_LIMITS = Object.freeze({ maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
const REQUIRED_FILES = Object.freeze([
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
const DATED_ISSUE_FILE = /^archive\/(\d{4}-\d{2}-\d{2})\/index\.(html|json)$/;
const PUBLIC_PREFIXES = Object.freeze(['assets/']);
// Public on the legacy Pages origin today but never referenced by pages; the
// identity verifiers fetch contracts from raw.githubusercontent.com.
const EXCLUDED_FILES = Object.freeze(new Set([
  '.gitignore',
  'README.md',
  'contracts/README.md',
  'contracts/reporting-identity-verifier-v1.py',
  'package-lock.json',
  'package.json',
  'playwright.artifact.config.js',
  'playwright.config.js',
]));
const EXCLUDED_PREFIXES = Object.freeze(['.github/', 'publication/', 'scripts/', 'test/', 'tests/']);
const PRIVATE_NAMES = new Set([
  '__pycache__',
  'agent-instructions.md',
  'agent.md',
  'agent_instructions.md',
  'agents.md',
  'assistant-instructions.md',
  'assistant_instructions.md',
  'claude.md',
  'copilot-instructions.md',
  'gemini.md',
  'node_modules',
  'playwright-report',
  'test-results',
  'thumbs.db',
  'venv',
]);
const IMPLEMENTATION_FILE = /(\.(py|go|sh|ya?ml|toml|lock|map)|^package(-lock)?\.json)$/i;
const PRIVATE_EVIDENCE = /(receipt|screenshot|\.log$)/i;
const FULL_COMMIT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
// The repository's own artifact validator, run from the pinned revision against
// the staged artifact before promotion.
const VALIDATOR = 'scripts/validate-artifacts.js';
const POINTER = 'current.json';
const LOCK = '.lock';
const STAGING_PREFIX = '.staging-';

class StaticArtifactError extends Error {}

function fail(message) {
  throw new StaticArtifactError(message);
}

function classifyTrackedPath(relativePath) {
  if (EXCLUDED_FILES.has(relativePath) || EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return 'exclude';
  }
  if (REQUIRED_FILES.includes(relativePath)
      || DATED_ISSUE_FILE.test(relativePath)
      || PUBLIC_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return 'include';
  }
  return null;
}

function assertPublicPath(relativePath) {
  const segments = relativePath.split('/');
  if (path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0')) {
    fail(`${relativePath} is not a safe relative path`);
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') fail(`${relativePath} escapes the artifact root`);
    if (segment.startsWith('.')) fail(`${relativePath} is a dot path and must not be published`);
    if (PRIVATE_NAMES.has(segment.toLowerCase())) {
      fail(`${relativePath} is a private or implementation path and must not be published`);
    }
  }
  if (relativePath.toLowerCase().startsWith('docs/notes/')) {
    fail(`${relativePath} is a private or implementation path and must not be published`);
  }
  const name = segments.at(-1);
  if (IMPLEMENTATION_FILE.test(name)) fail(`${relativePath} is an implementation file and must not be published`);
  if (PRIVATE_EVIDENCE.test(name)) fail(`${relativePath} looks like private evidence (receipt, log or screenshot)`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function gitBlobId(objectFormat, bytes) {
  return crypto.createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function inventoryDigest(inventory) {
  return sha256(inventory.map((entry) => `${entry.sha256} ${entry.bytes} ${entry.path}\n`).join(''));
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function realpathOfNearest(target) {
  const missing = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createGit(source, commands) {
  return (args, options = {}) => {
    const argv = ['git', ...args];
    try {
      const output = childProcess.execFileSync('git', args, {
        cwd: source,
        encoding: options.encoding === 'buffer' ? undefined : options.encoding || 'utf8',
        input: options.input,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      commands.push({ argv, exit_status: 0 });
      return output;
    } catch (error) {
      commands.push({ argv, exit_status: typeof error.status === 'number' ? error.status : 1 });
      if (options.allowFailure) return null;
      fail(`${argv.join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
    }
  };
}

function resolveRevision(git, source, revision) {
  if (!FULL_COMMIT_ID.test(String(revision))) {
    fail(`revision must be a full commit id, got ${JSON.stringify(revision)}`);
  }
  const resolved = git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { allowFailure: true });
  if (!resolved || resolved.trim() !== revision) fail(`${revision} is not a commit in ${source}`);
  return revision;
}

function readTree(git, revision) {
  return git(['ls-tree', '-r', '-z', '--full-tree', revision]).split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}

function selectPublishedEntries(entries, revision) {
  const included = [];
  const excluded = [];
  for (const entry of entries) {
    const classification = classifyTrackedPath(entry.path);
    if (classification === 'exclude') {
      excluded.push(entry.path);
      continue;
    }
    if (classification !== 'include') {
      fail(`${entry.path} is tracked at ${revision} but is neither published nor excluded; classify it before building`);
    }
    if (entry.mode === '120000') fail(`${entry.path} is a symlink at the pinned revision; symlinks are refused`);
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      fail(`${entry.path} has unsupported mode ${entry.mode} at the pinned revision`);
    }
    assertPublicPath(entry.path);
    included.push(entry);
  }

  const publishedPaths = new Set(included.map((entry) => entry.path));
  for (const required of REQUIRED_FILES) {
    if (!publishedPaths.has(required)) fail(`${required} is required at revision ${revision}`);
  }
  const issueDates = new Set();
  for (const entry of included) {
    const match = entry.path.match(DATED_ISSUE_FILE);
    if (match) issueDates.add(match[1]);
  }
  if (issueDates.size === 0) fail(`at least one dated archive issue is required at revision ${revision}`);
  for (const issueDate of issueDates) {
    for (const name of ['index.html', 'index.json']) {
      if (!publishedPaths.has(`archive/${issueDate}/${name}`)) {
        fail(`archive/${issueDate}/${name} is required alongside the other file of that dated issue`);
      }
    }
  }
  return {
    included: included.sort((left, right) => comparePaths(left.path, right.path)),
    excluded: excluded.sort(comparePaths),
  };
}

function readPinnedBytes({ git, source, revision, objectFormat, entries, limits }) {
  const indexDiffers = new Set(git(['diff-index', '--cached', '-z', '--name-only', revision, '--']).split('\0').filter(Boolean));
  let totalBytes = 0;
  return entries.map((entry) => {
    if (indexDiffers.has(entry.path)) fail(`${entry.path}: index differs from pinned revision ${revision}`);
    const filePath = path.join(source, ...entry.path.split('/'));
    let stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') fail(`${entry.path} is tracked at ${revision} but missing from the source tree`);
      throw error;
    }
    if (!stats.isFile()) fail(`${entry.path} is not a regular file on disk; symlinks are refused`);
    const bytes = fs.readFileSync(filePath);
    if (gitBlobId(objectFormat, bytes) !== entry.oid) fail(`${entry.path} differs from pinned revision ${revision} on disk`);
    if (bytes.length > limits.maxFileBytes) {
      fail(`${entry.path} is ${bytes.length} bytes, which exceeds the ${limits.maxFileBytes}-byte file ceiling`);
    }
    totalBytes += bytes.length;
    if (totalBytes > limits.maxTotalBytes) {
      fail(`artifact total of at least ${totalBytes} bytes exceeds the ${limits.maxTotalBytes}-byte ceiling`);
    }
    return { path: entry.path, bytes };
  });
}

function readPinnedBlobs(git, oids) {
  if (oids.length === 0) return [];
  const output = git(['cat-file', '--batch'], { input: `${oids.join('\n')}\n`, encoding: 'buffer' });
  const blobs = [];
  let offset = 0;
  for (const oid of oids) {
    const newline = output.indexOf(10, offset);
    const [headerOid, type, size] = output.subarray(offset, newline).toString('utf8').split(' ');
    if (headerOid !== oid || type !== 'blob') fail(`git object ${oid} is not a readable blob`);
    const start = newline + 1;
    blobs.push(output.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  return blobs;
}

function xmlNotWellFormed(relativePath, reason) {
  fail(`${relativePath} is not well-formed XML: ${reason}`);
}

// ASCII subset of the XML Name production; stricter than XML 1.0, which also
// allows non-ASCII name characters the feed and sitemap never use.
const XML_NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;
// The XML S production: space, tab, CR and LF only. JavaScript's \s and trim()
// also accept Unicode spaces such as U+00A0, which XML parsers reject in markup.
const XML_SPACE = '[ \\t\\r\\n]';
const XML_ONLY_SPACE = new RegExp(`^${XML_SPACE}*$`);
const XML_ATTRIBUTE = new RegExp(`^${XML_SPACE}+([A-Za-z_:][-A-Za-z0-9_:.]*)${XML_SPACE}*=${XML_SPACE}*("[^"<]*"|'[^'<]*')`);
const XML_DECLARATION = new RegExp(
  `^<\\?xml${XML_SPACE}+version${XML_SPACE}*=${XML_SPACE}*(["'])1\\.[0-9]+\\1`
  + `(${XML_SPACE}+encoding${XML_SPACE}*=${XML_SPACE}*(["'])[A-Za-z][-A-Za-z0-9._]*\\3)?`
  + `(${XML_SPACE}+standalone${XML_SPACE}*=${XML_SPACE}*(["'])(yes|no)\\5)?${XML_SPACE}*\\?>`,
);
const XML_PREDEFINED_ENTITIES = new Set(['amp', 'apos', 'gt', 'lt', 'quot']);

// The XML 1.0 Char production.
function isXmlChar(codePoint) {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

// Without a DTD only the five predefined entities exist, and a character
// reference must name a legal XML character.
function assertXmlReferences(segment, relativePath, where) {
  for (let index = segment.indexOf('&'); index !== -1; index = segment.indexOf('&', index + 1)) {
    const reference = segment.slice(index + 1).match(/^(#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z_:][-A-Za-z0-9_:.]*);/);
    if (!reference) xmlNotWellFormed(relativePath, `malformed or unescaped "&" in ${where}`);
    const body = reference[1];
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!isXmlChar(codePoint)) xmlNotWellFormed(relativePath, `&${body}; is not a legal XML character in ${where}`);
    } else if (!XML_PREDEFINED_ENTITIES.has(body)) {
      xmlNotWellFormed(relativePath, `undefined entity &${body}; in ${where}`);
    }
  }
}

// Strict well-formedness for DTD-less XML such as the feed and sitemap: legal
// characters, one root element, balanced and correctly nested tags, quoted
// unique attributes, only predefined entities and legal character references,
// well-formed comments and processing instructions, and no "]]>" in text. A
// document type declaration is refused.
function assertWellFormedXml(text, relativePath) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (!isXmlChar(codePoint)) {
      xmlNotWellFormed(relativePath, `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} is not a legal XML character`);
    }
  }
  const stack = [];
  let rootSeen = false;
  let index = text.startsWith('﻿') ? 1 : 0;
  const documentStart = index;
  const skipTo = (terminator, from, what) => {
    const end = text.indexOf(terminator, from);
    if (end === -1) xmlNotWellFormed(relativePath, `unterminated ${what}`);
    return end;
  };
  while (index < text.length) {
    const open = text.indexOf('<', index);
    const segment = open === -1 ? text.slice(index) : text.slice(index, open);
    if (stack.length === 0) {
      if (!XML_ONLY_SPACE.test(segment)) xmlNotWellFormed(relativePath, 'text outside the root element');
    } else {
      if (segment.includes(']]>')) xmlNotWellFormed(relativePath, '"]]>" in character data');
      assertXmlReferences(segment, relativePath, 'character data');
    }
    if (open === -1) break;

    if (text.startsWith('<?', open)) {
      const end = skipTo('?>', open + 2, 'processing instruction');
      const target = text.slice(open + 2, end).match(XML_NAME)?.[0];
      if (!target) xmlNotWellFormed(relativePath, 'processing instruction without a target');
      const afterTarget = text.slice(open + 2 + target.length, end);
      if (afterTarget && !new RegExp(`^${XML_SPACE}`).test(afterTarget)) xmlNotWellFormed(relativePath, `malformed processing instruction <?${target}`);
      if (target.toLowerCase() === 'xml') {
        if (open !== documentStart || target !== 'xml') xmlNotWellFormed(relativePath, 'XML declaration is not at the start of the document');
        if (!XML_DECLARATION.test(text.slice(open, end + 2))) xmlNotWellFormed(relativePath, 'malformed XML declaration');
      }
      index = end + 2;
      continue;
    }
    if (text.startsWith('<!--', open)) {
      const end = skipTo('-->', open + 4, 'comment');
      const body = text.slice(open + 4, end);
      if (body.includes('--') || body.endsWith('-')) xmlNotWellFormed(relativePath, 'comment contains "--"');
      index = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      if (stack.length === 0) xmlNotWellFormed(relativePath, 'CDATA outside the root element');
      index = skipTo(']]>', open + 9, 'CDATA section') + 3;
      continue;
    }
    if (text.startsWith('<!', open)) xmlNotWellFormed(relativePath, 'document type declarations are not accepted');

    const closing = text.startsWith('</', open);
    let end = open + (closing ? 2 : 1);
    let quote = null;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      } else if (character === '<') {
        xmlNotWellFormed(relativePath, 'unexpected "<" inside a tag');
      }
    }
    if (end >= text.length) xmlNotWellFormed(relativePath, 'unterminated tag');
    const body = text.slice(open + (closing ? 2 : 1), end);
    index = end + 1;

    if (closing) {
      const name = body.match(XML_NAME)?.[0];
      if (!name || !XML_ONLY_SPACE.test(body.slice(name.length))) xmlNotWellFormed(relativePath, `malformed end tag </${body}>`);
      const expected = stack.pop();
      if (name !== expected) xmlNotWellFormed(relativePath, `</${name}> does not close <${expected ?? 'nothing'}>`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const tag = selfClosing ? body.slice(0, -1) : body;
    const name = tag.match(XML_NAME)?.[0];
    if (!name) xmlNotWellFormed(relativePath, 'invalid element name');
    if (stack.length === 0) {
      if (rootSeen) xmlNotWellFormed(relativePath, 'more than one root element');
      rootSeen = true;
    }
    let rest = tag.slice(name.length);
    const attributes = new Set();
    let attribute;
    while ((attribute = rest.match(XML_ATTRIBUTE))) {
      if (attributes.has(attribute[1])) xmlNotWellFormed(relativePath, `duplicate attribute ${attribute[1]} on <${name}>`);
      assertXmlReferences(attribute[2].slice(1, -1), relativePath, `an attribute of <${name}>`);
      attributes.add(attribute[1]);
      rest = rest.slice(attribute[0].length);
    }
    if (!XML_ONLY_SPACE.test(rest)) xmlNotWellFormed(relativePath, `malformed attributes on <${name}>`);
    if (!selfClosing) stack.push(name);
  }
  if (stack.length) xmlNotWellFormed(relativePath, `<${stack.at(-1)}> is not closed`);
  if (!rootSeen) xmlNotWellFormed(relativePath, 'no root element');
}

function checkContentSyntax(artifactDir, inventory) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const entry of inventory) {
    const extension = path.extname(entry.path);
    if (!['.json', '.webmanifest', '.xml'].includes(extension)) continue;
    let text;
    try {
      text = decoder.decode(fs.readFileSync(path.join(artifactDir, ...entry.path.split('/'))));
    } catch {
      fail(`${entry.path} is not valid UTF-8`);
    }
    if (extension === '.xml') {
      assertWellFormedXml(text, entry.path);
    } else {
      try {
        JSON.parse(text);
      } catch (error) {
        fail(`${entry.path} is not valid JSON: ${error.message}`);
      }
    }
  }
}

// The validator and every module it requires through relative paths, read from
// the pinned revision's object store so local edits cannot influence the gate.
function validatorClosure(git, entries, revision) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  if (!byPath.has(VALIDATOR)) fail(`${VALIDATOR} is required at revision ${revision} to validate the artifact`);
  const files = new Map();
  const pending = [VALIDATOR];
  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (files.has(relativePath)) continue;
    const entry = byPath.get(relativePath);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      fail(`${relativePath} is required by the artifact validator but is not a regular file at revision ${revision}`);
    }
    const [bytes] = readPinnedBlobs(git, [entry.oid]);
    files.set(relativePath, bytes);
    for (const match of bytes.toString('utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const base = path.posix.join(path.posix.dirname(relativePath), match[1]);
      const resolved = [base, `${base}.js`, `${base}.json`, `${base}/index.js`].find((candidate) => byPath.has(candidate));
      if (!resolved) fail(`${relativePath} requires ${match[1]}, which is not tracked at revision ${revision}`);
      pending.push(resolved);
    }
  }
  return files;
}

const VALIDATOR_RUNNER = [
  'const [validatorPath, artifactDir] = process.argv.slice(1);',
  'const { validateArtifacts } = require(validatorPath);',
  "if (typeof validateArtifacts !== 'function') throw new Error('validateArtifacts is not exported');",
  'const result = validateArtifacts(artifactDir);',
  'process.stdout.write(JSON.stringify({ valid: result.valid === true, failures: result.failures || [] }));',
].join('\n');

function runRepositoryValidator({ git, entries, revision, sourceRoot, stage, commands }) {
  const validatorRoot = path.join(stage, 'validator');
  for (const [relativePath, bytes] of validatorClosure(git, entries, revision)) {
    writeDurable(path.join(validatorRoot, ...relativePath.split('/')), bytes);
  }
  const artifactDir = path.join(stage, 'artifact');
  const validatorPath = path.join(validatorRoot, ...VALIDATOR.split('/'));
  const nodePath = [process.env.NODE_PATH, path.join(sourceRoot, 'node_modules'), path.resolve(__dirname, '..', 'node_modules')]
    .filter(Boolean)
    .join(path.delimiter);
  const argv = [process.execPath, '-e', VALIDATOR_RUNNER, validatorPath, artifactDir];
  const completed = childProcess.spawnSync(argv[0], argv.slice(1), {
    cwd: stage,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: nodePath },
    maxBuffer: 64 * 1024 * 1024,
  });
  commands.push({ argv: [argv[0], '-e', '<run validateArtifacts>', validatorPath, artifactDir], exit_status: completed.status ?? 1 });
  fs.rmSync(validatorRoot, { recursive: true, force: true });
  if (completed.status !== 0) {
    const detail = String(completed.stderr || completed.error || '').trim().split('\n').slice(-3).join(' | ');
    fail(`${VALIDATOR} at ${revision} could not validate the artifact (exit status ${completed.status}): ${detail}`);
  }
  const result = JSON.parse(completed.stdout);
  if (!result.valid) {
    const shown = result.failures.slice(0, 5).join('; ');
    const more = result.failures.length > 5 ? `; and ${result.failures.length - 5} more` : '';
    fail(`artifact content failed ${VALIDATOR} at ${revision}: ${shown}${more}`);
  }
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeDurable(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomic(filePath, bytes) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  writeDurable(temporary, bytes);
  fs.renameSync(temporary, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function inventoryOf(root, limits = DEFAULT_LIMITS) {
  const inventory = [];
  const visit = (directory, prefix) => {
    for (const name of fs.readdirSync(directory).sort(comparePaths)) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory()) {
        visit(absolute, relative);
      } else if (stats.isFile()) {
        const bytes = fs.readFileSync(absolute);
        inventory.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        fail(`${relative} is not a regular file or directory`);
      }
    }
  };
  visit(root, '');
  inventory.sort((left, right) => comparePaths(left.path, right.path));
  let total = 0;
  for (const entry of inventory) {
    assertPublicPath(entry.path);
    if (entry.bytes > limits.maxFileBytes) {
      fail(`${entry.path} is ${entry.bytes} bytes, which exceeds the ${limits.maxFileBytes}-byte file ceiling`);
    }
    total += entry.bytes;
  }
  if (total > limits.maxTotalBytes) fail(`artifact total of ${total} bytes exceeds the ${limits.maxTotalBytes}-byte ceiling`);
  return { inventory, totalBytes: total, digest: inventoryDigest(inventory) };
}

function assertDeployLayout(deployDir, expectedDigest, limits) {
  const output = path.join(deployDir, '.vercel', 'output');
  const topLevel = fs.readdirSync(deployDir);
  if (topLevel.length !== 1 || topLevel[0] !== '.vercel' || fs.readdirSync(path.join(deployDir, '.vercel')).join() !== 'output') {
    fail('deploy layout must contain only .vercel/output');
  }
  if (fs.readdirSync(output).sort().join() !== 'config.json,static') {
    fail('deploy layout output must contain only config.json and static/');
  }
  const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
  if (JSON.stringify(config) !== JSON.stringify(DEPLOY_CONFIG)) {
    fail('deploy config must carry only the Build Output API version, with no routes, headers, redirects or identifiers');
  }
  const staticInventory = inventoryOf(path.join(output, 'static'), limits);
  if (staticInventory.digest !== expectedDigest) fail('deploy layout static files differ from the artifact');
  return staticInventory.digest;
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return {};
  }
}

function acquireLock(output) {
  const lockPath = path.join(output, LOCK);
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o644);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = readLock(lockPath);
    let running = holder.hostname !== os.hostname();
    if (!running && Number.isInteger(holder.pid)) {
      try {
        process.kill(holder.pid, 0);
        running = true;
      } catch (signalError) {
        running = signalError.code === 'EPERM';
      }
    }
    const state = running
      ? `running on ${holder.hostname || 'an unknown host'}; builds of one store are serialized`
      : `not running; a previous build was interrupted. Confirm no builder is active, then remove ${lockPath}`;
    fail(`output store ${output} is locked by pid ${holder.pid ?? 'unknown'} (${state})`);
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), started_at: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return () => fs.rmSync(lockPath, { force: true });
}

function removeInterruptedStaging(output) {
  for (const name of fs.readdirSync(output)) {
    if (name.startsWith(STAGING_PREFIX) || name.startsWith(`.${POINTER}.tmp-`)) {
      fs.rmSync(path.join(output, name), { recursive: true, force: true });
    }
  }
}

function readCurrentBuild(output, { verify = false } = {}) {
  const pointerPath = path.join(output, POINTER);
  const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
  if (pointer.site !== SITE || pointer.build !== `builds/${pointer.inventory_digest}`) {
    fail(`${pointerPath} does not describe a ${SITE} build`);
  }
  const buildDir = path.join(output, pointer.build);
  const current = {
    site: pointer.site,
    sourceRevision: pointer.source_revision,
    inventoryDigest: pointer.inventory_digest,
    fileCount: pointer.file_count,
    totalBytes: pointer.total_bytes,
    buildDir: pointer.build,
    artifactDir: path.join(buildDir, 'artifact'),
    deployDir: path.join(buildDir, 'deploy'),
  };
  if (verify && inventoryOf(current.artifactDir).digest !== current.inventoryDigest) {
    fail(`${current.artifactDir} no longer matches inventory digest ${current.inventoryDigest}`);
  }
  return current;
}

function buildStaticArtifact({
  source = path.resolve(__dirname, '..'),
  revision,
  output,
  receipts,
  limits = DEFAULT_LIMITS,
  hooks = {},
  invocation = null,
}) {
  const startedAt = new Date().toISOString();
  if (!output || !receipts) fail('output and receipts directories are required');
  const sourceRoot = fs.realpathSync(source);
  const outputRoot = realpathOfNearest(output);
  const receiptsRoot = realpathOfNearest(receipts);
  if (outputRoot === path.parse(outputRoot).root) fail('output store must not be the filesystem root');
  if (isWithin(outputRoot, sourceRoot)) fail(`output store ${outputRoot} is inside the source tree`);
  if (isWithin(receiptsRoot, outputRoot)) fail(`receipts directory ${receiptsRoot} is inside the output store`);
  if (isWithin(receiptsRoot, sourceRoot)) fail(`receipts directory ${receiptsRoot} is inside the source tree`);

  const commands = [];
  const git = createGit(sourceRoot, commands);
  const topLevel = git(['rev-parse', '--show-toplevel']).trim();
  if (fs.realpathSync(topLevel) !== sourceRoot) fail(`source ${sourceRoot} must be the repository root`);
  const objectFormat = git(['rev-parse', '--show-object-format']).trim();
  resolveRevision(git, sourceRoot, revision);
  const sourceHead = git(['rev-parse', 'HEAD']).trim();
  const tree = readTree(git, revision);
  const { included, excluded } = selectPublishedEntries(tree, revision);
  const files = readPinnedBytes({ git, source: sourceRoot, revision, objectFormat, entries: included, limits });

  fs.mkdirSync(outputRoot, { recursive: true });
  const releaseLock = acquireLock(outputRoot);
  let stage = null;
  try {
    removeInterruptedStaging(outputRoot);
    stage = fs.mkdtempSync(path.join(outputRoot, STAGING_PREFIX));
    const artifactDir = path.join(stage, 'artifact');
    const staticDir = path.join(stage, 'deploy', '.vercel', 'output', 'static');
    for (const file of files) {
      writeDurable(path.join(artifactDir, ...file.path.split('/')), file.bytes);
      writeDurable(path.join(staticDir, ...file.path.split('/')), file.bytes);
    }
    writeDurable(path.join(stage, 'deploy', '.vercel', 'output', 'config.json'), `${JSON.stringify(DEPLOY_CONFIG)}\n`);

    const artifact = inventoryOf(artifactDir, limits);
    checkContentSyntax(artifactDir, artifact.inventory);
    runRepositoryValidator({ git, entries: tree, revision, sourceRoot, stage, commands });
    const staticDigest = assertDeployLayout(path.join(stage, 'deploy'), artifact.digest, limits);
    const buildRelative = `builds/${artifact.digest}`;
    const buildDir = path.join(outputRoot, 'builds', artifact.digest);

    if (hooks.beforePromote) hooks.beforePromote();
    fs.mkdirSync(path.dirname(buildDir), { recursive: true });
    let reusedExistingBuild = false;
    if (fs.existsSync(buildDir)) {
      if (inventoryOf(path.join(buildDir, 'artifact'), limits).digest !== artifact.digest
          || assertDeployLayout(path.join(buildDir, 'deploy'), artifact.digest, limits) !== staticDigest) {
        fail(`${buildDir} exists but does not match its digest; refusing to overwrite an accepted build`);
      }
      fs.rmSync(stage, { recursive: true, force: true });
      reusedExistingBuild = true;
    } else {
      fs.renameSync(stage, buildDir);
      fsyncDirectory(path.dirname(buildDir));
    }
    stage = null;

    const pointerPath = path.join(outputRoot, POINTER);
    const previousPointer = fs.existsSync(pointerPath) ? fs.readFileSync(pointerPath) : null;
    const pointer = {
      schema: 'static-artifact-pointer/v1',
      site: SITE,
      source_revision: revision,
      inventory_digest: artifact.digest,
      build: buildRelative,
      file_count: artifact.inventory.length,
      total_bytes: artifact.totalBytes,
    };
    if (hooks.beforePointerSwap) hooks.beforePointerSwap();
    writeAtomic(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

    const receipt = {
      schema: 'static-artifact-receipt/v1',
      site: SITE,
      result: 'success',
      source_revision: revision,
      source_head: sourceHead,
      object_format: objectFormat,
      inventory_digest: artifact.digest,
      inventory_digest_format: 'sha256 over "<sha256> <bytes> <path>\\n" lines sorted by path',
      file_count: artifact.inventory.length,
      total_bytes: artifact.totalBytes,
      inventory: artifact.inventory,
      excluded_tracked_paths: excluded,
      deploy_layout: {
        path: `${buildRelative}/deploy/.vercel/output`,
        config: DEPLOY_CONFIG,
        static_inventory_digest: staticDigest,
      },
      output_store: outputRoot,
      build: buildRelative,
      reused_existing_build: reusedExistingBuild,
      limits,
      builder: {
        path: 'scripts/build-static-artifact.js',
        sha256: sha256(fs.readFileSync(__filename)),
        node: process.version,
      },
      invocation,
      commands,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
    const receiptName = `${SITE.toLowerCase()}-${receipt.finished_at.replace(/[-:.]/g, '')}-${artifact.digest.slice(0, 12)}-${crypto.randomBytes(3).toString('hex')}.json`;
    const receiptPath = path.join(receiptsRoot, receiptName);
    try {
      fs.mkdirSync(receiptsRoot, { recursive: true });
      writeAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    } catch (error) {
      if (previousPointer) writeAtomic(pointerPath, previousPointer);
      else fs.rmSync(pointerPath, { force: true });
      throw error;
    }

    return {
      site: SITE,
      sourceRevision: revision,
      inventoryDigest: artifact.digest,
      fileCount: artifact.inventory.length,
      totalBytes: artifact.totalBytes,
      excludedPaths: excluded,
      buildDir: buildRelative,
      artifactDir: path.join(buildDir, 'artifact'),
      deployDir: path.join(buildDir, 'deploy'),
      receiptPath,
      reusedExistingBuild,
    };
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    releaseLock();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--revision', '--output', '--receipts'].includes(name) || value === undefined) {
      fail(`usage: build-static-artifact.js --revision <commit> --output <store> --receipts <dir> [--source <repo>]`);
    }
    options[name.slice(2)] = value;
  }
  return options;
}

function runCli() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = buildStaticArtifact({ ...options, invocation: ['node', ...process.argv.slice(1)] });
    console.log(JSON.stringify({
      site: result.site,
      source_revision: result.sourceRevision,
      inventory_digest: result.inventoryDigest,
      file_count: result.fileCount,
      total_bytes: result.totalBytes,
      build: result.buildDir,
      reused_existing_build: result.reusedExistingBuild,
      receipt: result.receiptPath,
    }, null, 2));
  } catch (error) {
    console.error(`static artifact build failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  DEFAULT_LIMITS,
  DEPLOY_CONFIG,
  StaticArtifactError,
  assertDeployLayout,
  assertWellFormedXml,
  buildStaticArtifact,
  classifyTrackedPath,
  inventoryOf,
  readCurrentBuild,
};
