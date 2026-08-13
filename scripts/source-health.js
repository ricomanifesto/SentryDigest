const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_STALE_AFTER_DAYS = 30;

function normalizeContributionTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : null;
}

function newestContributionTimestamp(values) {
  const timestamps = values
    .map(normalizeContributionTimestamp)
    .filter(Boolean)
    .map((value) => new Date(value).getTime());

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function collectSourceHealth(newsItems = [], sources = []) {
  const sourceRecords = sources.map((source) => (
    typeof source === 'string' ? { name: source } : source
  ));
  const counts = new Map(sourceRecords.map((source) => [source.name, 0]));
  const articleDates = new Map();

  newsItems.forEach((article) => {
    if (!article || typeof article.source !== 'string') {
      return;
    }
    counts.set(article.source, (counts.get(article.source) || 0) + 1);
    const dates = articleDates.get(article.source) || [];
    dates.push(article.date);
    articleDates.set(article.source, dates);
  });

  return sourceRecords
    .filter((source) => source && typeof source.name === 'string')
    .map((source) => ({
      name: source.name,
      itemCount: counts.get(source.name) || 0,
      lastContributedAt: newestContributionTimestamp([
        source.lastContributedAt,
        ...(articleDates.get(source.name) || []),
      ]),
    }));
}

function describeSourceHealth(sourceHealth = [], asOf = new Date()) {
  const observedAt = new Date(asOf).getTime();
  if (!Number.isFinite(observedAt)) {
    throw new Error('source health observation time must be a valid date');
  }

  return sourceHealth.map((health) => {
    if (health.itemCount > 0) {
      return {
        ...health,
        status: 'active',
        quietForDays: 0,
      };
    }

    const lastContributedAt = normalizeContributionTimestamp(health.lastContributedAt);
    if (!lastContributedAt) {
      return {
        ...health,
        lastContributedAt: null,
        status: 'unobserved',
        quietForDays: null,
      };
    }

    const quietForDays = Math.floor(
      Math.max(0, observedAt - new Date(lastContributedAt).getTime()) / DAY_MS
    );
    return {
      ...health,
      lastContributedAt,
      status: quietForDays >= SOURCE_STALE_AFTER_DAYS ? 'stale' : 'quiet',
      quietForDays,
    };
  });
}

function updateSourceContributionHistory(config, sourceContributions = [], newsItems = []) {
  const observedBySource = new Map(
    sourceContributions.map((contribution) => [
      contribution.name,
      contribution.lastContributedAt,
    ])
  );
  const articleDates = new Map();

  newsItems.forEach((article) => {
    if (!article || typeof article.source !== 'string') {
      return;
    }
    const dates = articleDates.get(article.source) || [];
    dates.push(article.date);
    articleDates.set(article.source, dates);
  });

  (config.sources || []).forEach((source) => {
    if (!source || source.enabled !== true || typeof source.name !== 'string') {
      return;
    }

    source.lastContributedAt = newestContributionTimestamp([
      source.lastContributedAt,
      observedBySource.get(source.name),
      ...(articleDates.get(source.name) || []),
    ]);
  });

  return config;
}

module.exports = {
  collectSourceHealth,
  describeSourceHealth,
  newestContributionTimestamp,
  normalizeContributionTimestamp,
  SOURCE_STALE_AFTER_DAYS,
  updateSourceContributionHistory,
};
