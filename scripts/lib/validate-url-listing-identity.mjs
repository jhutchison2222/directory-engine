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
const READINESS_KEYS = [
  "has_listings",
  "data_quality_checked",
  "has_unique_content",
  "canonical_validated",
  "internally_linked",
];

function splitSegments(path) {
  return path.split("/").filter((segment) => segment.length > 0);
}

function hasBackingListing(url, segments, listings) {
  switch (url.kind) {
    case "state":
      return listings.some((listing) => listing.state === segments[0]);
    case "city":
      return listings.some((listing) => listing.state === segments[0] && listing.city === segments[1]);
    case "neighborhood":
      return listings.some(
        (listing) =>
          listing.state === segments[0] && listing.city === segments[1] && listing.served_areas.includes(segments[2]),
      );
    case "service_area":
      return listings.some(
        (listing) =>
          listing.state === segments[0] && listing.city === segments[1] && listing.services.includes(segments[2]),
      );
    case "business":
      return listings.some((listing) => listing.canonical_path === url.path);
    default:
      // Unrecognized kind is already reported as an "ambiguous" violation.
      return true;
  }
}

/**
 * Enforces the URL/listing identity rules in
 * docs/contracts/url-listing-identity.md that the narrow json-schema-lite
 * validator cannot express: cross-field and cross-record checks. Fails
 * closed by reporting every violation rather than stopping at the first.
 */
export function validateUrlListingIdentity(contract) {
  const errors = [];
  const seenCanonicalUrlPaths = new Set();

  for (const url of contract.canonical_urls) {
    if (seenCanonicalUrlPaths.has(url.path)) {
      errors.push(`duplicate-canonical-url: canonical_urls path "${url.path}" is declared more than once`);
    }
    seenCanonicalUrlPaths.add(url.path);

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

    if (url.kind === "service_area" && segments.length === expectedDepth) {
      const leaf = segments[segments.length - 1];
      if (leaf !== undefined && !contract.service_taxonomy.includes(leaf)) {
        errors.push(
          `unknown-service: canonical_urls path "${url.path}" service leaf "${leaf}" is not declared in service_taxonomy`,
        );
      }
    }

    if (segments.length >= 2) {
      const [stateSegment, citySegment] = segments;
      const parentedUnderMetro = contract.listings.some(
        (listing) => listing.state === stateSegment && listing.metro === citySegment && listing.metro !== listing.city,
      );
      if (parentedUnderMetro) {
        errors.push(
          `metro-parented: canonical_urls path "${url.path}" is parented under metro "${citySegment}" instead of a city`,
        );
      }
    }
  }

  const businessUrls = contract.canonical_urls.filter((url) => url.kind === "business");
  const businessUrlPaths = new Set(businessUrls.map((url) => url.path));

  const seenBranchIds = new Set();
  const seenCanonicalPaths = new Set();

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

      if (!businessUrlPaths.has(listing.canonical_path)) {
        errors.push(
          `identity-mismatch: listing "${listing.branch_id}" canonical_path "${listing.canonical_path}" does not match any business-kind canonical_urls entry`,
        );
      }
    }

    for (const service of listing.services) {
      if (!contract.service_taxonomy.includes(service)) {
        errors.push(`unknown-service: listing "${listing.branch_id}" service "${service}" is not declared in service_taxonomy`);
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
  }

  for (const url of businessUrls) {
    const matchingListings = contract.listings.filter((listing) => listing.canonical_path === url.path);
    if (matchingListings.length === 0) {
      errors.push(`identity-mismatch: canonical_urls business path "${url.path}" has no corresponding listing`);
    } else if (matchingListings.length > 1) {
      errors.push(`identity-mismatch: canonical_urls business path "${url.path}" maps back to more than one listing`);
    }
  }

  for (const url of contract.canonical_urls) {
    if (!url.indexable && !url.sitemap_eligible) continue;

    const readiness = url.indexation_readiness ?? {};
    const unmet = READINESS_KEYS.filter((key) => readiness[key] !== true);
    if (unmet.length > 0) {
      errors.push(
        `unsafe-indexation: canonical_urls path "${url.path}" is marked indexable or sitemap_eligible without meeting readiness: ${unmet.join(", ")}`,
      );
    }

    if (PATH_PATTERN.test(url.path)) {
      const segments = splitSegments(url.path);
      if (!hasBackingListing(url, segments, contract.listings)) {
        errors.push(
          `unsafe-indexation: canonical_urls path "${url.path}" is marked indexable or sitemap_eligible but has no backing listing (empty intersection)`,
        );
      }
    }
  }

  const redirectFromTargets = new Map();
  for (const redirect of contract.redirects) {
    if (!PATH_PATTERN.test(redirect.from)) {
      errors.push(`malformed: redirect from "${redirect.from}" does not match the URL grammar`);
    }
    if (!PATH_PATTERN.test(redirect.to)) {
      errors.push(`malformed: redirect to "${redirect.to}" does not match the URL grammar`);
    }
    if (redirect.from === redirect.to) {
      errors.push(`malformed: redirect from "${redirect.from}" must not equal to "${redirect.to}"`);
    }
    if (!seenCanonicalUrlPaths.has(redirect.to)) {
      errors.push(`redirect-unknown-target: redirect to "${redirect.to}" is not a declared canonical_urls path`);
    }

    if (redirectFromTargets.has(redirect.from)) {
      errors.push(`redirect-conflict: redirect from "${redirect.from}" is declared more than once`);
    } else {
      redirectFromTargets.set(redirect.from, redirect.to);
    }
  }

  const reportedCycleNodes = new Set();
  for (const from of redirectFromTargets.keys()) {
    if (reportedCycleNodes.has(from)) continue;
    const order = [];
    const visited = new Set();
    let current = from;
    while (redirectFromTargets.has(current)) {
      if (visited.has(current)) {
        const cycleNodes = order.slice(order.indexOf(current));
        if (!cycleNodes.some((node) => reportedCycleNodes.has(node))) {
          for (const node of cycleNodes) reportedCycleNodes.add(node);
          errors.push(`redirect-cycle: redirect chain starting at "${cycleNodes[0]}" contains a cycle`);
        }
        break;
      }
      visited.add(current);
      order.push(current);
      current = redirectFromTargets.get(current);
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
