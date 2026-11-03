const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createArtifactServer } = require('../scripts/serve-static-artifact');

const FILES = {
  'index.html': '<!doctype html><title>Current</title>\n',
  'archive/index.html': '<!doctype html><title>Archive</title>\n',
  'archive/2026-01-01/index.html': '<!doctype html><title>Issue</title>\n',
  'archive/2026-01-01/index.json': '{"issue_date":"2026-01-01"}\n',
  'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  'assets/favicon.ico': 'ico',
  'assets/logo.png': 'png',
  'assets/site.css': 'body{}\n',
  'assets/app.js': 'void 0;\n',
  'feed.xml': '<rss></rss>\n',
  'site.webmanifest': '{}\n',
  'report.md': '# Report\n',
};

async function startServer(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-server-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, 'artifact');
  for (const [relativePath, contents] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(root, relativePath), contents);
  }
  fs.writeFileSync(path.join(workspace, 'secret.txt'), 'outside\n');
  fs.symlinkSync(path.join(workspace, 'secret.txt'), path.join(root, 'assets', 'linked.txt'));
  fs.symlinkSync(path.join(root, 'archive'), path.join(root, 'linked-dir'));

  const server = createArtifactServer({ root, site: 'SentryDigest', inventoryDigest: 'a'.repeat(64) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function request(baseUrl, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${rawPath}`, { method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves artifact files with explicit content types and an identity header', async (t) => {
  const baseUrl = await startServer(t);
  const expectations = {
    '/': ['text/html; charset=utf-8', FILES['index.html']],
    '/index.html': ['text/html; charset=utf-8', FILES['index.html']],
    '/archive/': ['text/html; charset=utf-8', FILES['archive/index.html']],
    '/archive/2026-01-01/': ['text/html; charset=utf-8', FILES['archive/2026-01-01/index.html']],
    '/archive/2026-01-01/index.json': ['application/json; charset=utf-8', FILES['archive/2026-01-01/index.json']],
    '/assets/icon.svg': ['image/svg+xml', FILES['assets/icon.svg']],
    '/assets/favicon.ico': ['image/x-icon', FILES['assets/favicon.ico']],
    '/assets/logo.png': ['image/png', FILES['assets/logo.png']],
    '/assets/site.css': ['text/css; charset=utf-8', FILES['assets/site.css']],
    '/assets/app.js': ['text/javascript; charset=utf-8', FILES['assets/app.js']],
    '/feed.xml': ['application/xml; charset=utf-8', FILES['feed.xml']],
    '/site.webmanifest': ['application/manifest+json; charset=utf-8', FILES['site.webmanifest']],
    '/report.md': ['text/markdown; charset=utf-8', FILES['report.md']],
    '/assets/app.js?v=123': ['text/javascript; charset=utf-8', FILES['assets/app.js']],
  };
  for (const [route, [contentType, body]] of Object.entries(expectations)) {
    const response = await request(baseUrl, route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers['content-type'], contentType, route);
    assert.equal(response.body, body, route);
    assert.equal(response.headers['x-static-artifact'], `SentryDigest ${'a'.repeat(64)}`, route);
  }
  const head = await request(baseUrl, '/feed.xml', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('redirects an indexed directory without its trailing slash', async (t) => {
  const baseUrl = await startServer(t);
  const response = await request(baseUrl, '/archive/2026-01-01?from=test');

  assert.equal(response.status, 301);
  assert.equal(response.headers.location, '/archive/2026-01-01/?from=test');
});

test('returns 404 without listings, symlinks or traversal outside the artifact', async (t) => {
  const baseUrl = await startServer(t);
  for (const route of [
    '/assets/',
    '/assets',
    '/missing.html',
    '/index.html/',
    '/assets/linked.txt',
    '/linked-dir/',
    '/linked-dir/index.html',
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/index.html%00.png',
    '/.git/HEAD',
    '/package.json',
  ]) {
    const response = await request(baseUrl, route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(response.body, /outside|<a href|Index of/i, route);
  }
});

test('rejects methods other than GET and HEAD', async (t) => {
  const baseUrl = await startServer(t);
  const response = await request(baseUrl, '/index.html', 'POST');

  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
});

function startServerProcess(t, root) {
  const script = `
    const { createArtifactServer } = require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'serve-static-artifact.js'))});
    const server = createArtifactServer({ root: process.argv[1], site: 'SentryDigest', inventoryDigest: '${'c'.repeat(64)}' });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `;
  const child = childProcess.spawn(process.execPath, ['-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve({ child, exited, port: Number(String(chunk).trim()) }));
    child.once('exit', (code) => reject(new Error(`server exited early with ${code}`)));
  });
}

function rawRequest(port, target) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => resolve({ error: error.code }));
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status: Number(text.match(/^HTTP\/1\.1 (\d{3})/)?.[1]) || null, text });
    });
  });
}

test('a malformed request target gets a bounded error and the listener stays alive', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-server-raw-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'index.html'), FILES['index.html']);
  const { child, port } = await startServerProcess(t, workspace);

  assert.equal((await rawRequest(port, '/')).status, 200);
  for (const target of ['//', 'http://[', '//[::1', '/%']) {
    const response = await rawRequest(port, target);
    assert.ok([400, 404].includes(response.status), `${target}: ${JSON.stringify(response)}`);
    assert.equal(child.exitCode, null, target);
    assert.equal((await rawRequest(port, '/')).status, 200, `listener alive after ${target}`);
  }
  assert.equal((await rawRequest(port, '//')).status, 400);
});
