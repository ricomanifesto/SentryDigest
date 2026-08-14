const fs = require('node:fs');
const path = require('node:path');

const {
  assertCurrentInsightFindings,
  CURRENT_FINDINGS_URL,
  getCurrentInsightCves,
} = require('./current-insight-findings');

async function syncCurrentInsightFindings(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const outputPath = options.outputPath || path.join(__dirname, '../sentryinsight-findings.json');
  const now = options.now || new Date();
  const logger = options.logger || console;

  try {
    const response = await fetchImpl(CURRENT_FINDINGS_URL, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`SentryInsight returned HTTP ${response.status}`);
    }
    const manifest = assertCurrentInsightFindings(await response.json());
    if (getCurrentInsightCves(manifest, now) === null) {
      throw new Error(`SentryInsight report ${manifest.report_date} is not current`);
    }
    let existingManifest = null;
    if (fs.existsSync(outputPath)) {
      try {
        existingManifest = assertCurrentInsightFindings(
          JSON.parse(fs.readFileSync(outputPath, 'utf8')),
        );
      } catch {
        existingManifest = null;
      }
    }
    if (existingManifest
        && (existingManifest.report_date > manifest.report_date
          || (existingManifest.report_date === manifest.report_date
            && existingManifest.generated_at > manifest.generated_at))) {
      logger.warn(
        `Ignoring older SentryInsight findings ${manifest.generated_at}; retaining ${existingManifest.generated_at}`,
      );
      return { changed: false, retained: true, manifest: existingManifest };
    }
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    if (fs.existsSync(outputPath) && fs.readFileSync(outputPath, 'utf8') === content) {
      logger.log(`Current SentryInsight findings already match ${manifest.report_date}`);
      return { changed: false, retained: false, manifest };
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.tmp`;
    fs.writeFileSync(temporaryPath, content);
    fs.renameSync(temporaryPath, outputPath);
    logger.log(`Updated current SentryInsight findings for ${manifest.report_date}`);
    return { changed: true, retained: false, manifest };
  } catch (error) {
    let retained = false;
    if (fs.existsSync(outputPath)) {
      try {
        assertCurrentInsightFindings(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
        retained = true;
      } catch {
        retained = false;
      }
    }
    logger.warn(
      retained
        ? `Could not refresh current SentryInsight findings; retaining last-known-good snapshot: ${error.message}`
        : `Could not load current SentryInsight findings; CVE handoffs will use the established fallback: ${error.message}`,
    );
    return { changed: false, retained, manifest: null };
  }
}

async function main() {
  await syncCurrentInsightFindings();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error syncing SentryInsight findings: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { syncCurrentInsightFindings };
