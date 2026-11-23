const net = require('node:net');

const DEFAULT_MAX_NEWS_ITEMS = 30;
const nonPublicIpv4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublicIpv4.addSubnet(address, prefix, 'ipv4');
const globalIpv6 = new net.BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const nonPublicIpv6 = new net.BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) nonPublicIpv6.addSubnet(address, prefix, 'ipv6');

function isPublicIpAddress(address) {
  if (net.isIP(address) === 4) return !nonPublicIpv4.check(address, 'ipv4');
  return net.isIP(address) === 6
    && globalIpv6.check(address, 'ipv6')
    && !nonPublicIpv6.check(address, 'ipv6');
}

// This is the feed transport policy, separate from article-link validation.
// Hostnames are checked again through the socket's DNS lookup before connecting.
function assertPublicFeedUrl(value) {
  let url;
  try {
    if (typeof value !== 'string') throw new Error('not a string');
    url = new URL(value);
  } catch {
    throw new Error('Feed destination must be a public http(s) URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || (net.isIP(hostname) ? !isPublicIpAddress(hostname)
        : !hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(hostname))) {
    throw new Error('Feed destination must be a credential-free public http(s) URL');
  }
  url.hash = '';
  return url;
}

function fail(failures, message) {
  failures.push(message);
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeSourceName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function validateSourceConfig(config, failures = []) {
  const enabledRssSources = [];
  const enabledSourceNames = new Set();
  const enabledSourceUrls = new Set();
  let maxNewsItems = DEFAULT_MAX_NEWS_ITEMS;

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    fail(failures, 'config/news-sources.json must be an object');
    return { enabledRssSources, failures, maxNewsItems };
  }

  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    fail(failures, 'config/news-sources.json must define at least one source');
  } else {
    config.sources.forEach((source, index) => {
      const label = `config source ${index + 1}`;
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        fail(failures, `${label} must be an object`);
        return;
      }

      if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
        fail(failures, `${label} enabled must be a boolean`);
        return;
      }

      if (
        Object.hasOwn(source, 'lastContributedAt')
        && source.lastContributedAt !== null
        && (
          typeof source.lastContributedAt !== 'string'
          || Number.isNaN(new Date(source.lastContributedAt).getTime())
          || new Date(source.lastContributedAt).toISOString() !== source.lastContributedAt
        )
      ) {
        fail(failures, `${label} lastContributedAt must be null or a valid ISO timestamp`);
      }

      if (source.enabled !== true) {
        return;
      }

      const normalizedName = normalizeSourceName(source.name);

      if (typeof source.name !== 'string') {
        fail(failures, `${label} must have a string name`);
      } else if (!normalizedName) {
        fail(failures, `${label} must have a non-empty string name`);
      }
      if (!source.url || !isValidHttpUrl(source.url)) {
        fail(failures, `${label} must have an http(s) url`);
      }
      let publicFeedUrl = false;
      if (source.url && isValidHttpUrl(source.url)) {
        try {
          assertPublicFeedUrl(source.url);
          publicFeedUrl = true;
        } catch (error) {
          fail(failures, `${label}: ${error.message}`);
        }
      }
      if (source.type !== 'rss') {
        fail(failures, `${label} has unsupported type "${source.type}"`);
      }

      if (normalizedName) {
        const normalizedNameKey = normalizedName.toLowerCase();
        if (enabledSourceNames.has(normalizedNameKey)) {
          fail(failures, `${label} duplicates enabled source name "${normalizedName}"`);
        } else {
          enabledSourceNames.add(normalizedNameKey);
        }
      }

      const normalizedUrl = normalizeHttpUrl(source.url);
      if (normalizedUrl) {
        if (enabledSourceUrls.has(normalizedUrl)) {
          fail(failures, `${label} duplicates enabled source url "${normalizedUrl}"`);
        } else {
          enabledSourceUrls.add(normalizedUrl);
        }
      }

      if (
        normalizedName
        && source.url
        && publicFeedUrl
        && source.type === 'rss'
      ) {
        enabledRssSources.push(source);
      }
    });
  }

  if (config.settings !== undefined) {
    if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) {
      fail(failures, 'settings must be an object');
    } else {
      if (config.settings.maxNewsItems !== undefined) {
        maxNewsItems = config.settings.maxNewsItems;
      }
      ['testTrigger', 'manualTrigger'].forEach((field) => {
        if (Object.hasOwn(config.settings, field)) {
          fail(failures, `settings.${field} is a trigger-only field and must not be committed`);
        }
      });
    }
  }

  if (!Number.isInteger(maxNewsItems) || maxNewsItems <= 0) {
    fail(failures, 'settings.maxNewsItems must be a positive integer');
  }

  return { enabledRssSources, failures, maxNewsItems };
}

function assertSourceConfigContract(config) {
  const failures = [];
  const result = validateSourceConfig(config, failures);

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }

  return result;
}

module.exports = {
  DEFAULT_MAX_NEWS_ITEMS,
  assertPublicFeedUrl,
  assertSourceConfigContract,
  isPublicIpAddress,
  isValidHttpUrl,
  normalizeHttpUrl,
  normalizeSourceName,
  validateSourceConfig,
};
