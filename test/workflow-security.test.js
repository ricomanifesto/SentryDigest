const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const readWorkflow = (name) => fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
const publisher = () => readWorkflow('publish-production.yml');
const ACTION_PINS = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node': '249970729cb0ef3589644e2896645e5dc5ba9c38',
  'actions/upload-artifact': 'cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  'peter-evans/repository-dispatch': '28959ce8df70de7be546dd1250a005dd32156697',
};

function provenanceShell() {
  const step = publisher().match(/      - name: Verify source provenance\n([\s\S]*?)(?=\n      - name:|$)/);
  assert.ok(step, 'publisher must verify provenance before selecting a source');
  const script = step[1].match(/        run: \|\n([\s\S]*)/);
  assert.ok(script, 'provenance must be runner shell, independent of requested repository code');
  return script[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
}

test('privileged workflow actions use the reviewed immutable upstream commits', () => {
  for (const file of ['publish-production.yml', 'update-news.yml']) {
    const uses = [...readWorkflow(file).matchAll(/^\s+uses: ([^\s#]+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0);
    for (const action of uses.filter((value) => !value.startsWith('./'))) {
      const [name, revision] = action.split('@');
      assert.equal(revision, ACTION_PINS[name], `${file}: ${name} must use its reviewed full commit`);
    }
    assert.match(readWorkflow(file), /package-manager-cache: false/);
  }
});

test('manual and reusable publisher paths and the producer jobs are main-only', () => {
  for (const [file, jobs] of [['publish-production.yml', ['publish']], ['update-news.yml', ['update-news', 'publish']]]) {
    const workflow = readWorkflow(file);
    for (const job of jobs) {
      assert.match(workflow, new RegExp(`^  ${job}:\\n    if: github\\.ref == 'refs/heads/main'\\n`, 'm'));
    }
  }
  assert.match(readWorkflow('update-news.yml'), /ref: refs\/heads\/main/);
  assert.match(readWorkflow('update-news.yml'), /git pull --ff-only origin main/);
  assert.match(readWorkflow('update-news.yml'), /git push origin HEAD:refs\/heads\/main/);
});

test('publisher validates before selected checkout, installs, tests or publisher code', () => {
  const workflow = publisher();
  const trustedCheckout = workflow.indexOf('- name: Checkout trusted main');
  const provenance = workflow.indexOf('- name: Verify source provenance');
  const verifiedCheckout = workflow.indexOf('- name: Checkout verified source');
  assert.ok(trustedCheckout >= 0 && provenance > trustedCheckout && verifiedCheckout > provenance);
  assert.match(workflow.slice(trustedCheckout, provenance), /ref: refs\/heads\/main\n\s+fetch-depth: 0\n\s+persist-credentials: false/);
  assert.match(workflow.slice(verifiedCheckout), /ref: \$\{\{ steps\.source\.outputs\.source_sha \}\}/);
  assert.match(workflow, /SOURCE_SHA: \$\{\{ steps\.source\.outputs\.source_sha \}\}/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ inputs\.source_sha/);
  assert.doesNotMatch(workflow.slice(0, verifiedCheckout), /\brun: (?:npm|node|npx)\b/);
  for (const command of ['run: npm ci', 'run: npm test', 'node publication/cli.js']) {
    assert.ok(workflow.indexOf(command) > verifiedCheckout, command);
  }
  assert.doesNotMatch(provenanceShell(), /\b(?:npm|node|npx|checkout)\b/);
});

function localWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream');
  const remote = path.join(root, 'remote.git');
  const runner = path.join(root, 'runner');
  const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  }).trim();
  fs.mkdirSync(upstream);
  git(root, 'init', '--bare', '--quiet', '--initial-branch=main', remote);
  git(upstream, 'init', '--quiet', '--initial-branch=main');
  git(upstream, 'config', 'user.name', 'Workflow test');
  git(upstream, 'config', 'user.email', 'workflow@example.invalid');
  git(upstream, 'remote', 'add', 'origin', remote);
  git(upstream, 'commit', '--quiet', '--allow-empty', '-m', 'Initial main');
  git(upstream, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  const eventSha = git(upstream, 'rev-parse', 'HEAD');
  git(root, 'clone', '--quiet', remote, runner);
  // The producer can push after this workflow's original event SHA was fixed.
  git(upstream, 'commit', '--quiet', '--allow-empty', '-m', 'Generated update');
  git(upstream, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  const generatedSha = git(upstream, 'rev-parse', 'HEAD');
  git(upstream, 'switch', '--quiet', '-c', 'other-source');
  git(upstream, 'commit', '--quiet', '--allow-empty', '-m', 'Other source');
  const otherSha = git(upstream, 'rev-parse', 'HEAD');
  git(upstream, 'push', '--quiet', 'origin', 'HEAD:refs/heads/other-source');
  git(runner, 'fetch', '--quiet', 'origin', 'refs/heads/other-source:refs/remotes/origin/other-source');
  const output = path.join(root, 'outputs');
  return {
    eventSha, generatedSha, otherSha,
    advanceMain() {
      git(upstream, 'switch', '--quiet', 'main');
      git(upstream, 'commit', '--quiet', '--allow-empty', '-m', 'Concurrent main update');
      git(upstream, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    },
    run({ invocation = 'publish', source = generatedSha, event = 'schedule' } = {}) {
      fs.writeFileSync(output, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', provenanceShell()], {
        cwd: runner, encoding: 'utf8',
        env: { ...process.env, INVOCATION: invocation, REQUESTED_SOURCE_SHA: source,
          EVENT_SOURCE_SHA: eventSha, EVENT_NAME: event, GITHUB_OUTPUT: output,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
      });
      return { ...result, outputs: fs.readFileSync(output, 'utf8'), head: git(runner, 'rev-parse', 'HEAD') };
    },
  };
}

test('provenance accepts the fresh producer commit and main ancestors despite a stale event SHA', (t) => {
  const world = localWorld(t);
  world.advanceMain();
  for (const source of [world.generatedSha, world.eventSha]) {
    const result = world.run({ source });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `source_sha=${source}\n`);
    assert.equal(result.head, world.eventSha, 'verification does not select requested code');
  }
  assert.equal(world.run({ source: '', event: 'push' }).outputs, `source_sha=${world.eventSha}\n`);
});

test('provenance rejects other branches, incomplete or unknown commits before selecting code', (t) => {
  const world = localWorld(t);
  for (const source of [world.otherSha, world.generatedSha.slice(0, 12), 'main', 'f'.repeat(40)]) {
    const result = world.run({ source });
    assert.notEqual(result.status, 0, source);
    if (source === world.otherSha) assert.match(result.stderr, /not part of trusted main history/);
    assert.equal(result.outputs, '', 'refused revisions are never exported for checkout');
    assert.equal(result.head, world.eventSha);
  }
});

test('manual publishing requires current main rather than a historical source override', (t) => {
  const world = localWorld(t);
  assert.equal(world.run({ source: world.generatedSha, event: 'workflow_dispatch' }).status, 0);
  assert.equal(world.run({ source: '', event: 'workflow_dispatch' }).outputs, `source_sha=${world.generatedSha}\n`);
  const stale = world.run({ source: world.eventSha, event: 'workflow_dispatch' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /current main/);
});

test('operational invocations use current trusted main and reject source overrides', (t) => {
  const world = localWorld(t);
  for (const invocation of ['resume', 'rollback', 'resolve', 'seed']) {
    const result = world.run({ invocation, source: '', event: 'workflow_dispatch' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs, `source_sha=${world.generatedSha}\n`);
    const override = world.run({ invocation, source: world.otherSha });
    assert.notEqual(override.status, 0, invocation);
    assert.equal(override.outputs, '');
  }
  assert.notEqual(world.run({ invocation: 'unknown', source: '' }).status, 0);
});
