const {
  isValidHttpUrl,
  normalizeSourceName,
} = require('./source-config-contract');

function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

function collectNewsDataCollectionFailures(newsData, maxNewsItems) {
  const failures = [];

  if (newsData.length > maxNewsItems) {
    failures.push(`news-data.json has ${newsData.length} items, which exceeds maxNewsItems ${maxNewsItems}`);
  }

  const links = new Set();
  newsData.forEach((item, index) => {
    const label = `news-data.json item ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return;
    }

    if (item.link && isValidHttpUrl(item.link)) {
      if (links.has(item.link)) {
        failures.push(`${label} duplicates link ${item.link}`);
      } else {
        links.add(item.link);
      }
    }

    const previousItem = newsData[index - 1];
    if (
      index > 0
      && previousItem
      && isValidDate(previousItem.date)
      && isValidDate(item.date)
      && new Date(item.date).getTime() > new Date(previousItem.date).getTime()
    ) {
      failures.push(`${label} is newer than the previous item; news-data.json must be newest-first`);
    }
  });

  return failures;
}

function collectNewsDataItemFailures(item, index, enabledSourceNames) {
  const failures = [];
  const label = `news-data.json item ${index + 1}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    failures.push(`${label} must be an object`);
    return failures;
  }

  if (!item.title || typeof item.title !== 'string') {
    failures.push(`${label} must have a string title`);
  }
  if (!item.link || !isValidHttpUrl(item.link)) {
    failures.push(`${label} must have an http(s) link`);
  }
  if (!item.date || !isValidDate(item.date)) {
    failures.push(`${label} must have a valid date`);
  }
  if (item.firstSeen !== undefined && !isValidDate(item.firstSeen)) {
    failures.push(`${label} firstSeen must be a valid timestamp when present`);
  }

  const normalizedSourceName = normalizeSourceName(item.source);
  if (!item.source || typeof item.source !== 'string') {
    failures.push(`${label} must have a string source`);
  } else if (!normalizedSourceName) {
    failures.push(`${label} must have a non-empty string source`);
  } else if (
    enabledSourceNames.size > 0
    && !enabledSourceNames.has(item.source)
  ) {
    failures.push(`${label} source "${item.source}" must match an enabled RSS source`);
  }

  if (item.summary !== undefined && typeof item.summary !== 'string') {
    failures.push(`${label} summary must be a string when present`);
  }

  return failures;
}

function collectNewsDataFailures(
  newsData,
  enabledRssSources = [],
  maxNewsItems = Number.POSITIVE_INFINITY
) {
  if (!Array.isArray(newsData)) {
    return ['news-data.json must be an array'];
  }

  const enabledSourceNames = new Set(
    enabledRssSources.map((source) => source.name)
  );

  return [
    ...collectNewsDataCollectionFailures(newsData, maxNewsItems),
    ...newsData.flatMap((item, index) => (
      collectNewsDataItemFailures(item, index, enabledSourceNames)
    )),
  ];
}

function assertNewsDataContract(
  newsData,
  enabledRssSources = [],
  maxNewsItems = Number.POSITIVE_INFINITY
) {
  const failures = collectNewsDataFailures(
    newsData,
    enabledRssSources,
    maxNewsItems
  );

  if (failures.length > 0) {
    throw new Error(failures.join('; '));
  }
}

module.exports = {
  assertNewsDataContract,
  collectNewsDataFailures,
  isValidDate,
};
