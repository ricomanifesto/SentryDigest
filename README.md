# SentryDigest

<p align="center">
  <img src="assets/logo.png" alt="SentryDigest Logo" width="400">
</p>

Cybersecurity news aggregator. Pulls multiple RSS sources into one dashboard. Updates every 3 hours via GitHub Actions.

**[Live Dashboard](https://ricomanifesto.github.io/SentryDigest/)**

## Sources

- Krebs on Security
- The Hacker News
- Threatpost
- Bleeping Computer
- Dark Reading
- Optional: VirusTotal TI (Threat Actor campaigns)

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

Define sources in `config/news-sources.json`:

```json
{
  "name": "Source Name",
  "url": "https://example.com/feed/",
  "type": "rss",
  "enabled": true
}
```

Workflow rebuilds on config changes. Set `maxNewsItems` to control count.

### VirusTotal TI (Enterprise) integration

Add a campaigns source in `config/news-sources.json`:

```json
{
  "name": "VirusTotal TI",
  "type": "virustotal",
  "mode": "campaigns",
  "enabled": true,
  "options": {
    "campaignsFetchLimit": 30,
    "daysWindow": 14,
    "campaignsEndpoint": null
  }
}
```

API docs: https://gtidocs.virustotal.com/reference/api-responses

## Automation

Runs:
- Every 3 hours
- On `news-sources.json` changes
- Manual trigger via GitHub Actions

Updates trigger [SentryInsight](https://github.com/ricomanifesto/SentryInsight) and [GRCInsight](https://github.com/ricomanifesto/GRCInsight) analysis.

## Output

- `index.html` - Dashboard
- `feed.xml` - RSS feed
- `news-data.json` - Raw data
- `feed-info.json` - Metadata
