# SentryDigest

Aggregates cybersecurity news from multiple RSS sources into a single dashboard. Updates every 3 hours via GitHub Actions.

**[Live Dashboard](https://ricomanifesto.github.io/SentryDigest/)** | **[RSS Feed](https://ricomanifesto.github.io/SentryDigest/rss.xml)**

## Adding Sources

Edit `config/news-sources.json` to add RSS feeds. The workflow rebuilds automatically on commit.

## Tech Stack

- Node.js scripts for RSS parsing and HTML generation
- GitHub Actions for automated updates
- GitHub Pages for hosting
