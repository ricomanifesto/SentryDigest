#!/usr/bin/env node
// Loopback server for artifact acceptance. Unlike serve-static.js it serves one
// artifact directory only: no listings, no symlinks, 404 for anything else.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { readCurrentBuild } = require('./build-static-artifact');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

// Returns the artifact-relative segments for a URL path, or null when the path
// cannot name a file inside the artifact.
function requestSegments(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  const segments = decoded.slice(1).split('/');
  if (segments.at(-1) === '') segments.pop();
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments;
}

// Walks without following symlinks so nothing outside the artifact is reachable.
function resolveInside(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = lstatOrNull(current);
    if (!stats || stats.isSymbolicLink()) return null;
  }
  return { filePath: current, stats: lstatOrNull(current) };
}

function createArtifactServer({ root, site, inventoryDigest }) {
  const artifactRoot = fs.realpathSync(root);
  const identity = `${site} ${inventoryDigest}`;

  const handle = (request, send) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'Method not allowed\n');
      return;
    }

    let url;
    try {
      url = new URL(request.url, 'http://artifact.invalid');
    } catch {
      send(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request\n');
      return;
    }
    if (!request.url.startsWith('/') || request.url.startsWith('//')) {
      send(400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request\n');
      return;
    }
    const notFound = () => send(404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found\n');
    const segments = requestSegments(url.pathname);
    const target = segments && resolveInside(artifactRoot, segments);
    if (!target) {
      notFound();
      return;
    }

    let filePath = target.filePath;
    if (target.stats.isDirectory()) {
      const index = lstatOrNull(path.join(filePath, 'index.html'));
      if (!index || !index.isFile()) {
        notFound();
        return;
      }
      if (!url.pathname.endsWith('/')) {
        send(301, { Location: `${url.pathname}/${url.search}` });
        return;
      }
      filePath = path.join(filePath, 'index.html');
    } else if (!target.stats.isFile() || url.pathname.endsWith('/')) {
      notFound();
      return;
    }

    const contents = fs.readFileSync(filePath);
    send(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': contents.length,
    }, contents);
  };

  // Every request is answered inside this boundary so a bad request cannot stop
  // the listener.
  return http.createServer((request, response) => {
    const send = (status, headers = {}, body = '') => {
      response.writeHead(status, { 'X-Static-Artifact': identity, 'Cache-Control': 'no-store', ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      handle(request, send);
    } catch {
      if (!response.headersSent) send(500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Server error\n');
      else response.destroy();
    }
  });
}

function runCli() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const store = option('--store');
  const port = Number.parseInt(option('--port') || process.env.STATIC_ARTIFACT_PORT || '4174', 10);
  if (!store) {
    console.error('usage: serve-static-artifact.js --store <store> [--port <port>]');
    process.exit(2);
  }
  const current = readCurrentBuild(store, { verify: true });
  const server = createArtifactServer({
    root: current.artifactDir,
    site: current.site,
    inventoryDigest: current.inventoryDigest,
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`${current.site} artifact ${current.inventoryDigest} listening on http://127.0.0.1:${port}`);
  });
}

if (require.main === module) {
  runCli();
}

module.exports = { CONTENT_TYPES, createArtifactServer };
