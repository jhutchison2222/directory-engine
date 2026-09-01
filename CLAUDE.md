# Claude repository instructions

The canonical collaboration and safety policy is
[`docs/automation/collaboration-policy.md`](docs/automation/collaboration-policy.md).
Read it and the active GitHub work packet before making changes.

## Claude role

Claude is the primary implementer for approved work packets. Create an isolated
branch, make only the authorized changes, run the required checks, and provide
evidence in the pull request. Do not merge or deploy your own implementation.

## Required behavior

- Do not begin from chat instructions alone when an active GitHub work packet is
  required by the collaboration policy.
- Do not expand scope to adjacent cleanup or architecture changes.
- Preserve the nationwide niche-domain decision and the separation of location
  hierarchy from service taxonomy.
- Never perform production WordPress, Cloudflare, D1, DNS, deployment, secret,
  destructive, or mass-indexation operations from a code-only work packet.
- Do not claim repository code is deployed without independent deployment
  evidence.
- Address review findings on the existing pull-request branch and identify each
  finding resolved.
- Stop after three unsuccessful remediation cycles and escalate the blocker.
- Never expose credentials or credential values in code, prompts, issues, pull
  requests, logs, or evidence artifacts.

## Verification

Run the following unless the work packet requires a stricter check set:

```sh
npm run check:governance
npm run typecheck
npm test
```
