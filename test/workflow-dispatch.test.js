const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(__dirname, '../.github/workflows/update-news.yml');

function readWorkflow() {
  return fs.readFileSync(workflowPath, 'utf8');
}

test('update workflow dispatches the committed artifact SHA downstream', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /echo "commit_sha=\$\(git rev-parse HEAD\)" >> \$GITHUB_OUTPUT/);
  assert.doesNotMatch(workflow, /"sha": "\$\{\{ github\.sha \}\}"/);
  assert.equal(
    (workflow.match(/"sha": "\$\{\{ steps\.commit\.outputs\.commit_sha \}\}"/g) || []).length,
    2
  );
});

test('update workflow only stages generated artifacts and config metadata', () => {
  const workflow = readWorkflow();
  const generatedFiles = [
    'index.html',
    'news-data.json',
    'feed.xml',
    'feed-info.json',
    'config/news-sources.json',
  ];

  assert.doesNotMatch(workflow, /^\s*git add \.\s*$/m);
  assert.match(workflow, new RegExp(`^\\s*git add ${generatedFiles.join(' ')}\\s*$`, 'm'));
});
