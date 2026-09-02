const HOST_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*\.[a-z]{2,}$/;

const US_STATE_SLUGS = new Set([
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new-hampshire", "new-jersey", "new-mexico", "new-york", "north-carolina",
  "north-dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode-island",
  "south-carolina", "south-dakota", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "west-virginia", "wisconsin", "wyoming",
  "district-of-columbia",
]);

const GEOGRAPHY_TOKENS = new Set(["metro", "us", "usa", "united-states"]);

/**
 * Detects a state name (as a contiguous run of hyphen-separated tokens) or a
 * bare geography/metro keyword inside a kebab-case identity slug, so niche
 * and site identity stay independent of geography per ADR-001.
 */
function containsGeographyTerm(slug) {
  const tokens = slug.split("-");
  if (tokens.some((token) => GEOGRAPHY_TOKENS.has(token))) return true;
  for (const stateSlug of US_STATE_SLUGS) {
    const stateTokens = stateSlug.split("-");
    for (let start = 0; start <= tokens.length - stateTokens.length; start += 1) {
      if (stateTokens.every((token, offset) => tokens[start + offset] === token)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validates that `origin` is a bare https scheme+host origin: no path,
 * query, fragment, userinfo/credentials, explicit port, or wildcard, and
 * that the host is not scoped under a subdomain (other than the
 * conventional "www"), since a subdomain-per-market origin would recreate
 * the per-metro-domain pattern ADR-001 supersedes.
 */
function validateOrigin(origin, siteId) {
  const errors = [];

  if (origin.includes("*")) {
    errors.push(`origin-has-wildcard: site "${siteId}" origin "${origin}" must not contain a wildcard`);
  }

  if (!origin.startsWith("https://")) {
    errors.push(`malformed-origin: site "${siteId}" origin "${origin}" must start with "https://"`);
    return errors;
  }

  let rest = origin.slice("https://".length);
  const credentialsIndex = rest.indexOf("@");
  if (credentialsIndex !== -1) {
    errors.push(`origin-has-credentials: site "${siteId}" origin "${origin}" must not embed userinfo/credentials`);
    rest = rest.slice(credentialsIndex + 1);
  }

  const specialIndex = rest.search(/[/?#]/);
  const hostAndPort = specialIndex === -1 ? rest : rest.slice(0, specialIndex);
  if (specialIndex !== -1) {
    const marker = rest[specialIndex];
    if (marker === "/") {
      errors.push(`origin-has-path: site "${siteId}" origin "${origin}" must be a bare origin with no path`);
    } else if (marker === "?") {
      errors.push(`origin-has-query: site "${siteId}" origin "${origin}" must be a bare origin with no query string`);
    } else if (marker === "#") {
      errors.push(`origin-has-fragment: site "${siteId}" origin "${origin}" must be a bare origin with no fragment`);
    }
  }

  const colonIndex = hostAndPort.indexOf(":");
  const host = colonIndex === -1 ? hostAndPort : hostAndPort.slice(0, colonIndex);
  if (colonIndex !== -1) {
    errors.push(`origin-has-port: site "${siteId}" origin "${origin}" must not declare an explicit port`);
  }

  if (host.length === 0 || !HOST_PATTERN.test(host)) {
    errors.push(`malformed-origin: site "${siteId}" origin "${origin}" host is not a valid domain`);
  } else {
    const labels = host.split(".");
    const isBareOrWww = labels.length === 2 || (labels.length === 3 && labels[0] === "www");
    if (!isBareOrWww) {
      errors.push(
        `metro-specific-origin: site "${siteId}" origin "${origin}" uses a subdomain, which implies a metro- or market-specific origin instead of one nationwide canonical origin per niche`,
      );
    }
  }

  return errors;
}

/**
 * Enforces the niche-site registry rules in
 * docs/contracts/niche-site-registry.md that the narrow json-schema-lite
 * validator cannot express: cross-record uniqueness, origin shape, and
 * geography/identity independence. Fails closed by reporting every
 * violation rather than stopping at the first.
 */
export function validateNicheSiteRegistry(contract) {
  const errors = [];
  const seenNicheIds = new Set();
  const seenSiteIds = new Set();
  const seenOrigins = new Set();

  for (const record of contract.niche_sites) {
    if (seenNicheIds.has(record.niche_id)) {
      errors.push(`duplicate-niche: niche_id "${record.niche_id}" is declared by more than one site record`);
    }
    seenNicheIds.add(record.niche_id);

    if (seenSiteIds.has(record.site_id)) {
      errors.push(`duplicate-site-id: site_id "${record.site_id}" is declared by more than one site record`);
    }
    seenSiteIds.add(record.site_id);

    const normalizedOrigin = record.origin.toLowerCase();
    if (seenOrigins.has(normalizedOrigin)) {
      errors.push(`duplicate-origin: origin "${record.origin}" is declared by more than one site record`);
    }
    seenOrigins.add(normalizedOrigin);

    errors.push(...validateOrigin(record.origin, record.site_id));

    if (containsGeographyTerm(record.niche_id)) {
      errors.push(
        `geography-embedded-niche: niche_id "${record.niche_id}" embeds a geography or metro term, which ADR-001 requires to stay independent of service taxonomy identity`,
      );
    }

    if (containsGeographyTerm(record.site_id)) {
      errors.push(
        `site-identity-geography-conflation: site_id "${record.site_id}" embeds a geography or metro term, conflating canonical site identity with geography`,
      );
    }

    const releasedSeen = new Set();
    for (const state of record.market_release.released_states) {
      if (!US_STATE_SLUGS.has(state)) {
        errors.push(
          `non-us: site "${record.site_id}" market_release.released_states entry "${state}" is not a recognized United States state`,
        );
      }
      if (releasedSeen.has(state)) {
        errors.push(
          `unsupported-ambiguity: site "${record.site_id}" market_release.released_states declares "${state}" more than once`,
        );
      }
      releasedSeen.add(state);
    }

    const plannedSeen = new Set();
    for (const state of record.market_release.planned_states) {
      if (!US_STATE_SLUGS.has(state)) {
        errors.push(
          `non-us: site "${record.site_id}" market_release.planned_states entry "${state}" is not a recognized United States state`,
        );
      }
      if (plannedSeen.has(state)) {
        errors.push(
          `unsupported-ambiguity: site "${record.site_id}" market_release.planned_states declares "${state}" more than once`,
        );
      }
      if (releasedSeen.has(state)) {
        errors.push(
          `unsupported-ambiguity: site "${record.site_id}" market_release lists "${state}" in both released_states and planned_states`,
        );
      }
      plannedSeen.add(state);
    }
  }

  return errors;
}

export function assertValidNicheSiteRegistry(contract, label) {
  const errors = validateNicheSiteRegistry(contract);
  if (errors.length > 0) {
    throw new Error(`${label} failed niche-site registry validation:\n- ${errors.join("\n- ")}`);
  }
}
