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

const RECOGNIZED_EVIDENCE_TYPES = new Set(["dns_lookup", "http_check", "registrar_whois", "manual_review"]);

const RECOGNIZED_OBSERVED_STATES = new Set([
  "active_resolving",
  "not_resolving",
  "registrar_parked_page",
  "unknown",
]);

// Terms that assert an executed disposition outcome rather than a neutral,
// factual observation. `current_evidence` must describe what was observed,
// never what has been planned or executed, so using one of these as an
// "observation" is a distinct evidence-plan-conflation violation, not merely
// an unrecognized value.
const EXECUTION_CLAIM_TERMS = new Set([
  "redirected",
  "parked",
  "retired",
  "live",
  "deployed",
  "indexed",
  "owned",
  "configured",
]);

const RECOGNIZED_DISPOSITIONS = new Set([
  "undecided",
  "retain_temporarily",
  "redirect_planned",
  "park_planned",
  "retire_planned",
]);

const RECOGNIZED_REFERENCE_TYPES = new Set(["internal_note", "internal_log_excerpt", "external_registrar_record"]);

// Raw vendor/access-key token shapes that identify a live credential by
// shape alone, independent of any surrounding keyword: GitHub personal-
// access tokens (classic `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and fine-grained
// `github_pat_`), OpenAI-style `sk-` secret keys, AWS `AKIA` access-key IDs,
// and Slack `xox`-prefixed tokens.
const TOKEN_SHAPE_PATTERN =
  "(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})";

// Detects credential/secret material so a persisted free-text field can never
// carry a live credential: a URL with embedded userinfo (bounded to the
// authority component, so a colon/`@` pair inside a path, query, or fragment
// does not false-positive), a raw vendor/access-key token shape, or a
// secret-bearing keyword. Any non-empty userinfo before `@` in the authority
// is treated as a live credential, whether or not it contains a colon and
// whether or not it happens to match a recognized vendor-token shape — an
// opaque, unrecognized token in a URL's authority is just as much a live
// credential as a `user:pass` pair or a known vendor-token shape. Each
// keyword is context-bound so legitimate prose is not misread as a
// credential: bare dictionary words like "secret" or "password" require a
// word boundary (so "Secretary" does not match "secret"), "bearer" only
// fires when followed by a token-shaped run of characters (so "bearer of
// this deed" does not match), and "authorization:" only fires when followed
// by the "Bearer" or "Basic" scheme (so "Authorization: city clerk" does not
// match). Fails closed on any match.
const CREDENTIAL_URL_PATTERN = /:\/\/[^\s/?#]+@/;
const CREDENTIAL_KEYWORD_PATTERN = new RegExp(
  [
    "\\b(?:password|passwd|secrets?|api[_-]?keys?|access[_-]?keys?|private[_-]?keys?)\\b",
    "\\bbearer\\s+[A-Za-z0-9._~+/=-]{8,}",
    "\\bauthorization\\s*:\\s*(?:bearer|basic)\\b",
    "-----begin",
    TOKEN_SHAPE_PATTERN,
    "\\btoken\\s*=\\s*\\S+",
  ].join("|"),
  "i",
);

function containsCredentialMaterial(value) {
  return CREDENTIAL_URL_PATTERN.test(value) || CREDENTIAL_KEYWORD_PATTERN.test(value);
}

/**
 * Validates that `origin` is a bare https scheme+host origin: no path,
 * query, fragment, userinfo/credentials, explicit port, or wildcard.
 * Userinfo detection is bounded to the authority component (the substring
 * before the first `/`, `?`, or `#`), so an `@` inside a path, query
 * string, or fragment is reported as the actual `origin-has-path`/
 * `origin-has-query`/`origin-has-fragment` violation rather than being
 * misread as embedded credentials. Unlike DE-0008's canonical registry
 * origin, a legacy origin is not restricted to a bare apex/www host free of
 * geography terms, since a per-metro legacy domain name is exactly the
 * pre-existing identity this inventory records.
 */
function validateLegacyOrigin(origin, domainId) {
  const errors = [];

  if (origin.includes("*")) {
    errors.push(`origin-has-wildcard: legacy domain "${domainId}" origin "${origin}" must not contain a wildcard`);
  }

  if (!origin.startsWith("https://")) {
    errors.push(`malformed-origin: legacy domain "${domainId}" origin "${origin}" must start with "https://"`);
    return errors;
  }

  const rest = origin.slice("https://".length);
  const specialIndex = rest.search(/[/?#]/);
  const authority = specialIndex === -1 ? rest : rest.slice(0, specialIndex);

  const credentialsIndex = authority.indexOf("@");
  const hostAndPort = credentialsIndex === -1 ? authority : authority.slice(credentialsIndex + 1);
  if (credentialsIndex !== -1) {
    errors.push(
      `origin-has-credentials: legacy domain "${domainId}" origin "${origin}" must not embed userinfo/credentials`,
    );
  }

  if (specialIndex !== -1) {
    const marker = rest[specialIndex];
    if (marker === "/") {
      errors.push(`origin-has-path: legacy domain "${domainId}" origin "${origin}" must be a bare origin with no path`);
    } else if (marker === "?") {
      errors.push(
        `origin-has-query: legacy domain "${domainId}" origin "${origin}" must be a bare origin with no query string`,
      );
    } else if (marker === "#") {
      errors.push(
        `origin-has-fragment: legacy domain "${domainId}" origin "${origin}" must be a bare origin with no fragment`,
      );
    }
  }

  const colonIndex = hostAndPort.indexOf(":");
  const host = colonIndex === -1 ? hostAndPort : hostAndPort.slice(0, colonIndex);
  if (colonIndex !== -1) {
    errors.push(`origin-has-port: legacy domain "${domainId}" origin "${origin}" must not declare an explicit port`);
  }

  if (host.length === 0 || !HOST_PATTERN.test(host)) {
    errors.push(`malformed-origin: legacy domain "${domainId}" origin "${origin}" host is not a valid domain`);
  }

  return errors;
}

/**
 * Enforces the legacy-domain inventory and transition-plan rules in
 * docs/contracts/legacy-domain-transition.md that the narrow json-schema-lite
 * validator cannot express: cross-record uniqueness, origin shape,
 * evidence/plan separation, and cross-validation of a redirect_planned
 * target against the DE-0008 nationwide niche-site registry. Fails closed by
 * reporting every violation rather than stopping at the first.
 *
 * `registryContract` is a DE-0008 niche-site-registry document (structurally
 * and semantically valid) used only to check that a redirect_target names
 * exactly one canonical registry record; this function does not itself
 * validate the registry document.
 */
export function validateLegacyDomainTransition(contract, registryContract) {
  const errors = [];
  const seenIds = new Set();
  const seenOrigins = new Set();

  for (const record of contract.legacy_domains) {
    if (seenIds.has(record.legacy_domain_id)) {
      errors.push(`duplicate-id: legacy_domain_id "${record.legacy_domain_id}" is declared by more than one entry`);
    }
    seenIds.add(record.legacy_domain_id);

    const normalizedOrigin = record.origin.toLowerCase();
    if (seenOrigins.has(normalizedOrigin)) {
      errors.push(`duplicate-origin: origin "${record.origin}" is declared by more than one entry`);
    }
    seenOrigins.add(normalizedOrigin);

    errors.push(...validateLegacyOrigin(record.origin, record.legacy_domain_id));

    if (!US_STATE_SLUGS.has(record.source_geography.state)) {
      errors.push(
        `non-us: legacy domain "${record.legacy_domain_id}" source_geography.state "${record.source_geography.state}" is not a recognized United States state`,
      );
    }

    const {
      evidence_type: evidenceType,
      observed_subject: observedSubject,
      observed_state: observedState,
      captured_at: capturedAt,
      reference,
    } = record.current_evidence;

    if (!RECOGNIZED_EVIDENCE_TYPES.has(evidenceType)) {
      errors.push(
        `unsupported-evidence: legacy domain "${record.legacy_domain_id}" current_evidence.evidence_type "${evidenceType}" is not a recognized evidence type`,
      );
    }

    if (observedSubject.toLowerCase() !== normalizedOrigin) {
      errors.push(
        `evidence-subject-mismatch: legacy domain "${record.legacy_domain_id}" current_evidence.observed_subject "${observedSubject}" does not identify this entry's own origin "${record.origin}"`,
      );
    }

    if (EXECUTION_CLAIM_TERMS.has(observedState)) {
      errors.push(
        `evidence-plan-conflation: legacy domain "${record.legacy_domain_id}" current_evidence.observed_state "${observedState}" asserts an executed disposition outcome, which this code-only contract does not authorize or evidence`,
      );
    } else if (!RECOGNIZED_OBSERVED_STATES.has(observedState)) {
      errors.push(
        `unsupported-evidence: legacy domain "${record.legacy_domain_id}" current_evidence.observed_state "${observedState}" is not a recognized observed state`,
      );
    }

    if (Number.isNaN(Date.parse(capturedAt))) {
      errors.push(
        `unsupported-evidence: legacy domain "${record.legacy_domain_id}" current_evidence.captured_at "${capturedAt}" is not a parseable date-time`,
      );
    } else if (Date.parse(capturedAt) > Date.now()) {
      errors.push(
        `future-dated-evidence: legacy domain "${record.legacy_domain_id}" current_evidence.captured_at "${capturedAt}" is in the future`,
      );
    }

    const { reference_type: referenceType, recorded_by: recordedBy, citation } = reference;

    if (!RECOGNIZED_REFERENCE_TYPES.has(referenceType)) {
      errors.push(
        `unsupported-evidence: legacy domain "${record.legacy_domain_id}" current_evidence.reference.reference_type "${referenceType}" is not a recognized reference type`,
      );
    }

    if (recordedBy.trim().length === 0 || citation.trim().length === 0) {
      errors.push(
        `missing-evidence-attribution: legacy domain "${record.legacy_domain_id}" current_evidence.reference must declare a non-blank recorded_by and citation`,
      );
    }

    if (containsCredentialMaterial(recordedBy) || containsCredentialMaterial(citation)) {
      errors.push(
        `evidence-reference-credential: legacy domain "${record.legacy_domain_id}" current_evidence.reference must not embed credential or secret material`,
      );
    }

    const { disposition, redirect_target: redirectTarget, rationale } = record.transition_plan;

    if (containsCredentialMaterial(rationale)) {
      errors.push(
        `rationale-credential: legacy domain "${record.legacy_domain_id}" transition_plan.rationale must not embed credential or secret material`,
      );
    }

    if (!RECOGNIZED_DISPOSITIONS.has(disposition)) {
      errors.push(
        `conflicting-disposition: legacy domain "${record.legacy_domain_id}" transition_plan.disposition "${disposition}" is not a recognized disposition`,
      );
    }

    const isRedirectPlanned = disposition === "redirect_planned";
    if (isRedirectPlanned && !redirectTarget) {
      errors.push(
        `conflicting-disposition: legacy domain "${record.legacy_domain_id}" disposition "redirect_planned" requires a redirect_target`,
      );
    }
    if (!isRedirectPlanned && redirectTarget) {
      errors.push(
        `conflicting-disposition: legacy domain "${record.legacy_domain_id}" disposition "${disposition}" must not declare a redirect_target`,
      );
    }

    if (redirectTarget) {
      if (redirectTarget.origin.toLowerCase() === normalizedOrigin) {
        errors.push(
          `self-target: legacy domain "${record.legacy_domain_id}" redirect_target.origin must not equal its own origin`,
        );
      }

      const matches = registryContract.niche_sites.filter(
        (site) =>
          site.niche_id === redirectTarget.niche_id &&
          site.site_id === redirectTarget.site_id &&
          site.origin.toLowerCase() === redirectTarget.origin.toLowerCase(),
      );
      if (matches.length !== 1) {
        errors.push(
          `target-mismatch: legacy domain "${record.legacy_domain_id}" redirect_target niche_id/site_id/origin does not identify exactly one canonical niche-site registry record`,
        );
      }
    }
  }

  return errors;
}

export function assertValidLegacyDomainTransition(contract, registryContract, label) {
  const errors = validateLegacyDomainTransition(contract, registryContract);
  if (errors.length > 0) {
    throw new Error(`${label} failed legacy-domain transition validation:\n- ${errors.join("\n- ")}`);
  }
}
