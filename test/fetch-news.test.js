const assert = require('node:assert/strict');
const test = require('node:test');

const { generateHTML } = require('../scripts/fetch-news');

test('generateHTML escapes feed-controlled article fields', () => {
  const html = generateHTML([
    {
      title: '<img src=x onerror=alert(1)>',
      link: 'https://example.com/story?x="bad"',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example <Security>',
      summary: '<script>alert("bad")</script>',
    },
  ]);

  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Example &lt;Security&gt;/);
});

test('generateHTML renders unsafe article links as inert anchors', () => {
  const html = generateHTML([
    {
      title: 'Unsafe link',
      link: 'javascript:alert(1)',
      date: new Date('2026-06-17T18:00:00.000Z'),
      source: 'Example Security',
      summary: 'Story',
    },
  ]);

  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="#"/);
});
