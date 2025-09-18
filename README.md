# SentryDigest

<p align="center">
  <img src="assets/logo.png" alt="SentryDigest Logo" width="400">
</p>

Cybersecurity news aggregator that pulls from multiple RSS sources into one dashboard. Updates every 3 hours via GitHub Actions.

**[Live Dashboard](https://ricomanifesto.github.io/SentryDigest/)**

## Sources

- Krebs on Security
- The Hacker News
- Threatpost
- Bleeping Computer
- Dark Reading
- ZDNet Security

## Setup

```bash
git clone https://github.com/ricomanifesto/SentryDigest.git
cd SentryDigest
npm install
```

Manual run:
```bash
npm run fetch          # Fetch news, generate HTML
npm run generate-rss    # Generate RSS feed
```

## Configuration

Add sources in `config/news-sources.json`:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "type": "rss",
  "enabled": true
}
```

Workflow rebuilds on config changes. Adjust `maxNewsItems` to control article count.

## Automation

Runs:
- Every 3 hours
- On `news-sources.json` changes
- Manual trigger via GitHub Actions

Updates trigger [SentryInsight](https://github.com/ricomanifesto/SentryInsight) analysis.

## Output

- `index.html` - Dashboard
- `feed.xml` - RSS feed
- `news-data.json` - Raw data
- `feed-info.json` - Metadata
