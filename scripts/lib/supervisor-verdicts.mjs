import { isUneditedProvenance } from "./supervisor-provenance.mjs";

/**
 * Owner-only exact-head acceptance chronology.
 *
 * DE-0010 cycle 2/3: the previous design trusted a hardcoded allowlist of
 * guessed third-party reviewer logins (Codex, the Workspace Agent). This
 * work packet's available tool access could never independently confirm
 * those literal logins, so the allowlist was a standing risk of either
 * failing closed forever or, if guessed wrong, accepting nobody's review as
 * authoritative. The owner mandated removing guessed identities entirely:
 * the only trusted acceptance identity is the repository owner login,
 * supplied by the caller from repository metadata/environment (e.g. the
 * `owner` segment of `GITHUB_REPOSITORY`, or `repository.owner.login` from
 * an event payload) - never guessed, hardcoded, or read from issue/PR
 * content.
 *
 * Security redesign (owner-authorized): three structural hardenings on top
 * of cycle 3/3's marker parsing:
 *
 * 1. Verdict markers are anchored so a negated phrase ("NOT ACCEPTED",
 *    "UNACCEPTED") can never classify as ACCEPTED.
 * 2. SUPERSEDED/REMEDIATION markers' bounded lookahead to "exact head <sha>"
 *    is not allowed to cross another marker keyword (ACCEPTED/REJECTED/
 *    SUPERSEDED), so incidental prose mentioning remediation ahead of a
 *    real ACCEPTED clause can never steal that clause's head reference.
 * 3. A comment or review is only ever trusted when it carries valid,
 *    matching creation/update provenance (see isUneditedProvenance) - an
 *    edited owner comment (whether edited by the owner or, per GitHub's
 *    collaborator comment-editing model, by another user while the
 *    original author is preserved) is never trusted as evidence, and a
 *    missing/unparseable timestamp fails closed rather than being trusted
 *    by default.
 */

export const OWNER_VERDICT_KINDS = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
  REMEDIATION_REQUESTED: "remediation_requested",
});

// A separator that tolerates markdown code-span backticks/quotes/colons
// around the SHA (e.g. "exact head `8f9ac2d...`"), not only plain
// whitespace.
const HEAD_SHA_SEPARATOR = "[\\s:`'\"]*";
const HEAD_SHA_CAPTURE = `${HEAD_SHA_SEPARATOR}([0-9a-f]{7,40})`;

// A negative lookahead reused inside the wide-lookahead markers below so
// their "anything up to 80 chars" span can never cross over one of the
// OTHER marker keywords on its way to an "exact head" phrase. Without this,
// a body like "DE-0010 remediation cycle 2/3 complete. ACCEPTED — exact
// head <sha>" lets REMEDIATION_MARKER's lookahead jump straight past
// "ACCEPTED" to capture that clause's own head reference, misclassifying a
// real acceptance as a remediation request.
const NO_CROSSING_OTHER_MARKER = "(?:(?!ACCEPTED|REJECTED|SUPERSEDED)[\\s\\S])";

const SUPERSEDED_MARKER = new RegExp(`\\bSUPERSEDED\\b${NO_CROSSING_OTHER_MARKER}{0,80}?exact head${HEAD_SHA_CAPTURE}`, "i");
const REJECTED_MARKER = new RegExp(`\\bREJECTED\\s*[—-]\\s*exact head${HEAD_SHA_CAPTURE}`, "i");
const REMEDIATION_MARKER = new RegExp(
  `\\bremediat\\w*\\b${NO_CROSSING_OTHER_MARKER}{0,80}?exact head${HEAD_SHA_CAPTURE}`,
  "i",
);
// Negative lookbehind: the "ACCEPTED" token itself must not be immediately
// preceded by "NOT " or "UN" (case-insensitive), so "NOT ACCEPTED — exact
// head <sha>" and "UNACCEPTED — exact head <sha>" never match this marker.
const ACCEPTED_MARKER = new RegExp(`(?<!\\bNOT\\s+)(?<!\\bUN)\\bACCEPTED\\s*[—-]\\s*exact head${HEAD_SHA_CAPTURE}`, "i");

/**
 * Classifies one owner-authored comment or review body against the explicit
 * exact-head verdict markers the owner requires: `ACCEPTED — exact head
 * <sha>`, `REJECTED — exact head <sha>`, `SUPERSEDED ... exact head <sha>`,
 * and a remediation request tied to an exact head (the same phrasing the
 * owner already uses in this repository's own remediation-cycle comments,
 * e.g. "Remediate DE-0010 at exact head <sha>"). Returns null for any body
 * that carries none of these markers, so ordinary commentary - including a
 * negated "NOT ACCEPTED"/"UNACCEPTED" phrase - is never mistaken for a
 * verdict. Checked in blocking-first order so a body that happens to
 * combine phrases never accidentally resolves to acceptance.
 */
export function classifyOwnerCommentBody(body) {
  if (typeof body !== "string") return null;
  const superseded = body.match(SUPERSEDED_MARKER);
  if (superseded) return { kind: OWNER_VERDICT_KINDS.SUPERSEDED, headSha: superseded[1].toLowerCase() };
  const rejected = body.match(REJECTED_MARKER);
  if (rejected) return { kind: OWNER_VERDICT_KINDS.REJECTED, headSha: rejected[1].toLowerCase() };
  const remediation = body.match(REMEDIATION_MARKER);
  if (remediation) return { kind: OWNER_VERDICT_KINDS.REMEDIATION_REQUESTED, headSha: remediation[1].toLowerCase() };
  const accepted = body.match(ACCEPTED_MARKER);
  if (accepted) return { kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: accepted[1].toLowerCase() };
  return null;
}

/** Trusts exactly the repository owner login, supplied by the caller - never
 * guessed, hardcoded, or derived from issue/PR content. */
export function isTrustedOwnerLogin(login, ownerLogin) {
  return (
    typeof login === "string" &&
    login.length > 0 &&
    typeof ownerLogin === "string" &&
    ownerLogin.length > 0 &&
    login.toLowerCase() === ownerLogin.toLowerCase()
  );
}

/**
 * Builds the chronologically-orderable list of owner-authored verdict events
 * for one pull request, merging owner-authored PR conversation comments with
 * owner-authored formal PR reviews. A conversation comment only counts when
 * it carries an explicit marker (see classifyOwnerCommentBody) AND has valid,
 * matching creation/update provenance (see isUneditedProvenance) - an edited
 * comment is never trusted, and a comment missing either timestamp fails
 * closed. A formal review counts either via an explicit marker in its body,
 * or - lacking one - via its own native GitHub verdict (APPROVED ->
 * accepted, CHANGES_REQUESTED -> rejected); DISMISSED and PENDING reviews are
 * excluded up front, before any marker text is even inspected, so a
 * dismissed/pending review's body can never be classified as a verdict
 * either via its native state or an explicit marker. Any other non-actionable
 * native review state (COMMENTED) without an explicit marker is likewise not
 * evidence, so a non-actionable follow-up review can never overwrite an
 * earlier real verdict. GitHub's reviews API does not expose a separate
 * edit-timestamp field the way its comments API does; callers are expected
 * to supply `updatedAt` equal to `submittedAt` for reviews (documented in
 * docs/automation/autonomy-supervisor.md), so the same provenance check
 * still fails closed on a genuinely missing/unparseable timestamp.
 */
export function buildOwnerVerdictEvents({ ownerLogin, comments = [], reviews = [] }) {
  const events = [];
  for (const comment of comments) {
    if (!isTrustedOwnerLogin(comment.authorLogin, ownerLogin)) continue;
    if (!isUneditedProvenance({ createdAt: comment.createdAt, updatedAt: comment.updatedAt })) continue;
    const classified = classifyOwnerCommentBody(comment.body);
    if (classified) events.push({ ...classified, submittedAt: comment.createdAt });
  }
  for (const review of reviews) {
    if (!isTrustedOwnerLogin(review.authorLogin, ownerLogin)) continue;
    if (review.state === "DISMISSED" || review.state === "PENDING") continue;
    if (!isUneditedProvenance({ createdAt: review.submittedAt, updatedAt: review.updatedAt })) continue;
    const classified = classifyOwnerCommentBody(review.body);
    if (classified) {
      events.push({ ...classified, submittedAt: review.submittedAt });
      continue;
    }
    if (review.state === "APPROVED") {
      events.push({ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: review.headSha, submittedAt: review.submittedAt });
    } else if (review.state === "CHANGES_REQUESTED") {
      events.push({ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: review.headSha, submittedAt: review.submittedAt });
    }
  }
  return events;
}

/**
 * Selects the chronologically latest owner verdict recorded against one
 * exact head SHA. This is the PR #24 stale-verdict race guard: if an earlier
 * ACCEPTED and a later REJECTED/SUPERSEDED/REMEDIATION_REQUESTED both exist
 * for the same exact head, the later one is authoritative and blocks
 * merge-ready dispatch - an earlier acceptance is never reachable once later
 * evidence exists at that same head. Events are supplied unsorted;
 * `submittedAt` is parsed to establish chronology.
 */
export function selectLatestOwnerVerdict(events, headSha) {
  const atHead = (events ?? []).filter((event) => event.headSha === headSha);
  if (atHead.length === 0) return null;
  const sorted = [...atHead].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  return sorted[sorted.length - 1];
}
