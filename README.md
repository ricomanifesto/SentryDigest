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

Set the API key as an environment variable:

```bash
export VIRUSTOTAL_API_KEY="<your_vt_ti_enterprise_key>"
npm run fetch
```

Notes:
- API: VirusTotal v3 with `x-apikey`.
- Source: Collections API filtered by `collection_type:campaign`.
- Recency: sort/filter by `last_seen`, then `last_modification_date`, then `creation_date`, then `first_seen`; include within `daysWindow`; if none, return top recent.
- Output: title, campaign link, date, summary.

Direct campaigns mode
- Default endpoint: `/collections?filter=collection_type:campaign`. Override with `options.campaignsEndpoint` if your tenant differs (e.g., `/intelligence/campaigns`).

Troubleshoot endpoint
Test your tenant and set `options.campaignsEndpoint` if needed:
```bash
curl -s -H "x-apikey: $VIRUSTOTAL_API_KEY" "https://www.virustotal.com/api/v3/collections?filter=collection_type:campaign&limit=1"
```

### Ensure VT items appear

Reserve slots per source in `settings`:

```json
{
  "settings": {
    "maxNewsItems": 30,
    "sourceMinItems": { "VirusTotal TI": 3 }
  }
}
```

This enforces a floor for VT campaigns without raising the global cap.

API docs: https://gtidocs.virustotal.com/reference/api-responses

GitHub Actions:
- Add repository secret `VIRUSTOTAL_API_KEY` with your key.
- The workflow injects it when running `scripts/fetch-news.js`.

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
