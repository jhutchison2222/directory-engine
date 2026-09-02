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

// A deliberately curated, non-exhaustive set of major US metro/city names.
// ADR-001 names "Denver" itself as the canonical example of a metro term
// that must not be embedded in niche, site, or origin identity, so this
// list exists to make that example (and comparable major metros) fail
// closed without an external lookup. Expanding coverage to every US city
// is out of scope for this contract.
const US_METRO_SLUGS = new Set([
  "new-york", "los-angeles", "chicago", "houston", "phoenix", "philadelphia",
  "san-antonio", "san-diego", "dallas", "austin", "san-jose", "fort-worth",
  "jacksonville", "columbus", "charlotte", "indianapolis", "seattle", "denver",
  "boston", "el-paso", "nashville", "detroit", "oklahoma-city", "portland",
  "las-vegas", "memphis", "louisville", "baltimore", "milwaukee", "albuquerque",
  "tucson", "fresno", "sacramento", "atlanta", "miami", "kansas-city",
  "colorado-springs", "omaha", "raleigh", "long-beach", "virginia-beach",
  "oakland", "minneapolis", "tulsa", "tampa", "arlington", "new-orleans",
]);

// Bare geography/metro keywords plus multi-token reserved phrases (for
// example "united-states"). These are matched with the same sliding-window
// token-sequence logic as state and metro names below, rather than an
// exact-token Set lookup, so a multi-token phrase is detected even when it
// appears as a run of separately hyphen-joined tokens inside a slug (for
// example "united-states-plumbers").
const GEOGRAPHY_TERMS = new Set([...US_STATE_SLUGS, ...US_METRO_SLUGS, "metro", "us", "usa", "united-states"]);

/**
 * Detects a US state name, major metro/city name, or a bare geography/metro
 * keyword (each as a contiguous run of hyphen-separated tokens) inside a
 * kebab-case identity slug. This is a diagnostic aid only, for the finite set
 * of terms it happens to recognize: it is NOT the authoritative fail-closed
 * check, because no hyphen-token blocklist of city/metro names can ever be
 * complete. `hasUnrecognizedIdentityToken` below is the actual fail-closed
 * backstop.
 */
function containsGeographyTerm(slug) {
  const tokens = slug.split("-");
  for (const term of GEOGRAPHY_TERMS) {
    const termTokens = term.split("-");
    for (let start = 0; start <= tokens.length - termTokens.length; start += 1) {
      if (termTokens.every((token, offset) => tokens[start + offset] === token)) {
        return true;
      }
    }
  }
  return false;
}

// The explicit, contract-declared allowlist of service-taxonomy and
// site-naming word roots this registry currently recognizes. This is the
// authoritative fail-closed mechanism for keeping geography (and any other
// unsupported vocabulary, whether it is a city name this contract has never
// seen or something else entirely) out of niche/site/origin identity: an
// identity slug is accepted only if it can be built entirely out of these
// tokens. A blocklist of known geography terms (`GEOGRAPHY_TERMS` above) can
// never be complete, because it would require enumerating every US place
// name; an allowlist can be complete by construction, because unrecognized
// tokens fail closed instead of being silently accepted. Extending this
// registry to a new niche or site name is a deliberate, reviewable change to
// this list, not a silent gap.
const RECOGNIZED_IDENTITY_TOKENS = new Set([
  "water", "heater", "repair", "drain", "cleaning", "plumbing", "plumber", "plumbers",
  "finder", "national", "nationwide", "pros", "niche", "shared",
]);

/**
 * Determines whether `flattened` (a lowercase string with hyphens already
 * removed) can be built as a concatenation of zero or more tokens from
 * `vocabulary`. Used to fail closed on any identity slug containing a token
 * this contract has not explicitly recognized, whether or not that token is
 * known to be a geography term.
 */
function canDecomposeFromVocabulary(flattened, vocabulary, memo = new Map()) {
  if (flattened.length === 0) {
    return true;
  }
  if (memo.has(flattened)) {
    return memo.get(flattened);
  }
  let decomposable = false;
  for (let end = 1; end <= flattened.length; end += 1) {
    const prefix = flattened.slice(0, end);
    if (vocabulary.has(prefix) && canDecomposeFromVocabulary(flattened.slice(end), vocabulary, memo)) {
      decomposable = true;
      break;
    }
  }
  memo.set(flattened, decomposable);
  return decomposable;
}

/**
 * Fails closed on any hyphen-separated identity slug that contains a token
 * outside the explicit `RECOGNIZED_IDENTITY_TOKENS` allowlist, regardless of
 * whether that token happens to be a known geography term. This is what
 * makes the geography/identity separation deterministic and complete instead
 * of dependent on an inherently non-exhaustive city/metro blocklist.
 */
function hasUnrecognizedIdentityToken(slug) {
  return !canDecomposeFromVocabulary(slug.replace(/-/g, ""), RECOGNIZED_IDENTITY_TOKENS);
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
    const isWww = labels.length === 3 && labels[0] === "www";
    const isBareOrWww = labels.length === 2 || isWww;
    if (!isBareOrWww) {
      errors.push(
        `metro-specific-origin: site "${siteId}" origin "${origin}" uses a subdomain, which implies a metro- or market-specific origin instead of one nationwide canonical origin per niche`,
      );
    } else {
      const registrableLabel = isWww ? labels[1] : labels[0];
      if (containsGeographyTerm(registrableLabel)) {
        errors.push(
          `metro-specific-origin: site "${siteId}" origin "${origin}" domain label "${registrableLabel}" embeds a geography or metro term, which recreates the separate per-metro-domain pattern ADR-001 supersedes instead of one nationwide canonical origin per niche`,
        );
      }
      if (hasUnrecognizedIdentityToken(registrableLabel)) {
        errors.push(
          `unrecognized-identity-token: site "${siteId}" origin "${origin}" domain label "${registrableLabel}" contains a token outside the recognized identity vocabulary, so it cannot be confirmed free of geography or other unsupported content`,
        );
      }
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
    if (hasUnrecognizedIdentityToken(record.niche_id)) {
      errors.push(
        `unrecognized-identity-token: niche_id "${record.niche_id}" contains a token outside the recognized identity vocabulary, so it cannot be confirmed free of geography or other unsupported content`,
      );
    }

    if (containsGeographyTerm(record.site_id)) {
      errors.push(
        `site-identity-geography-conflation: site_id "${record.site_id}" embeds a geography or metro term, conflating canonical site identity with geography`,
      );
    }
    if (hasUnrecognizedIdentityToken(record.site_id)) {
      errors.push(
        `unrecognized-identity-token: site_id "${record.site_id}" contains a token outside the recognized identity vocabulary, so it cannot be confirmed free of geography or other unsupported content`,
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
