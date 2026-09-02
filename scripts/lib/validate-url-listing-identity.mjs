const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PATH_PATTERN = new RegExp(`^/(${SLUG})(?:/(${SLUG}))?(?:/(${SLUG}))?/$`);
const COUNTRY_SLUGS = new Set(["us", "usa", "united-states"]);
const DEPTH_BY_KIND = {
  state: 1,
  city: 2,
  neighborhood: 3,
  service_area: 3,
  business: 3,
};

function splitSegments(path) {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Enforces the URL/listing identity rules in
 * docs/contracts/url-listing-identity.md that the narrow json-schema-lite
 * validator cannot express: cross-field and cross-record checks. Fails
 * closed by reporting every violation rather than stopping at the first.
 */
export function validateUrlListingIdentity(contract) {
  const errors = [];

  for (const url of contract.canonical_urls) {
    if (!PATH_PATTERN.test(url.path)) {
      errors.push(`malformed: canonical_urls path "${url.path}" does not match the /{state}/{city}/{leaf}/ grammar`);
      continue;
    }
    const segments = splitSegments(url.path);
    if (COUNTRY_SLUGS.has(segments[0])) {
      errors.push(`country-prefixed: canonical_urls path "${url.path}" must not include a country segment`);
    }
    const expectedDepth = DEPTH_BY_KIND[url.kind];
    if (expectedDepth === undefined) {
      errors.push(`ambiguous: canonical_urls path "${url.path}" declares unrecognized kind "${url.kind}"`);
    } else if (segments.length !== expectedDepth) {
      errors.push(
        `ambiguous: canonical_urls path "${url.path}" declares kind "${url.kind}" but has ${segments.length} segment(s), expected ${expectedDepth}`,
      );
    }
  }

  const seenBranchIds = new Set();
  const seenCanonicalPaths = new Set();
  const readinessKeys = ["has_listings", "data_quality_checked", "has_unique_content", "canonical_validated", "internally_linked"];

  for (const listing of contract.listings) {
    if (!PATH_PATTERN.test(listing.canonical_path)) {
      errors.push(`malformed: listing "${listing.branch_id}" canonical_path "${listing.canonical_path}" does not match the URL grammar`);
    } else {
      const segments = splitSegments(listing.canonical_path);
      if (COUNTRY_SLUGS.has(segments[0])) {
        errors.push(`country-prefixed: listing "${listing.branch_id}" canonical_path "${listing.canonical_path}" must not include a country segment`);
      }
      if (segments.length !== 3) {
        errors.push(`ambiguous: listing "${listing.branch_id}" canonical_path "${listing.canonical_path}" must resolve to a state/city/business-slug page`);
      } else {
        const [stateSegment, citySegment, businessSegment] = segments;
        if (stateSegment !== listing.state) {
          errors.push(`ambiguous: listing "${listing.branch_id}" canonical_path state segment "${stateSegment}" does not match declared state "${listing.state}"`);
        }
        if (listing.metro && citySegment === listing.metro && listing.metro !== listing.city) {
          errors.push(`metro-parented: listing "${listing.branch_id}" canonical_path is parented under metro "${listing.metro}" instead of city "${listing.city}"`);
        } else if (citySegment !== listing.city) {
          errors.push(`ambiguous: listing "${listing.branch_id}" canonical_path city segment "${citySegment}" does not match declared city "${listing.city}"`);
        }
        if (listing.services.includes(businessSegment) || contract.service_taxonomy.includes(businessSegment)) {
          errors.push(`service-in-business-url: listing "${listing.branch_id}" canonical_path business slug "${businessSegment}" duplicates a service-taxonomy term`);
        }
      }
    }

    if (seenBranchIds.has(listing.branch_id)) {
      errors.push(`duplicate-branch: branch_id "${listing.branch_id}" is declared by more than one listing`);
    }
    seenBranchIds.add(listing.branch_id);

    if (seenCanonicalPaths.has(listing.canonical_path)) {
      errors.push(`duplicate-branch: canonical_path "${listing.canonical_path}" is reused by more than one listing`);
    }
    seenCanonicalPaths.add(listing.canonical_path);

    if (listing.indexable || listing.sitemap_eligible) {
      const readiness = listing.indexation_readiness ?? {};
      const unmet = readinessKeys.filter((key) => readiness[key] !== true);
      if (unmet.length > 0) {
        errors.push(
          `unsafe-indexation: listing "${listing.branch_id}" is marked indexable or sitemap_eligible without meeting readiness: ${unmet.join(", ")}`,
        );
      }
    }
  }

  for (const redirect of contract.redirects) {
    if (redirect.from === redirect.to) {
      errors.push(`malformed: redirect from "${redirect.from}" must not equal to "${redirect.to}"`);
    }
  }

  return errors;
}

export function assertValidUrlListingIdentity(contract, label) {
  const errors = validateUrlListingIdentity(contract);
  if (errors.length > 0) {
    throw new Error(`${label} failed URL/listing identity validation:\n- ${errors.join("\n- ")}`);
  }
}
