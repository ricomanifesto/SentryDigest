# SentryDigest

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-lockup-dark.png">
    <img src="assets/logo-lockup-light.png" alt="SentryDigest" width="440">
  </picture>
</p>

SentryDigest turns noisy security feeds into a daily analyst-ready briefing, with source links, severity cues, and clean HTML output you can inspect before sharing.

**[Live Dashboard](https://ricomanifesto.github.io/SentryDigest/)**

## What It Does

SentryDigest collects security news from multiple RSS sources, normalizes the feed data, and publishes a browsable dashboard plus RSS output. It is built for quick review: source names, links, timestamps, ordering, and generated artifacts stay visible and testable.

## Sources

- Krebs on Security
- The Hacker News
- Bleeping Computer
- Dark Reading

Sources are configured in `config/news-sources.json`.

## Outputs

- `index.html` - generated dashboard
- `feed.xml` - generated RSS feed
- `news-data.json` - normalized news data
- `feed-info.json` - feed metadata
- `archive/YYYY-MM-DD/` - retained UTC-day context with stable per-item links

## Automation

The GitHub Actions workflow runs on a schedule, on source configuration changes, and by manual trigger. Successful updates can dispatch downstream analysis in:

- [SentryInsight](https://github.com/ricomanifesto/SentryInsight)
- [GRCInsight](https://github.com/ricomanifesto/GRCInsight)

SentryDigest owns the versioned reporting-card identity used by those downstream handoffs. The [reporting identity runbook](contracts/README.md) defines immutable versioning, consumer adoption order, rollback behavior, and the current family gate inventory.

## Setup

```bash
git clone https://github.com/ricomanifesto/SentryDigest.git
cd SentryDigest
npm install
npx playwright install chromium
```

## Usage

```bash
npm run fetch
npm run generate-rss
npm run generate-archive
npm test
```

`npm run fetch` fetches news and generates the dashboard artifacts. `npm run generate-rss` writes the RSS feed. `npm run generate-archive` retains that run in the UTC-day archive and rebuilds stable article anchors. Truncated summaries include a source-named continuation link, and incident handoffs carry a complete CVE fragment when one is available. `npm test` validates the generated output and renders it in Chromium before publishing.

## Configuration

Define sources in `config/news-sources.json`:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "type": "rss",
  "enabled": true,
  "lastContributedAt": null
}
```

Set `maxNewsItems` to control the generated item count. The fetch job maintains `lastContributedAt`; leave it `null` for a newly added source. `feed-info.json` derives each source's `active`, `quiet`, `stale`, or `unobserved` status at generation time. A non-contributing source becomes stale after 30 days without changing its durable configuration history. The workflow rebuilds when source configuration changes.

## Validation

`npm test` runs the Node test suite, checks JavaScript syntax, validates the generated artifacts, and exercises the rendered page in Chromium. The validator checks cross-artifact counts, dates, URLs, source health, summary continuation destinations, contextual downstream handoffs, and newest-first ordering. It also rejects reader-facing regressions such as feed truncation markers, encoded title entities, hash-only controls, hollow summary disclosures, and unlabeled clock times. CI preserves desktop and mobile screenshots from the rendered-page gate.
