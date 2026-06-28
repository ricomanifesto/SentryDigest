const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(__dirname, '../.github/workflows/update-news.yml');
const gitignorePath = path.join(__dirname, '../.gitignore');
const lockfilePath = path.join(__dirname, '../package-lock.json');

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

test('update workflow installs dependencies from the lockfile', () => {
  const workflow = readWorkflow();
  const gitignore = fs.readFileSync(gitignorePath, 'utf8');

  assert.equal(fs.existsSync(lockfilePath), true);
  assert.doesNotMatch(gitignore, /^package-lock\.json\s*$/m);
  assert.doesNotMatch(workflow, /^\s*run: npm install\s*$/m);
  assert.match(workflow, /^\s*run: npm ci\s*$/m);
});

test('update workflow declares minimum token permissions for artifact commits', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /^permissions:\n\s+contents: write\s*$/m);
});

test('update workflow serializes generated artifact updates', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /^concurrency:\n\s+group: update-news\n\s+cancel-in-progress: false\n\s+queue: max\s*$/m);
});

test('update workflow refreshes the branch before generating artifacts', () => {
  const workflow = readWorkflow();

  assert.match(
    workflow,
    /- name: Refresh branch head\n\s+run: git pull --ff-only origin "\$GITHUB_REF_NAME"\s*\n\s+- name: Set up Node\.js/
  );
});

test('update workflow uses the artifact validation command before committing', () => {
  const workflow = readWorkflow();

  assert.match(
    workflow,
    /- name: Validate generated artifacts\n\s+run: npm run validate\s*\n\s+- name: Configure Git/
  );
  assert.doesNotMatch(
    workflow,
    /- name: Validate generated artifacts\n\s+run: npm test\s*\n\s+- name: Configure Git/
  );
});
