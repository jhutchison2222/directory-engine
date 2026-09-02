# Legacy-domain inventory and transition contract (DE-0009)

ADR-001's consequences record that "existing metro domains must be inventoried
before parking, redirecting, or retiring them." This contract defines the
human- and machine-readable shape of that inventory: the pre-ADR-001,
per-metro legacy domains this project may hold, the factual evidence recorded
about each one, and the transition plan proposed for it. It does not authorize
any domain registration, DNS change, Cloudflare or WordPress configuration,
redirect execution, parking, retirement, deployment, or other live-system
operation; it only defines what a correct inventory and transition-plan
document looks like so a future, separately authorized work packet can act on
it.

This contract is deliberately separate from
[`niche-site-registry.md`](niche-site-registry.md) (DE-0008), which defines
the canonical *target* nationwide site per niche. DE-0009 governs the legacy
*source* side of a transition — pre-existing per-metro domains and their
disposition — and cross-references DE-0008 only to check that a planned
redirect target actually names one real canonical registry record. A legacy
domain's own source geography (the metro or state it historically served) is
never conflated with the canonical niche/service identity of its redirect
target: the two live in separate objects (`source_geography` and
`transition_plan.redirect_target`) and are validated independently.

## Internal country identity

An inventory document declares `country` at the document root, and the schema
constrains it to exactly `US`, matching the internal country identity used by
the DE-0006 and DE-0008 contracts.

## No ownership, deployment, or execution claim

Nothing in this contract, its schema, or its fixtures asserts that any listed
legacy `origin` is currently owned, registered, configured, deployed, live,
indexed, redirected, parked, or retired. An inventory entry records a
historical per-metro domain identity, a factual observation about its current
resolution state, and a *proposed* transition — never an executed one.

This contract's own fixtures use per-metro legacy `origin` values under the
`.example` TLD, reserved for documentation use by RFC 2606, so no fixture can
be read as a factual claim about a real, registrable domain. A
`redirect_target`, by contrast, must still name a real record in the DE-0008
canonical registry fixture, since that is the only way to exercise
cross-document target validation; DE-0008 already establishes that record as
a canonical *target* identity, so referencing it here does not add a new
factual claim.

## Legacy-domain entry shape

Each entry in `legacy_domains` declares:

- `legacy_domain_id` — a unique identifier for the legacy domain within this
  document. Two entries sharing a `legacy_domain_id` is a **duplicate-id**
  violation.
- `origin` — the legacy domain's bare `https://` scheme-plus-host origin (see
  "Legacy origin grammar" below). Two entries sharing an origin (compared
  case-insensitively) is a **duplicate-origin** violation.
- `source_geography` — the state (required) and, optionally, metro the legacy
  domain historically served. Unlike DE-0008's canonical registry, a legacy
  domain's `origin` and identifiers are expected to embed geography, since
  that is exactly the pre-ADR-001, per-metro pattern this inventory exists to
  retire. A `source_geography.state` value that is not a recognized United
  States state (or the District of Columbia) is a **non-us** violation.
- `current_evidence` — a factual, observed, attributable record: `evidence_type`
  (how the observation was made), `observed_subject` (the origin the
  observation is about), `observed_state` (what was observed), `captured_at`
  (an RFC 3339 timestamp of when the observation was made), and `reference`
  (who/what recorded it and a citation). See "Evidence" below.
- `transition_plan` — the proposed disposition: `disposition`, an optional
  `redirect_target`, and a `rationale`. See "Transition plan" below.

## Legacy origin grammar

A legacy `origin` must be a bare `https://` scheme-plus-host origin, with no
path, query string, fragment, embedded credentials, explicit port, or
wildcard — the same structural grammar DE-0008 requires of a canonical
origin:

- A value that does not start with `https://`, or whose host is not a valid
  domain, is **malformed-origin**.
- A trailing path segment is **origin-has-path**; a query string is
  **origin-has-query**; a fragment is **origin-has-fragment**.
- Embedded userinfo (`user:pass@host`) is **origin-has-credentials**; an
  explicit port (`:8443`) is **origin-has-port**; a `*` anywhere in the value
  is **origin-has-wildcard**.

Unlike DE-0008's canonical registry origin, a legacy origin is not required to
be a bare apex or `www` host free of geography terms — a per-metro or
per-city legacy domain name (for example `denverwaterheaterrepair.com`) is
exactly the kind of pre-existing identity this inventory records, not a new
canonical identity this contract is minting.

## Evidence

`current_evidence` records what was actually observed about a legacy domain,
not what is planned or has been executed for it, and who or what is
attributable for the observation:

- `evidence_type` must be one of the recognized observation methods
  (`dns_lookup`, `http_check`, `registrar_whois`, `manual_review`); any other
  value is an **unsupported-evidence** violation.
- `observed_subject` explicitly names the origin the observation is about. It
  must equal (case-insensitively) this entry's own `origin`; any other value
  is an **evidence-subject-mismatch** violation, since evidence recorded under
  one legacy-domain entry must describe that same entry, not another one.
- `observed_state` must be one of the recognized neutral, factual states
  (`active_resolving`, `not_resolving`, `registrar_parked_page`, `unknown`);
  any other unrecognized value is also an **unsupported-evidence** violation.
- `observed_state` must never assert an executed disposition outcome —
  `redirected`, `parked`, `retired`, `live`, `deployed`, `indexed`, `owned`,
  or `configured` — since this contract does not authorize or evidence any
  live-system execution. Using one of those terms as an "observation" is an
  **evidence-plan-conflation** violation: it smuggles a planned or executed
  action into the evidence block instead of keeping evidence and plan
  separate.
- `captured_at` must not be later than the time validation runs; a
  timestamp in the future is a **future-dated-evidence** violation, since
  evidence can only describe what has already been observed.
- `reference` is a required, typed, attributable evidence reference:
  - `reference_type` must be one of the recognized reference kinds
    (`internal_note`, `internal_log_excerpt`, `external_registrar_record`);
    any other value is an **unsupported-evidence** violation.
  - `recorded_by` and `citation` are required, non-blank strings identifying
    who or what recorded the evidence and citing what was reviewed. A blank
    (empty or whitespace-only) value for either is a
    **missing-evidence-attribution** violation.
  - Neither `recorded_by` nor `citation` may embed credential or secret
    material — URL userinfo (`user:pass@host`) or a secret-bearing keyword
    (for example `password`, `api_key`, `bearer `, `-----BEGIN`). Either is an
    **evidence-reference-credential** violation, since an evidence citation
    must never carry a live credential.

## Transition plan

`transition_plan` records a proposed disposition, never an executed one:

- `disposition` must be one of `undecided`, `retain_temporarily`,
  `redirect_planned`, `park_planned`, or `retire_planned` — the complete,
  non-executed transition space for a legacy domain; any other value is a
  **conflicting-disposition** violation, since the plan cannot be resolved to
  any of its supported categories.
- `redirect_target` is required when, and only when, `disposition` is
  `redirect_planned`; declaring it under any other disposition, or omitting
  it under `redirect_planned`, is a **conflicting-disposition** violation,
  since a domain cannot simultaneously (or ambiguously) be planned for
  redirect and for some other disposition.
- When present, `redirect_target` names a `niche_id`, `site_id`, and `origin`.
  These three values together must identify exactly one canonical record in
  the DE-0008 nationwide niche-site registry (cross-validated against
  `project/fixtures/de-0008-niche-site-registry.valid.json`); if they do not
  agree on exactly one registry record, that is a **target-mismatch**
  violation.
- A `redirect_target.origin` equal to the legacy entry's own `origin`
  (compared case-insensitively) is a **self-target** violation — a domain
  cannot be planned to redirect to itself.
- `rationale` is a required, non-empty explanation of the proposed
  disposition. This contract records the proposal only; it does not execute
  any redirect, parking, or retirement.

## Machine-readable schema

[`legacy-domain-transition.schema.json`](legacy-domain-transition.schema.json)
defines the structural shape of an inventory document (field names and
types), including the required internal `country` identity and, recursively,
`additionalProperties: false` on every nested object subschema so an unknown
field anywhere in the document fails closed. Structural validation alone
cannot express the cross-record, cross-field, and cross-document rules above
(duplicate-id, duplicate-origin, malformed-origin, origin-has-path,
origin-has-query, origin-has-fragment, origin-has-credentials,
origin-has-port, origin-has-wildcard, self-target, conflicting-disposition,
non-us, unsupported-evidence, future-dated-evidence,
evidence-plan-conflation, evidence-subject-mismatch,
evidence-reference-credential, missing-evidence-attribution, and
target-mismatch), so `scripts/lib/validate-legacy-domain-transition.mjs`
implements those checks and fails closed — any violation is reported, not
silently accepted. `scripts/lib/schema-fail-closed.mjs` implements the
recursive `additionalProperties: false` check that `check:governance` runs
against this schema.

## Fixtures

`project/fixtures/de-0009-legacy-domain-transition.valid.json` is a
representative valid inventory document with one entry per recognized
`transition_plan.disposition` value; its one `redirect_planned` entry targets
a record actually present in
`project/fixtures/de-0008-niche-site-registry.valid.json`.
`project/fixtures/de-0009-invalid-*.json` each contain a deliberate
violation, one file per fail-closed category listed above, plus
`de-0009-invalid-country-not-us.json` for the internal country identity
requirement, `de-0009-invalid-unsupported-root-property.json` /
`de-0009-invalid-unsupported-nested-property.json` proving the recursive
`additionalProperties: false` schema constraint rejects an undeclared field
at the document root and inside a nested object respectively, and
`de-0009-invalid-evidence-missing-subject.json` proving the schema requires
`observed_subject`.
