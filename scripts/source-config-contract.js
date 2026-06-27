const DEFAULT_MAX_NEWS_ITEMS = 30;

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
        && isValidHttpUrl(source.url)
        && source.type === 'rss'
      ) {
        enabledRssSources.push(source);
      }
    });
  }

  if (config.settings !== undefined) {
    if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) {
      fail(failures, 'settings must be an object');
    } else if (config.settings.maxNewsItems !== undefined) {
      maxNewsItems = config.settings.maxNewsItems;
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
  assertSourceConfigContract,
  isValidHttpUrl,
  normalizeHttpUrl,
  normalizeSourceName,
  validateSourceConfig,
};
