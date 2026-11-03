// Public site configuration for generated pages and validators: which origin
// each site currently emits, and which origins validators accept while sites
// move from their legacy Pages roots to their production origins.
const { acceptedOrigins, emittedOrigin, loadSiteConfig } = require('../publication/kit/config');

const SITE_CONFIG = loadSiteConfig(require('../publication/site.json'));

module.exports = {
  SITE_CONFIG,
  acceptedOrigins: (site) => acceptedOrigins(SITE_CONFIG, site),
  emittedOrigin: (site) => emittedOrigin(SITE_CONFIG, site),
};
