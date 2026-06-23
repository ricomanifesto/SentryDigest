function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function safeArticleLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.toString();
    }
  } catch {
    // Invalid feed links render as inert anchors.
  }
  return '#';
}

const TOPIC_RULES = [
  { label: 'Ransomware', pattern: /\b(ransomware|extortion|encryptor)\b/i },
  { label: 'Vulnerability', pattern: /\b(cve-\d{4}-\d+|vulnerabilities|vulnerability|zero-day|0-day|flaw|patch|patched|critical bug)\b/i },
  { label: 'Exploitation', pattern: /\b(exploit|exploited|exploiting|exploitation|in the wild|active attacks?)\b/i },
  { label: 'Data Breach', pattern: /\b(data breach|breach|leak|stolen data|exposed data|compromised)\b/i },
  { label: 'Identity', pattern: /\b(identity|credential|password|oauth|sso|mfa|phishing)\b/i },
  { label: 'Cloud', pattern: /\b(cloud|aws|azure|gcp|kubernetes|container)\b/i },
  { label: 'Malware', pattern: /\b(malware|trojan|backdoor|loader|spyware|botnet)\b/i },
  { label: 'Supply Chain', pattern: /\b(supply chain|dependency|package|npm|pypi|github actions?)\b/i },
  { label: 'Compliance', pattern: /\b(compliance|regulator|regulation|privacy|gdpr|sec\b|audit)\b/i },
  { label: 'AI Security', pattern: /\b(ai|llm|machine learning|prompt injection|model)\b/i },
];

const VENDOR_RULES = [
  { label: 'Microsoft', pattern: /\b(microsoft|windows|microsoft exchange|azure|entra|office 365|m365)\b/i },
  { label: 'Google', pattern: /\b(google|android|chrome|gmail|workspace|gcp)\b/i },
  { label: 'Apple', pattern: /\b(apple|ios|macos|safari|iphone|ipad)\b/i },
  { label: 'Cisco', pattern: /\b(cisco|ios xe|asa|ftd|duo)\b/i },
  { label: 'Fortinet', pattern: /\b(fortinet|fortigate|fortios)\b/i },
  { label: 'Palo Alto', pattern: /\b(palo alto|pan-os|globalprotect)\b/i },
  { label: 'Okta', pattern: /\b(okta|auth0)\b/i },
  { label: 'AWS', pattern: /\b(aws|amazon web services)\b/i },
  { label: 'Kubernetes', pattern: /\b(kubernetes|k8s)\b/i },
  { label: 'VMware', pattern: /\b(vmware|vcenter|esxi)\b/i },
  { label: 'Ivanti', pattern: /\b(ivanti|connect secure|pulse secure)\b/i },
  { label: 'Atlassian', pattern: /\b(atlassian|confluence|jira|bitbucket)\b/i },
  { label: 'GitHub', pattern: /\b(github|gitlab actions?)\b/i },
  { label: 'OpenAI', pattern: /\b(openai|chatgpt)\b/i },
];

const SOURCE_SIGNAL_RULES = [
  { label: 'Vendor advisory', pattern: /\b(microsoft|google|apple|cisco|fortinet|palo alto|okta|aws|amazon|github|atlassian|vmware|ivanti|openai)\b/i },
  { label: 'Research team', pattern: /\b(unit 42|talos|mandiant|threat intelligence|research|labs|team)\b/i },
  { label: 'Industry media', pattern: /\b(securityweek|bleepingcomputer|the hacker news|dark reading|krebsonsecurity|wired|therecord)\b/i },
];

function matchesRule(text, rule) {
  return rule.pattern.test(text);
}

function deriveArticleFacets(article) {
  const safeLink = safeArticleLink(article.link);
  const host = safeLink === '#' ? '' : new URL(safeLink).hostname.replace(/^www\./, '');
  const text = `${article.title || ''} ${article.summary || ''} ${article.source || ''} ${host}`;
  const tags = TOPIC_RULES.filter((rule) => matchesRule(text, rule)).map((rule) => rule.label).slice(0, 4);
  const vendors = VENDOR_RULES.filter((rule) => matchesRule(text, rule)).map((rule) => rule.label).slice(0, 3);
  const sourceSignal = SOURCE_SIGNAL_RULES.find((rule) => matchesRule(`${article.source || ''} ${host}`, rule))?.label || 'General source';
  const criticalPattern = /\b(ransomware|zero-day|0-day|actively exploited|active exploitation|in the wild|critical bug|critical vulnerability|critical vulnerabilities|data breach|breach)\b/i;
  const elevatedPattern = /\b(cve-\d{4}-\d+|vulnerabilities|vulnerability|flaw|exploited|exploiting|exploitation|malware|phishing|patch|patched|compromised|supply chain)\b/i;
  const severity = criticalPattern.test(text) ? 'Critical' : elevatedPattern.test(text) ? 'Elevated' : 'Monitor';

  return {
    severity,
    tags,
    vendors,
    sourceSignal,
  };
}

function formatArticleDate(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function renderArticleCard(article) {
  const articleLink = safeArticleLink(article.link);
  const facets = deriveArticleFacets(article);
  const hostname = (() => {
    try {
      return new URL(articleLink).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const isNew = (Date.now() - new Date(article.date).getTime()) < (24 * 60 * 60 * 1000);
  const dateText = formatArticleDate(article.date);
  const dateIso = new Date(article.date).toISOString();
  const safeSource = escapeHtml(article.source);
  const safeSourceAttr = escapeAttribute(article.source);
  const safeHost = escapeHtml(hostname);
  const safeHostAttr = escapeAttribute(hostname);
  const safeTitle = escapeHtml(article.title);
  const safeTitleAttr = escapeAttribute(article.title);
  const safeSummary = escapeHtml(article.summary);
  const safeSummaryAttr = escapeAttribute(article.summary);
  const safeLink = escapeAttribute(articleLink);
  const safeSeverity = escapeHtml(facets.severity);
  const safeSeverityAttr = escapeAttribute(facets.severity);
  const safeSeverityClass = escapeAttribute(facets.severity.toLowerCase());
  const safeSourceSignal = escapeHtml(facets.sourceSignal);
  const safeSourceSignalAttr = escapeAttribute(facets.sourceSignal);
  const safeTagsAttr = escapeAttribute(facets.tags.join(','));
  const safeVendorsAttr = escapeAttribute(facets.vendors.join(','));
  const vendorChips = facets.vendors.map((vendor) => `<span class="chip">${escapeHtml(vendor)}</span>`).join('');
  const tagChips = facets.tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('');
  const hostChip = hostname ? `\n            <span class="chip">${safeHost}</span>` : '';
  const newBadge = isNew ? `\n            <span class="badge-new">NEW</span>` : '';
  const facetRow = (vendorChips || tagChips) ? `\n          <div class="facet-row">${vendorChips}${tagChips}</div>` : '';

  return `
        <article class="news-item" data-source="${safeSourceAttr}" data-host="${safeHostAttr}" data-title="${safeTitleAttr}" data-summary="${safeSummaryAttr}" data-severity="${safeSeverityAttr}" data-tags="${safeTagsAttr}" data-vendors="${safeVendorsAttr}" data-source-signal="${safeSourceSignalAttr}">
          <div class="chips">
            <span class="severity severity-${safeSeverityClass}">${safeSeverity}</span>
            <span class="chip"><span class="dot"></span>${safeSource}</span>${hostChip}
            <span class="chip">${safeSourceSignal}</span>
          </div>
          <h2 class="news-title"><a href="${safeLink}" target="_blank" rel="noopener">${safeTitle}</a></h2>
          <div class="news-meta">
            <time datetime="${dateIso}">${dateText}</time>${newBadge}
          </div>${facetRow}
          ${article.summary ? `<p class="news-summary">${safeSummary}</p>` : ''}
        </article>`;
}

function renderEmptyState() {
  return `
        <div class="news-item" style="grid-column: 1 / -1; text-align: center;">
          <h2>No news items found</h2>
          <p>No news could be fetched from the configured sources. This could be due to temporary feed issues or network problems. The site will try again on the next update cycle.</p>
        </div>
      `;
}

function generateHTML(newsItems) {
  const uniqueSources = Array.from(new Set(newsItems.map((article) => article.source)));
  const totalItems = newsItems.length;
  const sourceOptions = uniqueSources
    .map((source) => `<option value="${escapeAttribute(source)}">${escapeHtml(source)}</option>`)
    .join('');
  const nowIso = new Date().toISOString();
  const articleCards = newsItems.length > 0
    ? newsItems.map(renderArticleCard).join('')
    : renderEmptyState();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SentryDigest | Cybersecurity News</title>
  <meta name="description" content="Latest cybersecurity news from top sources">
  <link rel="alternate" type="application/rss+xml" title="Cybersecurity News RSS Feed" href="./feed.xml" />
  <link rel="icon" type="image/png" href="./assets/logo.png">
  <link rel="apple-touch-icon" href="./assets/logo.png">
  <style>
    :root { 
      --bg: #f7f8fa; 
      --fg: #1f2937; 
      --muted: #6b7280; 
      --card: #ffffff; 
      --card-border: #e5e7eb; 
      --accent: #2563eb; 
      --accent-contrast: #ffffff; 
      --chip: #e5e7eb;
    }
    [data-theme="dark"] {
      --bg: #0b1020;
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --card: #141b2f;
      --card-border: #26304a;
      --accent: #60a5fa;
      --accent-contrast: #0b1020;
      --chip: #1f2937;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: var(--fg); margin: 0; background: radial-gradient(1200px 600px at 20% -10%, rgba(37,99,235,.08), transparent 50%), var(--bg); }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    header.site-header { background: linear-gradient(180deg, rgba(37,99,235,0.15), rgba(37,99,235,0.0)); border-bottom: 1px solid var(--card-border); position: sticky; top: 0; z-index: 10; backdrop-filter: saturate(140%) blur(8px); }
    .masthead { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand img { width: 28px; height: 28px; border-radius: 6px; }
    .brand .title { font-weight: 700; letter-spacing: 0.2px; }
    .brand .subtitle { color: var(--muted); font-size: 0.9rem; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .search { display: flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--card-border); padding: 8px 10px; border-radius: 10px; }
    .search input { border: none; outline: none; background: transparent; color: var(--fg); min-width: 220px; }
    .select { border: 1px solid var(--card-border); background: var(--card); color: var(--fg); padding: 8px 10px; border-radius: 10px; }
    .btn { border: 1px solid var(--card-border); background: var(--card); color: var(--fg); padding: 8px 10px; border-radius: 10px; cursor: pointer; }
    .btn:hover { border-color: var(--accent); }
    .stats { color: var(--muted); font-size: 0.9rem; margin-top: 6px; }
    .news-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 18px; }
    .news-item { background: var(--card); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px; transition: transform .2s ease, box-shadow .2s ease; }
    .news-item:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(2,8,23,0.08); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); color: var(--fg); border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .severity { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
    .severity-critical { background: #fee2e2; color: #991b1b; }
    .severity-elevated { background: #fef3c7; color: #92400e; }
    .severity-monitor { background: #e0f2fe; color: #075985; }
    [data-theme="dark"] .severity-critical { background: rgba(239,68,68,0.18); color: #fecaca; }
    [data-theme="dark"] .severity-elevated { background: rgba(245,158,11,0.18); color: #fde68a; }
    [data-theme="dark"] .severity-monitor { background: rgba(14,165,233,0.18); color: #bae6fd; }
    .facet-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .news-title { font-size: 1.06rem; margin: 6px 0 8px; }
    .news-title a { color: var(--fg); text-decoration: none; }
    .news-title a:hover { text-decoration: underline; }
    .news-meta { color: var(--muted); font-size: 0.85rem; display: flex; gap: 8px; align-items: baseline; }
    .badge-new { color: #16a34a; font-weight: 600; font-size: 0.8rem; }
    .news-summary { margin-top: 8px; color: var(--fg); opacity: 0.9; }
    footer { border-top: 1px solid var(--card-border); color: var(--muted); font-size: 0.9rem; padding: 18px 0; margin-top: 22px; }
    @media (max-width: 640px) {
      .container { padding: 16px; }
      .masthead { align-items: stretch; flex-direction: column; }
      .controls { align-items: stretch; }
      .search { width: 100%; }
      .search input { min-width: 0; width: 100%; }
      .select, .btn { flex: 1 1 auto; }
      .news-container { grid-template-columns: minmax(0, 1fr); }
      .news-item { border-radius: 10px; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="container masthead">
      <div class="brand">
        <img src="./assets/logo.png" alt="SentryDigest" />
        <div>
          <div class="title">SentryDigest</div>
          <div class="subtitle">Cybersecurity News Aggregator</div>
        </div>
      </div>
      <div class="controls">
        <div class="search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="10.5" cy="10.5" r="7.5" stroke="currentColor" stroke-width="2"/></svg>
          <input id="search" type="text" placeholder="Search title or summary..." aria-label="Search" />
        </div>
        <select id="sourceFilter" class="select" aria-label="Filter by source">
          <option value="">All sources</option>
          ${sourceOptions}
        </select>
        <a class="btn" href="./feed.xml">RSS</a>
        <button id="themeToggle" class="btn" aria-label="Toggle theme">Theme</button>
      </div>
    </div>
  </header>

  <main class="container">
    <div class="stats" id="stats">Showing ${totalItems} of ${totalItems} articles from ${uniqueSources.length} sources • Last updated <time datetime="${nowIso}">${new Date().toLocaleString()}</time></div>

    <div class="news-container" id="newsContainer">
      ${articleCards}
    </div>
  </main>
  
  <footer>
    <div class="container">
      Powered by GitHub Actions • Updates every 3 hours • <a href="./feed.xml">RSS Feed</a>
    </div>
  </footer>

  <script>
    (function(){
      const root = document.documentElement;
      const themeKey = 'sentrydigest:theme';
      const saved = localStorage.getItem(themeKey);
      if (saved === 'dark' || (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        root.setAttribute('data-theme','dark');
      }
      const btn = document.getElementById('themeToggle');
      btn && btn.addEventListener('click', function(){
        const dark = root.getAttribute('data-theme') === 'dark';
        root.setAttribute('data-theme', dark ? 'light' : 'dark');
        localStorage.setItem(themeKey, dark ? 'light' : 'dark');
      });

      const q = (sel) => document.querySelector(sel);
      const qa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
      const search = q('#search');
      const filter = q('#sourceFilter');
      const stats = q('#stats');
      const cards = qa('.news-item');

      function update(){
        const term = (search && search.value || '').toLowerCase().trim();
        const src = filter && filter.value || '';
        let visible = 0;
        cards.forEach(card => {
          const matchesText = !term || (card.getAttribute('data-title').toLowerCase().includes(term) || card.getAttribute('data-summary').toLowerCase().includes(term));
          const matchesSource = !src || card.getAttribute('data-source') === src;
          const show = matchesText && matchesSource;
          card.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        const total = ${totalItems};
        const srcCount = ${uniqueSources.length};
        if (stats) stats.textContent = 'Showing ' + visible + ' of ' + total + ' articles from ' + srcCount + ' sources • Last updated ' + (new Date('${nowIso}').toLocaleString());
      }
      if (search) search.addEventListener('input', debounce(update, 120));
      if (filter) filter.addEventListener('change', update);
      update();

      function debounce(fn, wait){ let t; return function(){ clearTimeout(t); t=setTimeout(fn, wait); } }
    })();
  </script>
</body>
</html>
  `;
}

module.exports = {
  deriveArticleFacets,
  escapeHtml,
  formatArticleDate,
  generateHTML,
  renderArticleCard,
  safeArticleLink,
};
