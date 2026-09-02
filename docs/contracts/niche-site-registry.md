# Nationwide niche-site registry contract (DE-0008)

This contract refines the "site registry must represent one canonical public
site per niche" consequence of
[ADR-001](../decisions/ADR-001-national-niche-domains.md) into rules a
validator can enforce. It governs the registry of niche sites across the
whole nationwide portfolio — one record per niche, each naming its one
canonical origin. It does not authorize any domain purchase, DNS change,
Cloudflare or WordPress configuration, deployment, or live-system operation;
it only defines what a correct registry document looks like so future work
packets can validate against it.

This contract is deliberately separate from
[`url-listing-identity.md`](url-listing-identity.md) (DE-0006), which governs
the URL and listing shape *inside* one niche domain. DE-0008 governs the
registry *across* niches: which niche maps to which canonical site, and which
states that site's market coverage has reached, without describing that
site's internal page or listing structure.

## Internal country identity

A registry document declares `country` at the document root, and the schema
constrains it to exactly `US`, matching the internal country identity used by
the DE-0006 contract.

## One canonical site per niche

Each entry in `niche_sites` declares:

- `niche_id` — the service-taxonomy identity of the niche (for example,
  `water-heater-repair`). Two records sharing a `niche_id` is a
  **duplicate-niche** violation, since ADR-001 requires one authoritative
  nationwide site per niche, not several competing sites for the same niche.
- `site_id` — the canonical site's own identity, unique across the registry.
  Two records sharing a `site_id` is a **duplicate-site-id** violation.
- `origin` — the site's one canonical origin (scheme + host, no path). Two
  records sharing an origin (compared case-insensitively) is a
  **duplicate-origin** violation, since two niches cannot both be canonically
  identified by the same site.
- `market_release` — see "Market-release coverage" below.

This contract does not claim that any listed `origin` is owned, registered,
configured, deployed, live, indexed, or redirected. It records the intended
one-to-one niche-to-site mapping only.

## Canonical origin grammar

An `origin` value must be a bare `https://` scheme-plus-host origin, with no
path, query string, fragment, embedded credentials, explicit port, or
wildcard:

- A value that does not start with `https://`, or whose host is not a valid
  domain, is **malformed-origin**.
- A trailing path segment is **origin-has-path**; a query string is
  **origin-has-query**; a fragment is **origin-has-fragment**.
- Embedded userinfo (`user:pass@host`) is **origin-has-credentials**; an
  explicit port (`:8443`) is **origin-has-port**; a `*` anywhere in the value
  is **origin-has-wildcard**.
- The host must be a bare apex domain (`example.com`) or the conventional
  `www` subdomain (`www.example.com`). Any other subdomain (for example,
  `denver.example.com`) is a **metro-specific-origin** violation: a
  subdomain-per-market origin recreates the separate per-metro-domain
  pattern that ADR-001 explicitly supersedes, instead of the one nationwide
  canonical origin per niche this registry requires. An apex or `www` host
  whose registrable domain label itself embeds a geography or metro term
  (for example, `denver-plumbers.com`) is also a **metro-specific-origin**
  violation, since ADR-001 supersedes the per-metro-domain pattern
  regardless of whether the geography term appears as a subdomain or is
  folded directly into the apex label.

## Geography and site/niche identity independence

Per ADR-001, geography and service taxonomy remain independent dimensions.
This registry extends that separation to site, niche, and origin identity,
using two layers:

1. **Diagnostic geography-term matching.** Geography and metro terms are
   detected as a contiguous run of hyphen-separated tokens within a
   kebab-case slug (so a multi-token reserved phrase such as `united-states`
   is caught even inside `united-states-plumbers`, not just as a single exact
   token), matched against every US state name, the District of Columbia, a
   deliberately curated (non-exhaustive) list of major US metro/city names
   such as `denver`, and the bare keywords `metro`, `us`, `usa`, and
   `united-states`. This layer exists to give a clear, specific violation
   category for the terms it happens to recognize, but a hyphen-token
   blocklist of city/metro names can never be nationwide-complete — it cannot
   know about every US place name (for example `aurora`), and it cannot see a
   geography term concatenated without a hyphen into an otherwise
   schema-valid identifier (for example `denverplumbingfinder`). It is not,
   by itself, the authoritative fail-closed mechanism:
   - A `niche_id` that embeds one of these terms (for example,
     `colorado-water-heater-repair` or `denver-plumbers`) is a
     **geography-embedded-niche** violation.
   - A `site_id` that embeds one of these terms (for example,
     `water-heater-repair-colorado` or `plumbers-denver`) is a
     **site-identity-geography-conflation** violation.
   - An origin domain label that embeds one of these terms (for example,
     `denver-plumbers.com`) is a **metro-specific-origin** violation.

2. **Allowlist-backed fail-closed backstop.** `niche_id`, `site_id`, and each
   origin's registrable domain label are also checked against an explicit,
   contract-declared allowlist of recognized service-taxonomy and
   site-naming word roots (`RECOGNIZED_IDENTITY_TOKENS` in
   `scripts/lib/validate-niche-site-registry.mjs`). An identity slug is
   accepted only if it can be fully decomposed (after removing hyphens) into
   a concatenation of tokens drawn from that allowlist; any leftover
   characters that cannot be attributed to a recognized token are an
   **unrecognized-identity-token** violation — regardless of whether that
   leftover text happens to be a known geography term. This is what makes
   the geography/identity separation deterministic and complete: unlike a
   blocklist, an allowlist can be complete by construction, because anything
   not explicitly recognized fails closed instead of being silently accepted.
   Adding a new niche or site name to the registry is a deliberate,
   reviewable extension of this allowlist, not a silent gap in coverage.

## Market-release coverage

Nationwide coverage may be released market by market within the same
canonical site (per ADR-001's consequences), so `market_release` records
that release progress separately from the site's canonical identity:

- `released_states` — states where the niche site's coverage has already
  been released.
- `planned_states` — states planned for future release.

Every entry in either list must be a recognized United States state (or the
District of Columbia); an unrecognized entry (for example, a Canadian
province) is a **non-us** violation. A state repeated within the same list,
or appearing in both `released_states` and `planned_states` for the same
site, cannot be resolved to one release status and is an
**unsupported-ambiguity** violation. This contract records a release
decision only; it does not itself publish, deploy, or index any market.

## Machine-readable schema

[`niche-site-registry.schema.json`](niche-site-registry.schema.json) defines
the structural shape of a registry document (field names, types, and
constants), including the required internal `country` identity and,
recursively, `additionalProperties: false` on every nested object subschema
so an unknown field anywhere in the document fails closed. Structural
validation alone cannot express the cross-record and cross-field rules above
(duplicate-niche, duplicate-site-id, duplicate-origin, non-us,
malformed-origin, origin-has-path, origin-has-query, origin-has-fragment,
origin-has-credentials, origin-has-port, origin-has-wildcard,
metro-specific-origin, geography-embedded-niche,
site-identity-geography-conflation, unrecognized-identity-token, and
unsupported-ambiguity), so `scripts/lib/validate-niche-site-registry.mjs`
implements those checks and fails closed — any violation is reported, not
silently accepted.
`scripts/lib/schema-fail-closed.mjs` implements the recursive
`additionalProperties: false` check that `check:governance` runs against
this schema.

## Fixtures

`project/fixtures/de-0008-niche-site-registry.valid.json` is a representative
valid registry document. `project/fixtures/de-0008-invalid-*.json` each
contain a deliberate violation, one file per fail-closed category listed
above (including additional fixtures isolating a Denver-style apex-domain
origin, a Denver-style `niche_id`/`site_id`, and the multi-token
`united-states` phrase within the `metro-specific-origin`,
`geography-embedded-niche`, and `site-identity-geography-conflation`
categories), plus `de-0008-invalid-country-not-us.json` for the internal
country identity requirement,
`de-0008-invalid-unsupported-root-property.json` /
`de-0008-invalid-unsupported-nested-property.json` proving the recursive
`additionalProperties: false` schema constraint rejects an undeclared field
at the document root and inside a nested object, respectively, and
`de-0008-invalid-unrecognized-origin-token.json` /
`de-0008-invalid-unrecognized-niche-token.json` /
`de-0008-invalid-unrecognized-site-token.json` proving the allowlist-backed
`unrecognized-identity-token` backstop rejects a city name absent from the
curated metro list (`aurora`) in an origin apex domain and in a `niche_id`,
and rejects a geography term concatenated without a hyphen into a `site_id`
(`denverplumbingfinder`), independent of the diagnostic geography-term
matching layer.
