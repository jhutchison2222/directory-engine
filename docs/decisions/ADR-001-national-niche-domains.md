# ADR-001: One nationwide directory per niche

- Status: Accepted
- Accepted: 2026-09-01
- Supersedes: separate public directory domains per metro area

## Decision

Directory Engine will support one authoritative United States public directory
per approved industry or business niche. States, cities, neighborhoods, service
categories, and individual business locations live within that niche domain.

The public location hierarchy is:

```text
state / city / neighborhood
```

The country remains stored internally as `US` and is omitted from the preferred
public URL. A metro may be represented as a search radius, service-area grouping,
or curated browse concept, but it is not a required canonical URL parent and it
does not receive a separate public directory domain.

Geography and service taxonomy remain independent dimensions. Categories such
as `Water Heater Repair` are not duplicated as `Denver Water Heater Repair`.
Location-and-service discovery pages may intersect those dimensions.

Each physical business location or branch has one canonical listing page. A
branch may appear on multiple service and served-area discovery pages, but those
pages link to the same canonical listing. A company with genuine separate
physical branches may have one listing per branch.

The Directory Engine remains one logical control plane. One physical D1 database
may be used initially, but storage access must not prevent later sharding by
niche or another stable partition. WordPress and GeoDirectory remain the public
presentation systems unless a later ADR explicitly changes that boundary.

## Preferred URL contract

The contract to refine and validate in a separate work packet is:

```text
/{state}/
/{state}/{city}/
/{state}/{city}/{neighborhood}/
/{state}/{city}/{service-category}/
/{state}/{city}/{business-slug}/
```

A service category is not part of the canonical business URL. Moves, corrections,
and superseded metro URLs require explicit permanent redirect mappings.

## Indexation policy

The system must not automatically index every location and category permutation.
A page becomes indexable only after an explicit readiness decision based on
available listings, data quality, useful page content, canonical validation,
internal linking, and sitemap eligibility. Empty and unready pages remain out of
the index and canonical sitemap set.

## Preservation

Existing niche categories, consumer-language synonyms, search widgets, safety
rules, disclaimers, child-theme work, and owner-edit protections are preserved
unless a separately reviewed work packet changes them. This ADR changes the
geographic publishing model; it does not authorize live site changes, database
migrations, listing imports, deployments, redirects, or indexation changes.

## Consequences

- Industry-to-domain routing replaces industry-and-metro domain selection.
- The site registry must represent one canonical public site per niche.
- Listing identity must distinguish organization, physical branch, primary
  location, and served areas.
- Nationwide coverage may be released market by market within the same domain.
- Existing metro domains must be inventoried before parking, redirecting, or
  retiring them.
