const assert = require('node:assert/strict');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { fetchRSSFeed, fetchFeedXml } = require('../scripts/fetch-news');

const SOURCE = { name: 'Example Feed', url: 'https://feeds.example.com/feed.xml' };
const XML = '<rss version="2.0"><channel><title>Example</title><item><title>Security update</title><link>https://example.com/update</link><pubDate>Mon, 23 Nov 2026 12:00:00 GMT</pubDate><description>Update details.</description></item></channel></rss>';

// No sockets or upstream feeds are contacted. The fake transport invokes the
// same lookup callback that Node uses when connecting, then emits response data.
function mockTransport(t, responses, addresses = [{ address: '93.184.215.14', family: 4 }]) {
  const requests = [];
  t.mock.method(dns, 'lookup', (hostname, options, callback) => {
    queueMicrotask(() => callback(null, typeof addresses === 'function' ? addresses(hostname) : addresses));
  });
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = (error) => {
      req.destroyed = true;
      if (error) queueMicrotask(() => req.emit('error', error));
    };
    const record = { url: new URL(url), options, req };
    requests.push(record);
    req.end = () => {
      options.lookup(record.url.hostname.replace(/^\[|\]$/g, ''), { all: true }, (error, resolved) => {
        if (error) {
          req.emit('error', error);
          return;
        }
        record.resolved = resolved;
        if (req.destroyed) return;
        const spec = responses[requests.indexOf(record)] || {};
        const socket = new EventEmitter();
        socket.remoteAddress = spec.remoteAddress || resolved[0].address;
        req.emit('socket', socket);
        socket.emit('connect');
        if (req.destroyed) return;
        if (spec.wait) return;
        const response = new PassThrough();
        response.statusCode = spec.status || 200;
        response.headers = spec.headers || {};
        record.response = response;
        if (spec.abortOnDestroy) {
          const destroy = response.destroy.bind(response);
          response.destroy = () => { response.emit('aborted'); return destroy(); };
        }
        if (spec.lateErrorOnDestroy) {
          const destroy = response.destroy.bind(response);
          response.destroy = () => {
            queueMicrotask(() => {
              response.emit('error', new Error('Disposed response closed'));
              req.emit('error', new Error('Disposed request closed'));
            });
            return destroy();
          };
        }
        callback(response);
        if (spec.aborted) { response.emit('aborted'); return; }
        if (spec.stall) return;
        for (const chunk of spec.chunks || [XML]) {
          if (!response.destroyed) response.write(chunk);
        }
        if (!response.destroyed) response.end();
      });
    };
    return req;
  };
  t.mock.method(http, 'request', request);
  t.mock.method(https, 'request', request);
  // Existing parser URL fetching is also stubbed, so the red run never goes to
  // the network and demonstrates why parser-owned transport must be replaced.
  const Parser = require('rss-parser');
  t.mock.method(Parser.prototype, 'parseURL', async () => new Parser().parseString(XML));
  return requests;
}

test('RSS parsing uses bounded XML transport and preserves normalized article data', async (t) => {
  const requests = mockTransport(t, [{}]);
  const articles = await fetchRSSFeed(SOURCE);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.agent, false);
  assert.equal(requests[0].resolved[0].address, '93.184.215.14');
  assert.equal(articles[0].title, 'Security update');
  assert.equal(articles[0].summary, 'Update details.');
  assert.equal(articles[0].source, SOURCE.name);
});

test('feed transport rejects nonpublic DNS answers, including mixed address sets', async (t) => {
  const requests = mockTransport(t, [{}], [
    { address: '93.184.215.14', family: 4 },
    { address: '10.20.30.40', family: 4 },
  ]);
  await assert.rejects(fetchRSSFeed(SOURCE), /public|destination/i);
  assert.equal(requests[0].response, undefined);
});

test('every redirect destination is revalidated before connection', async (t) => {
  const requests = mockTransport(t, [{ status: 302, headers: { location: 'http://127.0.0.1/feed' } }]);
  await assert.rejects(fetchRSSFeed(SOURCE), /public|destination/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].response.destroyed, true);
});

test('redirect hostname resolution is validated at its own connection', async (t) => {
  const requests = mockTransport(t, [
    { status: 302, headers: { location: 'https://redirect.example.com/feed' } },
    {},
  ], (hostname) => [{ address: hostname.startsWith('redirect.') ? '192.168.2.3' : '93.184.215.14', family: 4 }]);
  await assert.rejects(fetchRSSFeed(SOURCE), /public|destination/i);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].response, undefined);
});

test('relative redirects retain support while redirect count stays bounded', async (t) => {
  const requests = mockTransport(t, [
    { status: 302, headers: { location: '/moved.xml' } },
    { status: 302, headers: { location: '/again.xml' } },
  ]);
  await assert.rejects(fetchFeedXml(SOURCE.url, { maxRedirects: 1 }), /redirect/i);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.pathname, '/moved.xml');
  assert.ok(requests.every(({ response }) => response.destroyed));
});

test('normal redirect cleanup is not mistaken for an upstream abort', async (t) => {
  const requests = mockTransport(t, [
    { status: 302, headers: { location: '/moved.xml' }, abortOnDestroy: true },
    {},
  ]);
  assert.equal(await fetchFeedXml(SOURCE.url), XML);
  assert.equal(requests.length, 2);
});

test('actual socket peer must remain a public address', async (t) => {
  const requests = mockTransport(t, [{ remoteAddress: '10.20.30.40' }]);
  await assert.rejects(fetchFeedXml(SOURCE.url), /public|destination/i);
  assert.equal(requests[0].req.destroyed, true);
  assert.equal(requests[0].response, undefined);
});

test('late errors from deliberately discarded redirects do not cancel the next hop', async (t) => {
  mockTransport(t, [
    { status: 302, headers: { location: '/moved.xml' }, lateErrorOnDestroy: true },
    {},
  ]);
  assert.equal(await fetchFeedXml(SOURCE.url), XML);
});

test('declared and streamed feed bodies are limited in bytes', async (t) => {
  const requests = mockTransport(t, [
    { headers: { 'content-length': '50' }, chunks: [] },
    { chunks: [Buffer.alloc(12), Buffer.alloc(12)] },
  ]);
  await assert.rejects(fetchFeedXml(SOURCE.url, { maxBytes: 20 }), /body|size|byte/i);
  await assert.rejects(fetchFeedXml(SOURCE.url, { maxBytes: 20 }), /body|size|byte/i);
  assert.ok(requests.every(({ response }) => response.destroyed));
});

test('deadline destroys requests waiting for headers and stalled response bodies', async (t) => {
  const requests = mockTransport(t, [{ wait: true }, { stall: true }]);
  await assert.rejects(fetchFeedXml(SOURCE.url, { timeoutMs: 20 }), /timed out|deadline/i);
  await assert.rejects(fetchFeedXml(SOURCE.url, { timeoutMs: 20 }), /timed out|deadline/i);
  assert.ok(requests.every(({ req }) => req.destroyed));
  assert.equal(requests[1].response.destroyed, true);
});

test('deadline includes DNS resolution', async (t) => {
  const requests = mockTransport(t, [{}]);
  t.mock.method(dns, 'lookup', () => {});
  await assert.rejects(fetchFeedXml(SOURCE.url, { timeoutMs: 20 }), /timed out|deadline/i);
  assert.equal(requests[0].req.destroyed, true);
});

test('aborted and non-success responses fail rather than parse partial XML', async (t) => {
  const requests = mockTransport(t, [{ status: 503 }, { aborted: true }]);
  await assert.rejects(fetchFeedXml(SOURCE.url), /503/);
  await assert.rejects(fetchFeedXml(SOURCE.url), /aborted/);
  assert.equal(requests[0].response.destroyed, true);
  assert.equal(requests[1].response.destroyed, true);
});
