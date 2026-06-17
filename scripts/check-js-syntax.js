const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_DIRS = ['scripts', 'test'];
const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function toRelativePath(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function listJavaScriptFiles(repoRoot, dirs = DEFAULT_DIRS) {
  const files = [];

  function visit(entryPath) {
    if (!fs.existsSync(entryPath)) {
      return;
    }

    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      fs.readdirSync(entryPath)
        .sort()
        .forEach((entry) => visit(path.join(entryPath, entry)));
      return;
    }

    if (stat.isFile() && JS_EXTENSIONS.has(path.extname(entryPath))) {
      files.push(entryPath);
    }
  }

  dirs.forEach((dir) => visit(path.join(repoRoot, dir)));
  return files.sort((a, b) => toRelativePath(repoRoot, a).localeCompare(toRelativePath(repoRoot, b)));
}

function checkJavaScriptSyntax({ repoRoot = path.join(__dirname, '..'), files } = {}) {
  const targets = files || listJavaScriptFiles(repoRoot);
  const checkedFiles = [];
  const failures = [];

  targets.forEach((filePath) => {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(repoRoot, filePath);
    const relativePath = toRelativePath(repoRoot, absolutePath);
    checkedFiles.push(relativePath);

    const result = spawnSync(process.execPath, ['--check', absolutePath], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      const details = (result.stderr || result.stdout || '').trim();
      failures.push(`${relativePath}: ${details}`);
    }
  });

  return {
    valid: failures.length === 0,
    failures,
    checkedFiles,
  };
}

function runCli() {
  const result = checkJavaScriptSyntax();

  if (!result.valid) {
    console.error('JavaScript syntax check failed:');
    result.failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }

  console.log(`JavaScript syntax check passed for ${result.checkedFiles.length} files.`);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  checkJavaScriptSyntax,
  listJavaScriptFiles,
};
