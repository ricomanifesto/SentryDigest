const cheerio = require('cheerio');

function normalizeFeedText(value) {
  let normalized = String(value ?? '');

  for (let pass = 0; pass < 3; pass += 1) {
    const document = cheerio.load(normalized, null, false);
    document('style, script, noscript, template').remove();
    document('br').replaceWith(' ');
    const decoded = document.text();
    if (decoded === normalized) {
      break;
    }
    normalized = decoded;
  }

  return normalized.replace(/\s+/g, ' ').trim();
}

function hasVirtualEventMarker(value) {
  const visibleText = normalizeFeedText(value).replace(/\\([\\\[\]])/g, '$1');
  return /\[\s*virtual\s+event\s*\]/i.test(visibleText);
}

function isVirtualEventPromotion(article) {
  if (hasVirtualEventMarker(article?.title) || hasVirtualEventMarker(article?.summary)) {
    return true;
  }
  try {
    const url = new URL(article?.link);
    return ['http:', 'https:'].includes(url.protocol)
      && ['darkreading.com', 'www.darkreading.com'].includes(url.hostname)
      && /^\/events\/virtual-event(?:-|\/|$)/i.test(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

function assertNoVirtualEventPromotions(articles) {
  if (articles.some(isVirtualEventPromotion)) {
    throw new Error('Virtual event promotions must be excluded as whole records');
  }
}

module.exports = { assertNoVirtualEventPromotions, isVirtualEventPromotion, normalizeFeedText };
