const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function request(port, target, host = `127.0.0.1:${port}`, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: target, method, headers: { Host: host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-preview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'index.html': '<title>Digest</title>',
    'archive/index.html': '<title>Archive</title>',
    'archive/2026-11-23/index.html': '<title>Issue</title>',
    'archive/2026-11-23/index.json': '{}',
    'assets/icon.svg': '<svg/>',
    'assets/private.py': 'private',
    'assets/receipt.json': 'private',
    'assets/node_modules/private.svg': 'private',
    'config/news-sources.json': '{"sources":[]}',
    'feed.xml': '<rss/>',
    'site.webmanifest': '{}',
    'scripts/private.js': 'private',
    'node_modules/package/index.js': 'private',
    '.git/config': 'private',
    'AGENTS.md': 'private',
    'test-results/fixture.html': 'private',
  };
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'assets/linked.svg'));
  fs.symlinkSync(path.join(root, 'scripts'), path.join(root, 'assets/linked-dir'));
  const code = `const { createPreviewServer } = require(${JSON.stringify(path.resolve(__dirname, '../scripts/serve-static.js'))});
    const server = createPreviewServer({root: ${JSON.stringify(root)}});
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));`;
  const child = childProcess.spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', () => reject(new Error(`preview server exited: ${stderr}`)));
    child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
}

test('preview serves public pages and assets while keeping repository files private', async (t) => {
  const port = await startServer(t);
  for (const target of ['/', '/?source=Example', '/archive/', '/archive/2026-11-23/', '/archive/2026-11-23/index.json', '/assets/icon.svg', '/feed.xml', '/site.webmanifest', '/config/news-sources.json']) {
    const response = await request(port, target);
    assert.equal(response.status, 200, target);
  }
  for (const target of ['/scripts/private.js', '/node_modules/package/index.js', '/.git/config', '/AGENTS.md', '/test-results/fixture.html', '/assets/linked.svg', '/assets/linked-dir/private.js', '/assets/.private.svg', '/assets/private.py', '/assets/receipt.json', '/assets/node_modules/private.svg']) {
    const response = await request(port, target);
    assert.equal(response.status, 404, target);
  }
  const head = await request(port, '/', undefined, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await request(port, '/', undefined, 'POST')).status, 405);
});

test('preview accepts only its configured loopback authority', async (t) => {
  const port = await startServer(t);
  for (const host of ['unrelated.example', `unrelated.example:${port}`, `localhost:${port}`, '127.0.0.1:1']) {
    assert.equal((await request(port, '/', host)).status, 403, host);
  }
  assert.equal((await request(port, '/')).status, 200);
});

test('malformed preview URLs return 400 and leave the listener usable', async (t) => {
  const port = await startServer(t);
  for (const target of ['/%', '/%E0%A4%A', '/%00', '/%5cfile', '//unrelated.example/path']) {
    assert.equal((await request(port, target)).status, 400, target);
    assert.equal((await request(port, '/')).status, 200, 'listener survives malformed path');
  }
});
