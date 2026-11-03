# SentryDigest

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-lockup-dark.png">
    <img src="assets/logo-lockup-light.png" alt="SentryDigest" width="440">
  </picture>
</p>

SentryDigest collects security news from four RSS feeds and turns it into one short, source-linked briefing.

**[Read the latest digest](https://sentrydigest.ricomanifesto.com/)**

## What You Get

- A dashboard with the newest 30 items, timestamps, source links, and feed-health notes.
- An RSS feed at [`feed.xml`](https://sentrydigest.ricomanifesto.com/feed.xml).
- Dated issues under [`archive/`](https://sentrydigest.ricomanifesto.com/archive/) so old links keep their original context.
- Stable article links used by [SentryInsight](https://github.com/ricomanifesto/SentryInsight) and [GRCInsight](https://github.com/ricomanifesto/GRCInsight).

The current sources are Krebs on Security, The Hacker News, Bleeping Computer, and Dark Reading. Their URLs and enabled state live in [`config/news-sources.json`](config/news-sources.json).

## Run It Locally

Use Node.js 24 and install Chromium for the browser checks:

```bash
npm ci
npx playwright install chromium
```

Fetch the feeds and rebuild the published files:

```bash
npm run fetch
npm run generate-rss
npm run generate-archive
```

These commands update `index.html`, `news-data.json`, `feed.xml`, `feed-info.json`, and the dated archive. They require network access to the configured feeds.

## Configuration

Each entry in `config/news-sources.json` has this shape:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "type": "rss",
  "enabled": true,
  "lastContributedAt": null
}
```

`settings.maxNewsItems` sets the dashboard limit. The fetch job maintains `lastContributedAt`; leave it `null` when adding a source. A source is marked stale after 30 days without a new item.

## Automation

GitHub Actions runs every three hours, after source-configuration changes on `main`, or by manual trigger. A successful run rebuilds and validates the site. When the output changes, the workflow commits the generated files and tells SentryInsight and GRCInsight that a new digest is ready.

The cross-repository article-link rules live in [`contracts/README.md`](contracts/README.md).

## Validation

```bash
npm test
```

This runs unit tests, JavaScript syntax checks, generated-file validation, and Chromium tests at desktop and mobile sizes. It checks counts, dates, URLs, source health, archive links, downstream handoffs, ordering, and common reader-facing regressions.

## Static Artifact

`scripts/build-static-artifact.js` copies the committed public files of one commit into a self-contained static artifact. It fetches, generates and re-renders nothing, so every published byte equals the committed file. Pages, archives, feeds, JSON, assets, the license and the identity contract JSON are included. Scripts, tests, workflows, package files and the contract verifier are not. Any other tracked path must be classified before a build will run.

```bash
node scripts/build-static-artifact.js --revision "$(git rev-parse HEAD)" --output <store> --receipts <receipts-dir>
```

The store and the receipts directory must be outside the repository. Before a build is accepted, every JSON and XML file must parse and the artifact must pass that commit's own `scripts/validate-artifacts.js`. Each build is written once to `builds/<sha256>/`, holding `artifact/` and a prebuilt `deploy/.vercel/output/` layout whose config is only `{"version": 3}`. `current.json` names the accepted build. A failed, interrupted or concurrent build leaves the accepted build in place. A killed build leaves `.lock`, which an operator removes after confirming no builder is running.

`npm test` covers the builder and its loopback server with temporary repositories. To accept a built store:

```bash
STATIC_ARTIFACT_STORE=<store> STATIC_ARTIFACT_SOURCE=. node --test tests/static-artifact/*.test.js
STATIC_ARTIFACT_STORE=<store> npx playwright test -c playwright.artifact.config.js
```
