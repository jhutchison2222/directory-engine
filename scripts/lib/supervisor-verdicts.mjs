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
 * 3. A conversation comment is only ever trusted when it carries valid,
 *    matching creation/update provenance (see isUneditedProvenance) - an
 *    edited owner comment (whether edited by the owner or, per GitHub's
 *    collaborator comment-editing model, by another user while the
 *    original author is preserved) is never trusted as evidence, and a
 *    missing/unparseable timestamp fails closed rather than being trusted
 *    by default.
 *
 * Follow-up remediation: an earlier version of item 3 also applied to
 * formal reviews, using `updatedAt: review.submittedAt` as a stand-in
 * provenance value. That was a manufactured equality, not a real edit
 * check - GitHub's list-reviews REST response has no field that reflects
 * whether a review's body was edited after submission, so comparing
 * `submittedAt` to itself always "passed" and made the check meaningless
 * for reviews. Rather than manufacture missing provenance, formal reviews
 * no longer honor explicit body markers at all (see buildOwnerVerdictEvents
 * below): they are trusted only via their own immutable native GitHub
 * verdict (APPROVED/CHANGES_REQUESTED), which GitHub itself invalidates by
 * superseding a review on a new submission or explicit dismissal - not by a
 * self-reported timestamp this module cannot verify. Owner-authored
 * conversation comments are unaffected: GitHub's issue-comments API does
 * expose a real, independent `updated_at`, so their provenance check still
 * has something genuine to verify.
 *
 * Second follow-up remediation: item 1's original ACCEPTED marker scanned
 * for the substring "ACCEPTED - exact head <sha>" anywhere in a body, with
 * two negative lookbehinds patched on to reject the exact literal prefixes
 * "NOT " and "UN" immediately before the word. That only ever blocked those
 * two literal phrasings - "NOT YET ACCEPTED", "NEVER ACCEPTED",
 * "NON-ACCEPTED", "UN-ACCEPTED", and ordinary prose that merely contains the
 * word "accepted" elsewhere in a sentence could all still match and be
 * misread as acceptance. Rather than enumerate more negations, the ACCEPTED
 * marker is now anchored to require a whole standalone line: once optional,
 * letter-free Markdown decoration (bold/italic markers, heading/bullet
 * markers, backticks/quotes, whitespace) is stripped from each end of a
 * line, the remainder must read exactly `ACCEPTED — exact head <sha>`. Any
 * literal word before "ACCEPTED" on that line - a negation, a qualifier, or
 * ordinary prose - contains letters, which the decoration class excludes, so
 * the line-start anchor rejects the whole line rather than merely a
 * hand-picked list of phrasings. This applies only to ACCEPTED: the
 * REJECTED/SUPERSEDED/remediation markers below are unchanged and are still
 * checked first, so blocking evidence combined with an accepted-looking
 * clause in the same body still resolves to the blocking verdict.
 *
 * DE-0010-R1: the decoration class above originally also stripped the
 * Markdown blockquote marker `>`, on the theory that it was harmless
 * rendering decoration like bold/italic. It is not: a blockquote is how
 * GitHub renders a *quoted* line - a reply quoting someone else's earlier
 * comment, or the owner quoting a rejected/superseded draft of a marker
 * while discussing it - and quoting a line is not the same act as asserting
 * it. `> ACCEPTED — exact head <sha>` must never itself create acceptance,
 * regardless of who posted the quoting comment or whether the quoted head
 * matches. `>` is therefore no longer part of LINE_DECORATION, so any line
 * beginning with a blockquote marker can never satisfy the standalone
 * ACCEPTED anchor; only a genuinely unquoted marker line still matches.
 *
 * DE-0010-R1 cycle 3 (final): the blockquote fix only closed one of
 * GitHub's three ways to render a line as quoted example text rather than
 * an assertion. A fenced (```) or 4-space/tab-indented ACCEPTED line was
 * still classified as real acceptance, because LINE_DECORATION's `\s`
 * matched the newline separating a fence delimiter from the marker line
 * (letting decoration "eat through" the fence), and because plain leading
 * whitespace was already part of LINE_DECORATION regardless of how much of
 * it there was (so 4+ leading spaces - CommonMark's indented-code
 * threshold - stripped just like ordinary line-start padding). Both gaps
 * are closed below: LINE_DECORATION is now restricted to horizontal
 * whitespace only (see its own comment), and neutralizeQuotedCodeLines
 * blanks out fenced/indented code lines before the ACCEPTED marker is ever
 * matched against a body.
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
// their "anything up to 80 chars" span (which, unlike ACCEPTED_MARKER, is
// not line-anchored and may cross newlines) can never cross over one of the
// OTHER marker keywords on its way to an "exact head" phrase. Without this,
// a body like "DE-0010 remediation cycle 2/3 complete.\n\nACCEPTED — exact
// head <sha>" lets REMEDIATION_MARKER's lookahead jump straight past the
// standalone ACCEPTED line to capture that clause's own head reference,
// misclassifying a real acceptance as a remediation request.
const NO_CROSSING_OTHER_MARKER = "(?:(?!ACCEPTED|REJECTED|SUPERSEDED)[\\s\\S])";

const SUPERSEDED_MARKER = new RegExp(`\\bSUPERSEDED\\b${NO_CROSSING_OTHER_MARKER}{0,80}?exact head${HEAD_SHA_CAPTURE}`, "i");
const REJECTED_MARKER = new RegExp(`\\bREJECTED\\s*[—-]\\s*exact head${HEAD_SHA_CAPTURE}`, "i");
const REMEDIATION_MARKER = new RegExp(
  `\\bremediat\\w*\\b${NO_CROSSING_OTHER_MARKER}{0,80}?exact head${HEAD_SHA_CAPTURE}`,
  "i",
);
// Letter-free Markdown/whitespace decoration that may harmlessly wrap a
// standalone ACCEPTED marker line: emphasis markers, heading/bullet markers,
// backticks/quotes around a code-span SHA, and plain horizontal whitespace.
// Because it contains no letters, any negated or qualified phrase ("NOT YET
// ACCEPTED", "NEVER ACCEPTED", "NON-ACCEPTED", "UN-ACCEPTED") or ordinary
// prose preceding the word "ACCEPTED" can never be consumed by this class,
// so the line-start anchor below can never reach past it to the literal
// "ACCEPTED" token. `>` (the Markdown blockquote marker) is deliberately
// excluded: a blockquoted line is a *quoted* line, not an assertion, and
// must never satisfy this marker regardless of what it quotes.
//
// DE-0010-R1 cycle 3: deliberately uses ` \t` (horizontal whitespace only),
// not `\s`. `\s` also matches `\n`, which let this decoration class consume
// an entire fenced-code delimiter line (and the newline separating it from
// the marker line) so that a ```-fenced ACCEPTED line still matched the
// line-start/line-end anchors below - the same "quoting is not asserting"
// gap the blockquote fix closed, reopened via a sibling GitHub quoting
// mechanism. Restricting decoration to a single line means it can never
// bridge across a line boundary on its own; neutralizeQuotedCodeLines below
// closes the rest of the gap (a fenced/indented ACCEPTED line with no
// decoration on its own line at all).
const LINE_DECORATION = "[ \\t*_#`'\"-]*";

// The only pattern that can ever create an ACCEPTED verdict: a standalone
// marker line that, once LINE_DECORATION is stripped from each end, reads
// exactly `ACCEPTED — exact head <sha>`. Matched per-line ("m" flag) so the
// marker may appear on its own line anywhere within a longer, multi-line
// comment body, but never as a fragment of a line that also carries other
// text.
const ACCEPTED_MARKER = new RegExp(
  `^${LINE_DECORATION}ACCEPTED\\s*[—-]\\s*exact head${HEAD_SHA_CAPTURE}${LINE_DECORATION}$`,
  "im",
);

// Matches a fenced-code delimiter line under CommonMark's fenced-code-block
// rule: 0-3 leading spaces, then 3+ backticks or 3+ tildes (an optional
// trailing "info string", e.g. ```js, is irrelevant to open/close matching
// and is not captured).
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

// Matches an indented-code line under CommonMark's indented-code-block rule:
// 4+ leading spaces or a leading tab.
const INDENTED_CODE_LINE = /^(?: {4}|\t)/;

function isFenceClose(line, fenceChar, fenceLength) {
  const trimmed = line.trim();
  if (trimmed.length < fenceLength) return false;
  for (const char of trimmed) {
    if (char !== fenceChar) return false;
  }
  return true;
}

/**
 * Blanks out every line GitHub would render as code - fenced code block
 * lines (both delimiters and everything between them) and indented code
 * block lines (4+ leading spaces or a leading tab) - before the ACCEPTED
 * marker is matched against a comment body. This is what makes "quoting is
 * not asserting" hold for GitHub's other two code-quoting mechanisms, not
 * only the blockquote (`>`) form the first DE-0010-R1 cycle closed: an owner
 * pasting a stale/rejected ACCEPTED line inside ```backticks``` or a
 * 4-space-indented block to discuss it must never itself create a real
 * verdict. Line count and the content of every non-code line are preserved
 * exactly, so a genuine unquoted marker line elsewhere in the same body
 * still matches at its real position. Deliberately applied only ahead of the
 * ACCEPTED_MARKER match, not the REJECTED/SUPERSEDED/REMEDIATION_REQUESTED
 * markers below: those are blocking markers, so a quoted occurrence
 * incorrectly matching is a conservative (fail-closed) false positive, not a
 * new escalation, and is left as documented pre-existing behavior rather
 * than risk changing their matching semantics in this cycle.
 */
function neutralizeQuotedCodeLines(body) {
  const lines = body.split("\n");
  let fenceChar = null;
  let fenceLength = 0;
  const neutralized = lines.map((line) => {
    if (fenceChar) {
      if (isFenceClose(line, fenceChar, fenceLength)) {
        fenceChar = null;
        fenceLength = 0;
      }
      return "";
    }
    const openMatch = line.match(FENCE_OPEN);
    if (openMatch) {
      fenceChar = openMatch[1][0];
      fenceLength = openMatch[1].length;
      return "";
    }
    if (INDENTED_CODE_LINE.test(line)) return "";
    return line;
  });
  return neutralized.join("\n");
}

/**
 * Classifies one owner-authored comment or review body against the explicit
 * exact-head verdict markers the owner requires: a standalone `ACCEPTED —
 * exact head <sha>` marker line, `REJECTED — exact head <sha>`, `SUPERSEDED
 * ... exact head <sha>`, and a remediation request tied to an exact head
 * (the same phrasing the owner already uses in this repository's own
 * remediation-cycle comments, e.g. "Remediate DE-0010 at exact head
 * <sha>"). Returns null for any body that carries none of these markers, so
 * ordinary commentary - including a negated/qualified non-acceptance phrase
 * ("NOT ACCEPTED", "NOT YET ACCEPTED", "NEVER ACCEPTED", "NON-ACCEPTED",
 * "UN-ACCEPTED") or incidental prose that merely mentions "accepted" - is
 * never mistaken for a verdict. Checked in blocking-first order so a body
 * that happens to combine phrases never accidentally resolves to
 * acceptance.
 */
export function classifyOwnerCommentBody(body) {
  if (typeof body !== "string") return null;
  const superseded = body.match(SUPERSEDED_MARKER);
  if (superseded) return { kind: OWNER_VERDICT_KINDS.SUPERSEDED, headSha: superseded[1].toLowerCase() };
  const rejected = body.match(REJECTED_MARKER);
  if (rejected) return { kind: OWNER_VERDICT_KINDS.REJECTED, headSha: rejected[1].toLowerCase() };
  const remediation = body.match(REMEDIATION_MARKER);
  if (remediation) return { kind: OWNER_VERDICT_KINDS.REMEDIATION_REQUESTED, headSha: remediation[1].toLowerCase() };
  const accepted = neutralizeQuotedCodeLines(body).match(ACCEPTED_MARKER);
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
 * owner-authored formal PR reviews.
 *
 * A conversation comment only counts when it carries an explicit marker (see
 * classifyOwnerCommentBody) AND has valid, matching creation/update
 * provenance (see isUneditedProvenance) - an edited comment is never
 * trusted, and a comment missing either timestamp fails closed. GitHub's
 * issue-comments API exposes a genuine, independent `updated_at`, so this
 * check has real edit evidence to verify.
 *
 * A formal review is trusted only via its own immutable native GitHub
 * verdict - APPROVED -> accepted, CHANGES_REQUESTED -> rejected - never via
 * an explicit marker in its body. GitHub's list-reviews response has no
 * field that reflects whether a review body was edited after submission
 * (unlike comments' `updated_at`), so there is no way to verify a review
 * body has not been rewritten after the fact; rather than manufacture or
 * skip that check, explicit body markers are simply never honored for
 * reviews - only the state GitHub itself records and enforces is trusted.
 * DISMISSED and PENDING reviews are excluded up front, so a dismissed or
 * still-pending review's state can never be classified as a verdict. Any
 * other non-actionable native state (COMMENTED) is likewise not evidence,
 * so a non-actionable follow-up review can never overwrite an earlier real
 * verdict.
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
