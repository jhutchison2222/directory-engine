# Nationwide URL and listing identity contract (DE-0006)

This contract refines the "Preferred URL contract" and "Indexation policy"
sections of
[ADR-001](../decisions/ADR-001-national-niche-domains.md) into rules a
validator can enforce. It governs one nationwide niche domain at a time. It
does not authorize any live URL, redirect, listing import, sitemap
publication, or indexation change; it only defines what a correct contract
document looks like so future work packets can validate against it.

## Internal country identity

A contract document declares `country` at the document root, and the schema
constrains it to exactly `US`. This records the internal country identity
required by ADR-001 without ever placing it on a preferred public URL — the
`country` field is document metadata, not a path segment.

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

- The country (`US`) is never a path segment, even though it is recorded
  internally in the `country` field above. A leading `us`, `usa`, or
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
- `services` — the service categories the branch offers. Every value must be
  declared in `service_taxonomy`; an undeclared value is an
  **unknown-service** violation.

A listing's `canonical_path` must match exactly one `business`-kind entry in
`canonical_urls`, and that entry must map back to exactly one listing. Either
direction failing is an **identity-mismatch** violation. Indexability and
sitemap eligibility for a business page live on that `canonical_urls` entry
(see "Indexation readiness" below), not on the listing record, so there is
one source of truth per page.

A service category is never encoded into the canonical business URL segment.
A business slug that duplicates a service-taxonomy term is a
**service-in-business-url** violation, since it collapses the geography and
service-taxonomy dimensions ADR-001 requires to stay independent.

Two listings sharing a `branch_id` or a `canonical_path` are a
**duplicate-branch** violation — branch identity and canonical URL identity
must each be one-to-one with a physical location.

Every `canonical_urls[].path` must also be unique across the whole document;
a repeated path is a **duplicate-canonical-url** violation, since two records
cannot both be the identity for the same page.

## Geography and service taxonomy separation

Location pages (`state`, `city`, `neighborhood`) and service pages
(`service_area`) are independent dimensions that may intersect on a
discovery page (e.g. "Denver Water Heater Repair"), but a service category is
never nested inside, or duplicated onto, a canonical business listing URL. A
`service_area` entry's path leaf must itself be declared in
`service_taxonomy`; an undeclared leaf is an **unknown-service** violation.

## Metro treatment

A metro may be represented as a served-area grouping or curated browse
concept, but it is not a canonical URL parent and does not receive a separate
public directory domain. Any listing or URL parented under a metro slug
instead of its state/city pair fails closed as **metro-parented**.

## Planned redirects

A `redirects` entry explicitly maps a superseded URL (for example, a legacy
metro-domain business URL) to its current canonical path, with a `reason`
and a permanent-redirect `status` of `301`. This contract records planned
mappings only; it does not execute any redirect. A redirect plan must be
deterministic:

- `from` and `to` must each match the canonical URL grammar, and `from` must
  not equal `to` (**malformed** otherwise).
- `to` must be a path declared in `canonical_urls` — a redirect cannot target
  an undeclared page (**redirect-unknown-target** otherwise).
- No two redirects may declare the same `from` (**redirect-conflict**
  otherwise), even when their targets happen to agree, so the mapping stays
  single-valued.
- No chain of redirects may loop back on itself (**redirect-cycle**
  otherwise).

## Indexation readiness and sitemap eligibility

Per ADR-001's indexation policy, indexability and sitemap eligibility are
properties of a **page**, not of a listing. Every `canonical_urls` entry —
`state`, `city`, `neighborhood`, `service_area`, and `business` alike — may be
marked `indexable` or `sitemap_eligible` only after all of the following
readiness signals are `true` in its `indexation_readiness` record:

- `has_listings` — the page has real, available listings.
- `data_quality_checked` — the underlying listing data has been checked.
- `has_unique_content` — the page has useful, non-boilerplate content.
- `canonical_validated` — the page's canonical URL has been validated
  against this contract.
- `internally_linked` — the page is reachable through internal navigation.

A page marked `indexable: true` or `sitemap_eligible: true` without every
readiness signal set to `true` is an **unsafe-indexation** violation. So is a
page marked `indexable` or `sitemap_eligible` with no backing listing at all
(an empty or unready state/city/neighborhood/service-intersection page) — for
example, a `service_area` page for a service-category combination that no
listing in that state/city actually offers. This contract does not itself
publish a sitemap or trigger indexation; it only records the readiness
decision.

## Machine-readable schema

[`url-listing-identity.schema.json`](url-listing-identity.schema.json)
defines the structural shape of a contract document (field names, types, and
enums), including the required internal `country` identity and, recursively,
`additionalProperties: false` on every nested object subschema (not just the
document root) so an unknown field anywhere in the document fails closed.
Structural validation alone cannot express the cross-field and cross-record
rules above (country-prefixed, metro-parented, service-in-business-url,
duplicate-branch, duplicate-canonical-url, identity-mismatch,
unknown-service, unsafe-indexation, redirect-conflict,
redirect-unknown-target, redirect-cycle, and ambiguous kind/depth
mismatches), so `scripts/lib/validate-url-listing-identity.mjs` implements
those checks and fails closed — any violation is reported, not silently
accepted. `scripts/lib/schema-fail-closed.mjs` implements the recursive
`additionalProperties: false` check that `check:governance` runs against this
schema.

## Fixtures

`project/fixtures/de-0006-url-listing-identity.valid.json` is a representative
valid contract document. `project/fixtures/de-0006-invalid-*.json` each
contain a deliberate violation, at least one file per fail-closed category
listed above, plus `de-0006-invalid-country-not-us.json` for the internal
country identity requirement. Some categories have more than one isolated
fixture because the validator reports that category from more than one
independent branch — for example, a `canonical_urls` entry parented under a
metro slug versus a listing `canonical_path` parented under one, or a page
marked indexable with unmet readiness signals versus one with no backing
listing at all.
