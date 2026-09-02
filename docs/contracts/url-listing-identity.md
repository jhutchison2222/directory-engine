# Nationwide URL and listing identity contract (DE-0006)

This contract refines the "Preferred URL contract" and "Indexation policy"
sections of
[ADR-001](../decisions/ADR-001-national-niche-domains.md) into rules a
validator can enforce. It governs one nationwide niche domain at a time. It
does not authorize any live URL, redirect, listing import, sitemap
publication, or indexation change; it only defines what a correct contract
document looks like so future work packets can validate against it.

## Canonical URL grammar

A canonical public URL on a nationwide niche domain has at most three path
segments, all lowercase kebab-case slugs, with a leading and trailing slash:

```text
/{state}/
/{state}/{city}/
/{state}/{city}/{neighborhood}/
/{state}/{city}/{service-category}/
/{state}/{city}/{business-slug}/
```

- The country (`US`) is never a path segment. A leading `us`, `usa`, or
  `united-states` segment is a **country-prefixed** violation.
- A metro area is not a required canonical URL parent (per ADR-001). A
  business or neighborhood/service page parented under a metro slug instead
  of the state/city pair is a **metro-parented** violation, even when the
  metro is a legitimate served-area or search-radius concept elsewhere.
- Every `canonical_urls` entry declares a `kind` (`state`, `city`,
  `neighborhood`, `service_area`, or `business`). The declared `kind` must
  match the path's segment depth (1, 2, 3, 3, 3 respectively). A mismatch, or
  an unrecognized `kind`, is **ambiguous** — the page's identity cannot be
  determined from the contract.
- A path that does not match the grammar above (wrong case, double slash,
  missing trailing slash, disallowed characters) is **malformed**.

## Physical-branch listing identity

Each physical business location or branch has exactly one canonical listing
page, at a `state/city/business-slug` path. A listing record identifies:

- `branch_id` — unique per branch across the whole niche domain.
- `organization_id` — the parent company; one organization may have many
  branches.
- `canonical_path` — the branch's one canonical URL.
- `state` / `city` — the branch's primary location, which must match the
  `canonical_path` segments.
- `served_areas` — the neighborhoods, suburbs, or municipalities the branch
  serves. Served areas are a discovery concept only; they do not grant a
  served area its own canonical business URL.
- `metro` — an optional search-radius or curated browse label. A metro is
  never a canonical URL parent (see above).
- `services` — the service categories the branch offers.

A service category is never encoded into the canonical business URL segment.
A business slug that duplicates a service-taxonomy term is a
**service-in-business-url** violation, since it collapses the geography and
service-taxonomy dimensions ADR-001 requires to stay independent.

Two listings sharing a `branch_id` or a `canonical_path` are a
**duplicate-branch** violation — branch identity and canonical URL identity
must each be one-to-one with a physical location.

## Geography and service taxonomy separation

Location pages (`state`, `city`, `neighborhood`) and service pages
(`service_area`) are independent dimensions that may intersect on a
discovery page (e.g. "Denver Water Heater Repair"), but a service category is
never nested inside, or duplicated onto, a canonical business listing URL.

## Metro treatment

A metro may be represented as a served-area grouping or curated browse
concept, but it is not a canonical URL parent and does not receive a separate
public directory domain. Any listing or URL parented under a metro slug
instead of its state/city pair fails closed as **metro-parented**.

## Planned redirects

A `redirects` entry explicitly maps a superseded URL (for example, a legacy
metro-domain business URL) to its current canonical path, with a `reason`
and a permanent-redirect `status` of `301`. This contract records planned
mappings only; it does not execute any redirect.

## Indexation readiness and sitemap eligibility

Per ADR-001's indexation policy, a listing may be marked `indexable` or
`sitemap_eligible` only after all of the following readiness signals are
`true` in its `indexation_readiness` record:

- `has_listings` — the page has real, available listings.
- `data_quality_checked` — the underlying listing data has been checked.
- `has_unique_content` — the page has useful, non-boilerplate content.
- `canonical_validated` — the page's canonical URL has been validated
  against this contract.
- `internally_linked` — the page is reachable through internal navigation.

A listing marked `indexable: true` or `sitemap_eligible: true` without every
readiness signal set to `true` is an **unsafe-indexation** violation. This
contract does not itself publish a sitemap or trigger indexation; it only
records the readiness decision.

## Machine-readable schema

[`url-listing-identity.schema.json`](url-listing-identity.schema.json)
defines the structural shape of a contract document (field names, types, and
enums). Structural validation alone cannot express the cross-field rules
above (country-prefixed, metro-parented, service-in-business-url,
duplicate-branch, unsafe-indexation, and ambiguous kind/depth mismatches), so
`scripts/lib/validate-url-listing-identity.mjs` implements those checks and
fails closed — any violation is reported, not silently accepted.

## Fixtures

`project/fixtures/de-0006-url-listing-identity.valid.json` is a representative
valid contract document. `project/fixtures/de-0006-invalid-*.json` each
contain exactly one deliberate violation, one file per fail-closed category
listed above.
