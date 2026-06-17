const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { checkJavaScriptSyntax } = require('../scripts/check-js-syntax');

function createTempFile(name, contents) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sentrydigest-js-'));
  const filePath = path.join(repoRoot, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return { repoRoot, filePath };
}

test('checkJavaScriptSyntax passes valid JavaScript files', () => {
  const { repoRoot, filePath } = createTempFile('scripts/valid.js', 'const answer = 42;\n');

  const result = checkJavaScriptSyntax({ repoRoot, files: [filePath] });

  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.checkedFiles, ['scripts/valid.js']);
});

test('checkJavaScriptSyntax reports invalid JavaScript files', () => {
  const { repoRoot, filePath } = createTempFile('scripts/invalid.js', 'function broken( {\n');

  const result = checkJavaScriptSyntax({ repoRoot, files: [filePath] });

  assert.equal(result.valid, false);
  assert.equal(result.checkedFiles.length, 1);
  assert.match(result.failures.join('\n'), /scripts\/invalid\.js/);
  assert.match(result.failures.join('\n'), /SyntaxError/);
});
