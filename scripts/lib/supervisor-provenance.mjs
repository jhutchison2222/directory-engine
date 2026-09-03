/**
 * DE-0010 security redesign: an edited GitHub comment keeps its original
 * `user`/author while its body can be rewritten by anyone with sufficient
 * repository access, and the REST API still reports the original author on
 * the edited body. Trusting a comment's body purely because of who the API
 * says authored it - without checking whether it has been edited since
 * creation - lets a forged body (e.g. a fabricated owner "ACCEPTED" verdict,
 * or a fabricated dispatch-ledger marker) hide behind a trusted identity.
 *
 * `isUneditedProvenance` is the single fail-closed check used at every
 * ingestion point that trusts comment/review body text as evidence (owner
 * verdicts in supervisor-verdicts.mjs, dispatch markers in
 * supervisor-idempotency.mjs): both `createdAt` and `updatedAt` must be
 * present, parseable, and exactly equal. A missing or unparseable timestamp,
 * or one that differs from the other, is never trusted - there is no
 * fallback that treats "unknown" as "unedited".
 */
export function isUneditedProvenance({ createdAt, updatedAt }) {
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") return false;
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false;
  return created === updated;
}
