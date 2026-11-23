const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { assertPublicPath, classifyTrackedPath } = require('./build-static-artifact');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function createPreviewServer({ root = path.resolve(__dirname, '..'), host = '127.0.0.1' } = {}) {
  if (host !== '127.0.0.1') throw new Error('Preview host must be 127.0.0.1');
  const siteRoot = fs.realpathSync(root);
  const server = http.createServer((request, response) => {
    const send = (status, body = '', headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      const authority = `${host}:${server.address().port}`;
      if (request.headers.host !== authority) {
        send(403, 'Forbidden');
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        send(405, 'Method not allowed', { Allow: 'GET, HEAD' });
        return;
      }
      let requestPath;
      try {
        if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new Error('Invalid target');
        requestPath = decodeURIComponent(new URL(request.url, `http://${authority}`).pathname);
        if (requestPath.includes('\\') || requestPath.includes('\0')) throw new Error('Invalid path');
      } catch {
        send(400, 'Bad request');
        return;
      }
      const relativePath = requestPath === '/'
        ? 'index.html'
        : `${requestPath.slice(1)}${requestPath.endsWith('/') ? 'index.html' : ''}`;
      const segments = relativePath.split('/');
      if (segments.some((segment) => !segment || segment.startsWith('.'))
          || classifyTrackedPath(relativePath) !== 'include') {
        send(404, 'Not found');
        return;
      }
      try {
        assertPublicPath(relativePath);
      } catch {
        send(404, 'Not found');
        return;
      }
      // Resolve each segment without following links, including directory links.
      let filePath = siteRoot;
      for (const segment of segments) {
        filePath = path.join(filePath, segment);
        const stats = fs.lstatSync(filePath);
        if (stats.isSymbolicLink()) {
          send(404, 'Not found');
          return;
        }
      }
      if (!fs.statSync(filePath).isFile()) {
        send(404, 'Not found');
        return;
      }
      const contents = fs.readFileSync(filePath);
      send(200, contents, {
        'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
        'Content-Length': contents.length,
      });
    } catch (error) {
      if (!response.headersSent) {
        const status = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500;
        send(status, status === 404 ? 'Not found' : 'Server error');
      }
      else response.destroy();
    }
  });
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || '4173', 10);
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`SentryDigest test server listening on http://127.0.0.1:${server.address().port}`);
  });
}

module.exports = { createPreviewServer };
