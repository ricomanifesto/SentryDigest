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
  { label: 'Data Breach', pattern: /\b(data breach|breach|leaks?|leaked data|stolen data|stolen credentials?|steal credentials?|stealing credentials?|exposed data|credential theft)\b/i },
  { label: 'Identity', pattern: /\b(identity|credentials?|passwords?|oauth|sso|mfa|phishing)\b/i },
  { label: 'Cloud', pattern: /\b(cloud|aws|azure|gcp|kubernetes|container)\b/i },
  { label: 'Malware', pattern: /\b(malware|trojan|backdoor|loader|spyware|botnet)\b/i },
  { label: 'Supply Chain', pattern: /\b(supply chain|dependency confusion|dependency hijacking|dependency attack|dependency compromise|malicious packages?|backdoored packages?|compromised packages?|tampered packages?|npm|pypi|github actions?)\b/i },
  { label: 'Compliance', pattern: /\b(compliance|regulator|regulation|privacy|gdpr|sec\b|audit)\b/i },
  { label: 'AI Security', pattern: /\b(ai|llm|machine learning|prompt injection|model)\b/i },
];

const VENDOR_RULES = [
  { label: 'Microsoft', pattern: /\b(microsoft|windows|microsoft exchange|azure|entra|office 365|m365)\b/i },
  { label: 'Google', pattern: /\b(google|android|chrome|gmail|workspace|gcp)\b/i },
  { label: 'Apple', pattern: /\b(apple|macos|safari|iphone|ipad)\b/i },
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
  { label: 'Industry media', pattern: /\b(securityweek|bleepingcomputer|the hacker news|dark reading|krebsonsecurity|threatpost|wired|therecord)\b/i },
];

const HANDOFF_CUE_RULES = [
  {
    label: 'SentryInsight: incident watch',
    matches: ({ facets, text }) => (
      facets.severity === 'Critical'
      || facets.tags.some((tag) => ['Ransomware', 'Data Breach', 'Identity'].includes(tag))
      || /\b(incident response|intrusion|compromise|stolen credentials?|credential theft)\b/i.test(text)
    ),
  },
  {
    label: 'SentryInsight: vuln triage',
    matches: ({ facets, text }) => (
      facets.tags.some((tag) => ['Vulnerability', 'Exploitation'].includes(tag))
      || /\bcve-\d{4}-\d+\b/i.test(text)
    ),
  },
  {
    label: 'SentryInsight: vendor watch',
    matches: ({ facets }) => facets.vendors.length > 0 || facets.sourceSignal === 'Vendor advisory',
  },
  {
    label: 'GRCInsight: governance watch',
    matches: ({ facets, text }) => (
      facets.tags.includes('Compliance')
      || /\b(grc|governance|compliance|regulator|regulatory|privacy|gdpr|sec\b|filings?|audit)\b/i.test(text)
    ),
  },
];

const AGE_BUCKET_ORDER = ['Fresh', 'Recent', 'Older', 'Undated'];
const HANDOFF_CUE_ORDER = HANDOFF_CUE_RULES.map((rule) => rule.label).concat('SentryInsight: monitor');
const INVALID_FEED_DATE_FALLBACK_TIME = new Date('1970-01-01T00:00:00.000Z').getTime();
const OPERATOR_LANE_RULES = [
  {
    label: 'Incident watch',
    cue: 'SentryInsight: incident watch',
  },
  {
    label: 'Vulnerability triage',
    cue: 'SentryInsight: vuln triage',
  },
  {
    label: 'Governance watch',
    cue: 'GRCInsight: governance watch',
  },
];

function matchesRule(text, rule) {
  return rule.pattern.test(text);
}

function deriveSeverity(text, tags) {
  const criticalPattern = /\b(ransomware|zero-day|0-day|actively exploited|active exploitation|in the wild|critical bug|critical vulnerability|critical vulnerabilities|data breach|breach)\b/i;
  if (criticalPattern.test(text) || tags.includes('Ransomware') || tags.includes('Data Breach')) {
    return 'Critical';
  }

  const elevatedTags = ['Vulnerability', 'Exploitation', 'Identity', 'Malware', 'Supply Chain'];
  if (tags.some((tag) => elevatedTags.includes(tag))) {
    return 'Elevated';
  }

  return 'Monitor';
}

function deriveArticleFacets(article) {
  const safeLink = safeArticleLink(article.link);
  const host = safeLink === '#' ? '' : new URL(safeLink).hostname.replace(/^www\./, '');
  const text = `${article.title || ''} ${article.summary || ''} ${article.source || ''} ${host}`;
  const tags = TOPIC_RULES.filter((rule) => matchesRule(text, rule)).map((rule) => rule.label).slice(0, 4);
  const vendors = VENDOR_RULES.filter((rule) => matchesRule(text, rule)).map((rule) => rule.label).slice(0, 3);
  const sourceSignal = SOURCE_SIGNAL_RULES.find((rule) => matchesRule(`${article.source || ''} ${host}`, rule))?.label || 'General source';
  const severity = deriveSeverity(text, tags);

  return {
    severity,
    tags,
    vendors,
    sourceSignal,
  };
}

function deriveHandoffCues(article) {
  const safeLink = safeArticleLink(article.link);
  const host = safeLink === '#' ? '' : new URL(safeLink).hostname.replace(/^www\./, '');
  const text = `${article.title || ''} ${article.summary || ''} ${article.source || ''} ${host}`;
  const facets = deriveArticleFacets(article);
  const cues = HANDOFF_CUE_RULES
    .filter((rule) => rule.matches({ article, facets, text }))
    .map((rule) => rule.label);

  return cues.length > 0 ? cues : ['SentryInsight: monitor'];
}

function deriveAgeBucket(articleDate, generatedAt = new Date()) {
  const date = new Date(articleDate);
  const now = new Date(generatedAt);
  const dateTime = getArticleTime(articleDate);
  if (!Number.isFinite(dateTime) || dateTime === INVALID_FEED_DATE_FALLBACK_TIME || !Number.isFinite(now.getTime())) {
    return {
      label: 'Undated',
      detail: 'date unavailable',
    };
  }

  const ageMs = Math.max(0, now.getTime() - dateTime);
  const ageMinutes = Math.floor(ageMs / (60 * 1000));
  const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  const detail = ageHours < 1
    ? `${ageMinutes}m old`
    : ageHours < 24
      ? `${ageHours}h old`
      : `${ageDays}d old`;

  if (ageHours < 24) {
    return { label: 'Fresh', detail };
  }

  if (ageDays < 4) {
    return { label: 'Recent', detail };
  }

  return { label: 'Older', detail };
}

function getArticleTime(articleDate) {
  return new Date(articleDate).getTime();
}

function getSortableArticleTime(articleDate) {
  const articleTime = getArticleTime(articleDate);
  if (!Number.isFinite(articleTime) || articleTime === INVALID_FEED_DATE_FALLBACK_TIME) {
    return Number.NEGATIVE_INFINITY;
  }

  return articleTime;
}

function collectFacetFilterOptions(newsItems, generatedAt = new Date()) {
  const severities = new Set();
  const tags = new Set();
  const vendors = new Set();
  const ageBuckets = new Set();
  const handoffCues = new Set();

  newsItems.forEach((article) => {
    const facets = deriveArticleFacets(article);
    severities.add(facets.severity);
    facets.tags.forEach((tag) => tags.add(tag));
    facets.vendors.forEach((vendor) => vendors.add(vendor));
    ageBuckets.add(deriveAgeBucket(article.date, generatedAt).label);
    deriveHandoffCues(article).forEach((cue) => handoffCues.add(cue));
  });

  const severityOrder = ['Critical', 'Elevated', 'Monitor'];
  return {
    severities: severityOrder.filter((severity) => severities.has(severity)),
    tags: Array.from(tags).sort((left, right) => left.localeCompare(right)),
    vendors: Array.from(vendors).sort((left, right) => left.localeCompare(right)),
    ageBuckets: AGE_BUCKET_ORDER.filter((bucket) => ageBuckets.has(bucket)),
    handoffCues: HANDOFF_CUE_ORDER.filter((cue) => handoffCues.has(cue)),
  };
}

function collectSourceCoverage(newsItems) {
  const counts = new Map();
  newsItems.forEach((article) => {
    const source = article.source || 'Unknown source';
    counts.set(source, (counts.get(source) || 0) + 1);
  });

  return Array.from(counts.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source));
}

function collectOperatorLanes(newsItems) {
  return OPERATOR_LANE_RULES.map((lane) => {
    const matchingArticles = newsItems
      .filter((article) => deriveHandoffCues(article).includes(lane.cue))
      .sort((left, right) => getSortableArticleTime(right.date) - getSortableArticleTime(left.date));
    const latestArticle = matchingArticles[0];

    return {
      label: lane.label,
      count: matchingArticles.length,
      latestTitle: latestArticle ? latestArticle.title : '',
      latestLink: latestArticle ? safeArticleLink(latestArticle.link) : '#',
    };
  });
}

function renderSelectOptions(values) {
  return values
    .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`)
    .join('');
}

function renderSourceCoverage(newsItems) {
  const sourceCounts = collectSourceCoverage(newsItems);
  if (sourceCounts.length === 0) {
    return '';
  }

  const sourceCountItems = sourceCounts
    .map(({ source, count }) => `<span class="source-count" data-source="${escapeAttribute(source)}">${escapeHtml(source)} <strong>${count}</strong></span>`)
    .join('');

  return `<section class="source-coverage" aria-label="RSS source coverage">
      <div class="source-coverage-label">RSS source coverage</div>
      <div class="source-counts">${sourceCountItems}</div>
      <a href="./feed.xml">RSS feed</a>
    </section>`;
}

function renderOperatorLanes(newsItems) {
  const lanes = collectOperatorLanes(newsItems);
  if (lanes.every((lane) => lane.count === 0)) {
    return '';
  }

  const laneCards = lanes.map((lane) => {
    const safeLabel = escapeHtml(lane.label);
    const safeLabelAttr = escapeAttribute(lane.label);
    const safeLatestTitle = lane.latestTitle ? escapeHtml(lane.latestTitle) : 'No current match';
    const safeLatestLink = escapeAttribute(lane.latestLink || '#');
    const itemLabel = lane.count === 1 ? 'item' : 'items';

    return `<article class="operator-lane" data-lane="${safeLabelAttr}">
        <div class="operator-lane-heading">${safeLabel}</div>
        <span class="operator-lane-count"><strong>${lane.count}</strong> ${itemLabel}</span>
        <a href="${safeLatestLink}" class="operator-lane-link">${safeLatestTitle}</a>
      </article>`;
  }).join('');

  return `<section class="operator-lanes" aria-label="Operator scan lanes">
      ${laneCards}
    </section>`;
}

const SUMMARY_PREVIEW_LENGTH = 160;
const SUMMARY_WORD_BOUNDARY_MIN = 120;

function getSummaryPreview(summary) {
  const parts = getSummaryParts(summary);
  return parts ? `${parts.preview}...` : summary;
}

function getSummaryParts(summary) {
  if (summary.length <= SUMMARY_PREVIEW_LENGTH) {
    return null;
  }

  const preview = summary.slice(0, SUMMARY_PREVIEW_LENGTH);
  const lastSpace = preview.lastIndexOf(' ');
  const previewEnd = lastSpace > SUMMARY_WORD_BOUNDARY_MIN ? lastSpace : SUMMARY_PREVIEW_LENGTH;
  const previewText = preview.slice(0, previewEnd).trim();
  const remainder = summary.slice(previewText.length).trimStart();

  return {
    preview: previewText,
    remainder,
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

function renderSummary(summary, index) {
  if (!summary) {
    return '';
  }

  const safeSummary = escapeHtml(summary);
  if (summary.length <= SUMMARY_PREVIEW_LENGTH) {
    return `<p class="news-summary">${safeSummary}</p>`;
  }

  const summaryParts = getSummaryParts(summary);
  const safePreview = escapeHtml(summaryParts.preview);
  const safeRemainder = escapeHtml(summaryParts.remainder);
  return `<details class="summary-disclosure">
            <summary class="summary-toggle" aria-controls="summary-full-${index}">
              <span class="summary-preview-text">${safePreview}</span><span class="summary-ellipsis" aria-hidden="true">...</span>
              <span class="summary-action">Show full summary</span>
            </summary>
            <p class="news-summary summary-full" id="summary-full-${index}">${safeRemainder}</p>
          </details>`;
}

function renderArticleCard(article, index = 0, generatedAt = new Date()) {
  const articleLink = safeArticleLink(article.link);
  const facets = deriveArticleFacets(article);
  const handoffCues = deriveHandoffCues(article);
  const ageBucket = deriveAgeBucket(article.date, generatedAt);
  const hostname = (() => {
    try {
      return new URL(articleLink).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const articleTime = getArticleTime(article.date);
  const generatedAtTime = getArticleTime(generatedAt);
  const ageFromGeneratedAt = generatedAtTime - articleTime;
  const isNew = Number.isFinite(articleTime)
    && Number.isFinite(generatedAtTime)
    && ageFromGeneratedAt >= 0
    && ageFromGeneratedAt < (24 * 60 * 60 * 1000);
  const dateText = formatArticleDate(article.date);
  const dateIso = new Date(article.date).toISOString();
  const safeSource = escapeHtml(article.source);
  const safeSourceAttr = escapeAttribute(article.source);
  const safeHost = escapeHtml(hostname);
  const safeHostAttr = escapeAttribute(hostname);
  const safeTitle = escapeHtml(article.title);
  const safeTitleAttr = escapeAttribute(article.title);
  const safeSummaryAttr = escapeAttribute(article.summary);
  const safeLink = escapeAttribute(articleLink);
  const safeSeverity = escapeHtml(facets.severity);
  const safeSeverityAttr = escapeAttribute(facets.severity);
  const safeSeverityClass = escapeAttribute(facets.severity.toLowerCase());
  const safeSourceSignal = escapeHtml(facets.sourceSignal);
  const safeSourceSignalAttr = escapeAttribute(facets.sourceSignal);
  const safeTagsAttr = escapeAttribute(facets.tags.join(','));
  const safeVendorsAttr = escapeAttribute(facets.vendors.join(','));
  const safeHandoffCuesAttr = escapeAttribute(handoffCues.join(','));
  const safeAgeBucket = escapeHtml(ageBucket.label);
  const safeAgeBucketAttr = escapeAttribute(ageBucket.label);
  const safeAgeDetail = escapeHtml(ageBucket.detail);
  const vendorChips = facets.vendors.map((vendor) => `<span class="chip">${escapeHtml(vendor)}</span>`).join('');
  const tagChips = facets.tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('');
  const handoffCueChips = handoffCues.map((cue) => `<span class="handoff-cue">${escapeHtml(cue)}</span>`).join('');
  const hostChip = hostname ? `\n            <span class="chip">${safeHost}</span>` : '';
  const newBadge = isNew ? `\n            <span class="badge-new">NEW</span>` : '';
  const facetRow = (vendorChips || tagChips) ? `\n          <div class="facet-row">${vendorChips}${tagChips}</div>` : '';
  const handoffRow = `\n          <div class="handoff-row" aria-label="Downstream handoff cues">${handoffCueChips}</div>`;
  const summary = renderSummary(article.summary, index);

  return `
        <article class="news-item" data-source="${safeSourceAttr}" data-host="${safeHostAttr}" data-title="${safeTitleAttr}" data-summary="${safeSummaryAttr}" data-severity="${safeSeverityAttr}" data-tags="${safeTagsAttr}" data-vendors="${safeVendorsAttr}" data-source-signal="${safeSourceSignalAttr}" data-handoff-cues="${safeHandoffCuesAttr}" data-age-bucket="${safeAgeBucketAttr}">
          <div class="chips">
            <span class="severity severity-${safeSeverityClass}">${safeSeverity}</span>
            <span class="chip"><span class="dot"></span>${safeSource}</span>${hostChip}
            <span class="chip">${safeSourceSignal}</span>
            <span class="chip age-chip">${safeAgeBucket} - ${safeAgeDetail}</span>
          </div>
          <h2 class="news-title"><a href="${safeLink}" target="_blank" rel="noopener">${safeTitle}</a></h2>
          <div class="news-meta">
            <time datetime="${dateIso}">${dateText}</time>${newBadge}
          </div>${facetRow}${handoffRow}
          ${summary}
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

function generateHTML(newsItems, options = {}) {
  const generatedAt = options.generatedAt || new Date();
  const uniqueSources = Array.from(new Set(newsItems.map((article) => article.source)));
  const totalItems = newsItems.length;
  const filterOptions = collectFacetFilterOptions(newsItems, generatedAt);
  const sourceOptions = renderSelectOptions(uniqueSources);
  const severityOptions = renderSelectOptions(filterOptions.severities);
  const tagOptions = renderSelectOptions(filterOptions.tags);
  const vendorOptions = renderSelectOptions(filterOptions.vendors);
  const ageOptions = renderSelectOptions(filterOptions.ageBuckets);
  const handoffOptions = renderSelectOptions(filterOptions.handoffCues);
  const now = new Date(generatedAt);
  const nowIso = now.toISOString();
  const sourceCoverage = renderSourceCoverage(newsItems);
  const operatorLanes = renderOperatorLanes(newsItems);
  const articleCards = newsItems.length > 0
    ? newsItems.map((article, index) => renderArticleCard(article, index, generatedAt)).join('')
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
    .filter-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    .filter-status { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .active-filters { display: flex; flex-wrap: wrap; gap: 8px; }
    .active-filters[hidden] { display: none; }
    .active-filter-chip { background: var(--card); border: 1px solid var(--card-border); border-radius: 999px; color: var(--fg); font-size: 12px; padding: 4px 10px; }
    .search { display: flex; align-items: center; gap: 8px; background: var(--card); border: 1px solid var(--card-border); padding: 8px 10px; border-radius: 10px; }
    .search input { border: none; outline: none; background: transparent; color: var(--fg); min-width: 220px; }
    .select { border: 1px solid var(--card-border); background: var(--card); color: var(--fg); padding: 8px 10px; border-radius: 10px; }
    .btn { border: 1px solid var(--card-border); background: var(--card); color: var(--fg); padding: 8px 10px; border-radius: 10px; cursor: pointer; }
    .btn:hover { border-color: var(--accent); }
    .stats { color: var(--muted); font-size: 0.9rem; margin-top: 6px; }
    .filter-insights { align-items: center; background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; padding: 10px 12px; }
    .filter-insights[hidden] { display: none; }
    .filter-insights-label { color: var(--muted); font-size: 0.82rem; font-weight: 700; text-transform: uppercase; }
    .filter-insight-chip { background: var(--chip); border-radius: 999px; color: var(--fg); font-size: 12px; padding: 4px 10px; }
    .source-coverage { align-items: center; background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; display: flex; flex-wrap: wrap; gap: 10px 12px; margin-top: 12px; padding: 10px 12px; }
    .source-coverage-label { color: var(--muted); font-size: 0.82rem; font-weight: 700; text-transform: uppercase; }
    .source-counts { display: flex; flex: 1 1 260px; flex-wrap: wrap; gap: 8px; }
    .source-count { background: var(--chip); border-radius: 999px; color: var(--fg); font-size: 12px; padding: 4px 10px; }
    .source-count strong { color: var(--accent); margin-left: 4px; }
    .source-coverage a { color: var(--accent); font-size: 0.9rem; font-weight: 600; text-decoration: none; }
    .source-coverage a:hover { text-decoration: underline; }
    .operator-lanes { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 14px; }
    .operator-lane { background: var(--card); border: 1px solid var(--card-border); border-radius: 10px; display: grid; gap: 6px; padding: 12px; }
    .operator-lane-heading { font-size: 0.82rem; font-weight: 700; text-transform: uppercase; }
    .operator-lane-count { color: var(--muted); font-size: 0.85rem; }
    .operator-lane-count strong { color: var(--accent); }
    .operator-lane-link { color: var(--fg); font-size: 0.92rem; line-height: 1.35; text-decoration: none; }
    .operator-lane-link:hover { color: var(--accent); text-decoration: underline; }
    .empty-filtered { background: var(--card); border: 1px dashed var(--card-border); border-radius: 10px; color: var(--muted); margin-top: 18px; padding: 18px; text-align: center; }
    .empty-filtered[hidden] { display: none; }
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
    .handoff-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .handoff-cue { border: 1px solid var(--card-border); border-radius: 6px; color: var(--muted); display: inline-flex; font-size: 12px; padding: 3px 8px; }
    .news-title { font-size: 1.06rem; margin: 6px 0 8px; }
    .news-title a { color: var(--fg); text-decoration: none; }
    .news-title a:hover { text-decoration: underline; }
    .news-meta { color: var(--muted); font-size: 0.85rem; display: flex; gap: 8px; align-items: baseline; }
    .badge-new { color: #16a34a; font-weight: 600; font-size: 0.8rem; }
    .news-summary { margin-top: 8px; color: var(--fg); opacity: 0.9; }
    .summary-disclosure { margin-top: 8px; }
    .summary-toggle { color: var(--fg); cursor: pointer; font: inherit; font-size: 0.95rem; opacity: 0.9; }
    .summary-action { color: var(--accent); font-size: 0.9rem; margin-left: 6px; white-space: nowrap; }
    details[open] .summary-ellipsis { display: none; }
    details[open] .summary-action { display: none; }
    .summary-toggle:hover .summary-action { text-decoration: underline; }
    .summary-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    footer { border-top: 1px solid var(--card-border); color: var(--muted); font-size: 0.9rem; padding: 18px 0; margin-top: 22px; }
    @media (max-width: 640px) {
      .container { padding: 16px; }
      .masthead { align-items: stretch; flex-direction: column; }
      .controls { align-items: stretch; }
      .filter-row { align-items: stretch; flex-direction: column; }
      .filter-status { align-items: stretch; flex-direction: column; }
      .search { width: 100%; }
      .search input { min-width: 0; width: 100%; }
      .select, .btn { flex: 1 1 auto; }
      .operator-lanes { grid-template-columns: minmax(0, 1fr); }
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
    <div class="filter-row" aria-label="Article filters">
      <select id="severityFilter" class="select" aria-label="Filter by severity">
        <option value="">All severities</option>
        ${severityOptions}
      </select>
      <select id="tagFilter" class="select" aria-label="Filter by topic tag">
        <option value="">All topics</option>
        ${tagOptions}
      </select>
      <select id="vendorFilter" class="select" aria-label="Filter by affected vendor">
        <option value="">All vendors</option>
        ${vendorOptions}
      </select>
      <select id="ageFilter" class="select" aria-label="Filter by article age">
        <option value="">Any age</option>
        ${ageOptions}
      </select>
      <select id="handoffFilter" class="select" aria-label="Filter by downstream handoff cue">
        <option value="">All handoff cues</option>
        ${handoffOptions}
      </select>
    </div>
    <div class="filter-status" aria-label="Active filters">
      <div id="activeFilters" class="active-filters" hidden aria-live="polite"></div>
      <button id="resetFilters" class="btn reset-filters" type="button" hidden>Reset filters</button>
    </div>
    <div class="stats" id="stats">Showing ${totalItems} of ${totalItems} articles from ${uniqueSources.length} sources • Last updated <time datetime="${nowIso}">${now.toLocaleString()}</time></div>
    <div id="filterInsights" class="filter-insights" aria-live="polite"></div>
    ${sourceCoverage}
    ${operatorLanes}
    <div id="emptyFilteredState" class="empty-filtered" hidden>No articles match the current filters.</div>

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
      const sourceFilter = q('#sourceFilter');
      const severityFilter = q('#severityFilter');
      const tagFilter = q('#tagFilter');
      const vendorFilter = q('#vendorFilter');
      const ageFilter = q('#ageFilter');
      const handoffFilter = q('#handoffFilter');
      const emptyFilteredState = q('#emptyFilteredState');
      const activeFilters = q('#activeFilters');
      const resetFilters = q('#resetFilters');
      const filterInsights = q('#filterInsights');
      const stats = q('#stats');
      const cards = qa('.news-item');
      const filterParams = {
        search: 'q',
        sourceFilter: 'source',
        severityFilter: 'severity',
        tagFilter: 'tag',
        vendorFilter: 'vendor',
        ageFilter: 'age',
        handoffFilter: 'handoff',
      };
      const filterControls = {
        search,
        sourceFilter,
        severityFilter,
        tagFilter,
        vendorFilter,
        ageFilter,
        handoffFilter,
      };
      const filterLabels = {
        search: 'Search',
        sourceFilter: 'Source',
        severityFilter: 'Severity',
        tagFilter: 'Topic',
        vendorFilter: 'Vendor',
        ageFilter: 'Age',
        handoffFilter: 'Handoff',
      };

      function applyQueryState(){
        const params = new URLSearchParams(window.location.search);
        Object.keys(filterParams).forEach(function(key){
          const control = filterControls[key];
          if (!control) return;
          const value = params.get(filterParams[key]);
          if (value !== null) control.value = value;
        });
      }

      function syncQueryState(){
        if (!window.history || !window.history.replaceState) return;
        const params = new URLSearchParams(window.location.search);
        Object.keys(filterParams).forEach(function(key){
          const control = filterControls[key];
          const value = control && control.value || '';
          if (value) {
            params.set(filterParams[key], value);
          } else {
            params.delete(filterParams[key]);
          }
        });
        const nextSearch = params.toString();
        const nextUrl = window.location.pathname + (nextSearch ? '?' + nextSearch : '') + window.location.hash;
        window.history.replaceState(null, '', nextUrl);
      }

      function getControlLabel(control){
        if (!control) return '';
        if (control.tagName === 'SELECT' && control.selectedOptions && control.selectedOptions.length > 0) {
          return control.selectedOptions[0].textContent || control.value;
        }
        return control.value || '';
      }

      function renderActiveFilters(){
        if (!activeFilters) return;
        const activeFiltersList = Object.keys(filterControls)
          .map(function(key){
            const control = filterControls[key];
            const value = control && control.value || '';
            const label = getControlLabel(control);
            return value ? { key, label } : null;
          })
          .filter(Boolean);
        activeFilters.textContent = '';
        activeFilters.hidden = activeFiltersList.length === 0;
        if (resetFilters) resetFilters.hidden = activeFiltersList.length === 0;
        activeFiltersList.forEach(function(activeFilter){
          const key = activeFilter.key;
          const label = activeFilter.label;
          const chip = document.createElement('span');
          chip.className = 'active-filter-chip';
          chip.textContent = filterLabels[key] + ': ' + label;
          activeFilters.appendChild(chip);
        });
      }

      function incrementCount(counts, value){
        if (!value) return;
        counts[value] = (counts[value] || 0) + 1;
      }

      function collectListCounts(counts, rawValue){
        (rawValue || '').split(',').filter(Boolean).forEach(function(value){
          incrementCount(counts, value);
        });
      }

      function appendInsightGroup(label, counts, limit){
        const entries = Object.keys(counts)
          .map(function(value){ return { value, count: counts[value] }; })
          .sort(function(a, b){ return b.count - a.count || a.value.localeCompare(b.value); })
          .slice(0, limit);
        entries.forEach(function(entry){
          const chip = document.createElement('span');
          chip.className = 'filter-insight-chip';
          chip.textContent = label + ': ' + entry.value + ' ' + entry.count;
          filterInsights.appendChild(chip);
        });
      }

      function renderFilterInsights(visibleCards){
        if (!filterInsights) return;
        filterInsights.textContent = '';
        filterInsights.hidden = visibleCards.length === 0;
        if (visibleCards.length === 0) return;
        const label = document.createElement('span');
        label.className = 'filter-insights-label';
        label.textContent = 'Visible mix';
        filterInsights.appendChild(label);
        const severityCounts = {};
        const topicCounts = {};
        const vendorCounts = {};
        const handoffCounts = {};
        visibleCards.forEach(function(card){
          incrementCount(severityCounts, card.getAttribute('data-severity'));
          collectListCounts(topicCounts, card.getAttribute('data-tags'));
          collectListCounts(vendorCounts, card.getAttribute('data-vendors'));
          collectListCounts(handoffCounts, card.getAttribute('data-handoff-cues'));
        });
        appendInsightGroup('Severity', severityCounts, 3);
        appendInsightGroup('Topic', topicCounts, 3);
        appendInsightGroup('Vendor', vendorCounts, 3);
        appendInsightGroup('Handoff', handoffCounts, 2);
      }

      function update(){
        const term = (search && search.value || '').toLowerCase().trim();
        const src = sourceFilter && sourceFilter.value || '';
        const severity = severityFilter && severityFilter.value || '';
        const tag = tagFilter && tagFilter.value || '';
        const vendor = vendorFilter && vendorFilter.value || '';
        const age = ageFilter && ageFilter.value || '';
        const handoff = handoffFilter && handoffFilter.value || '';
        let visible = 0;
        const visibleCards = [];
        cards.forEach(card => {
          const matchesText = !term || (card.getAttribute('data-title').toLowerCase().includes(term) || card.getAttribute('data-summary').toLowerCase().includes(term));
          const matchesSource = !src || card.getAttribute('data-source') === src;
          const matchesSeverity = !severity || card.getAttribute('data-severity') === severity;
          const matchesTag = !tag || card.getAttribute('data-tags').split(',').filter(Boolean).includes(tag);
          const matchesVendor = !vendor || card.getAttribute('data-vendors').split(',').filter(Boolean).includes(vendor);
          const matchesAge = !age || card.getAttribute('data-age-bucket') === age;
          const matchesHandoff = !handoff || card.getAttribute('data-handoff-cues').split(',').filter(Boolean).includes(handoff);
          const show = matchesText && matchesSource && matchesSeverity && matchesTag && matchesVendor && matchesAge && matchesHandoff;
          card.style.display = show ? '' : 'none';
          if (show) {
            visible++;
            visibleCards.push(card);
          }
        });
        const total = ${totalItems};
        const srcCount = ${uniqueSources.length};
        if (stats) stats.textContent = 'Showing ' + visible + ' of ' + total + ' articles from ' + srcCount + ' sources • Last updated ' + (new Date('${nowIso}').toLocaleString());
        if (emptyFilteredState) emptyFilteredState.hidden = visible !== 0;
        renderActiveFilters();
        renderFilterInsights(visibleCards);
        syncQueryState();
      }
      if (search) search.addEventListener('input', debounce(update, 120));
      [sourceFilter, severityFilter, tagFilter, vendorFilter, ageFilter, handoffFilter].forEach(function(filter){
        if (filter) filter.addEventListener('change', update);
      });
      if (resetFilters) resetFilters.addEventListener('click', function(){
        Object.keys(filterControls).forEach(function(key){
          const control = filterControls[key];
          if (control) control.value = '';
        });
        update();
      });

      applyQueryState();
      update();

      function debounce(fn, wait){ let t; return function(){ clearTimeout(t); t=setTimeout(fn, wait); } }
    })();
  </script>
</body>
</html>
  `;
}

module.exports = {
  collectFacetFilterOptions,
  collectOperatorLanes,
  collectSourceCoverage,
  deriveAgeBucket,
  deriveArticleFacets,
  deriveHandoffCues,
  escapeHtml,
  formatArticleDate,
  generateHTML,
  getSummaryPreview,
  renderArticleCard,
  safeArticleLink,
};
