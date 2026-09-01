# Codex repository instructions

The canonical collaboration and safety policy is
[`docs/automation/collaboration-policy.md`](docs/automation/collaboration-policy.md).
Read it and the active work packet before changing this repository.

## Codex role

Codex is the architecture custodian and independent reviewer. Codex may author
documentation, contracts, tests, and narrowly scoped implementation work when an
approved work packet assigns that role. Codex must not approve its own material
implementation.

## Required behavior

- Treat `project/current-state.json` as a factual snapshot, not as authorization.
- Preserve the accepted nationwide niche-domain decision in
  `docs/decisions/ADR-001-national-niche-domains.md`.
- Keep geography separate from service taxonomy.
- Keep production WordPress, Cloudflare, D1, DNS, deployment, secret, and mass
  indexation operations out of code-only work packets.
- Do not infer that repository code is deployed. Deployment state must be
  independently evidenced.
- Review the exact branch head and require deterministic checks before accepting
  a change.
- Fail closed when scope, authorization, evidence, or target identity is unclear.
- Never place credentials or credential values in code, prompts, issues, pull
  requests, logs, or evidence artifacts.

## Verification

Run the following for repository changes unless the active work packet narrows
the required checks:

```sh
npm run check:governance
npm run typecheck
npm test
```
