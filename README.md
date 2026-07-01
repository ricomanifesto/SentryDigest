# SentryDigest

<p align="center">
  <img src="assets/logo.png" alt="SentryDigest Logo" width="400">
</p>

SentryDigest turns noisy security feeds into a daily analyst-ready briefing, with source links, severity cues, and clean HTML output you can inspect before sharing.

**[Live Dashboard](https://ricomanifesto.github.io/SentryDigest/)**

## What It Does

SentryDigest collects security news from multiple RSS sources, normalizes the feed data, and publishes a browsable dashboard plus RSS output. It is built for quick review: source names, links, timestamps, ordering, and generated artifacts stay visible and testable.

## Sources

- Krebs on Security
- The Hacker News
- Threatpost
- Bleeping Computer
- Dark Reading

Sources are configured in `config/news-sources.json`.

## Outputs

- `index.html` - generated dashboard
- `feed.xml` - generated RSS feed
- `news-data.json` - normalized news data
- `feed-info.json` - feed metadata

## Automation

The GitHub Actions workflow runs on a schedule, on source configuration changes, and by manual trigger. Successful updates can dispatch downstream analysis in:

- [SentryInsight](https://github.com/ricomanifesto/SentryInsight)
- [GRCInsight](https://github.com/ricomanifesto/GRCInsight)

## Setup

```bash
git clone https://github.com/ricomanifesto/SentryDigest.git
cd SentryDigest
npm install
```

## Usage

```bash
npm run fetch
npm run generate-rss
npm test
```

`npm run fetch` fetches news and generates the dashboard artifacts. `npm run generate-rss` writes the RSS feed. `npm test` validates the generated output before publishing.

## Configuration

Define sources in `config/news-sources.json`:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "type": "rss",
  "enabled": true
}
```

Set `maxNewsItems` to control the generated item count. The workflow rebuilds when source configuration changes.

## Validation

`npm test` runs the Node test suite, checks JavaScript syntax, and performs dependency-free artifact validation. The artifact validator verifies that `news-data.json`, `feed.xml`, `feed-info.json`, and `index.html` agree on item counts, dates, URLs, enabled source names, and newest-first ordering.
