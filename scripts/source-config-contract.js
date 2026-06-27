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

      if (!source.name || typeof source.name !== 'string') {
        fail(failures, `${label} must have a string name`);
      }
      if (!source.url || !isValidHttpUrl(source.url)) {
        fail(failures, `${label} must have an http(s) url`);
      }
      if (source.type !== 'rss') {
        fail(failures, `${label} has unsupported type "${source.type}"`);
      }

      if (typeof source.name === 'string') {
        if (enabledSourceNames.has(source.name)) {
          fail(failures, `${label} duplicates enabled source name "${source.name}"`);
        } else {
          enabledSourceNames.add(source.name);
        }
      }

      if (isValidHttpUrl(source.url)) {
        if (enabledSourceUrls.has(source.url)) {
          fail(failures, `${label} duplicates enabled source url "${source.url}"`);
        } else {
          enabledSourceUrls.add(source.url);
        }
      }

      if (
        source.name
        && typeof source.name === 'string'
        && source.url
        && isValidHttpUrl(source.url)
        && source.type === 'rss'
      ) {
        enabledRssSources.push(source);
      }
    });
  }

  if (config.settings && config.settings.maxNewsItems !== undefined) {
    maxNewsItems = config.settings.maxNewsItems;
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
  validateSourceConfig,
};
