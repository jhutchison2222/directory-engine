import { isUneditedProvenance } from "./supervisor-provenance.mjs";

const STATE_ID_PATTERN = /^[0-9a-f]{7,64}$/;
const SUBJECT_TYPES = new Set(["pull_request", "issue"]);
const REASON_PATTERN = /^[a-z][a-z0-9_]*$/;

const MARKER_PREFIX = "<!-- autonomy-supervisor:";
const MARKER_SUFFIX = " -->";

/** The two outcomes a dispatch attempt can record. DE-0010 cycle 3/3: a prior
 * version only ever posted a marker after a *successful* dispatch, so a
 * failing Workspace Agent endpoint (a non-202 response, or a thrown network
 * error) left no evidence at all - the five-minute schedule would then retry
 * immediately and indefinitely, bypassing both retry spacing and the
 * shared remediation attempt budget. A marker is now posted for every
 * attempted dispatch, tagged with which of these two outcomes it was;
 * `outcome` is optional on parse for backward compatibility with a marker
 * posted before this field existed. */
export const DISPATCH_OUTCOMES = Object.freeze({ DISPATCHED: "dispatched", FAILED: "failed" });

/**
 * Builds the deterministic exact-state/reason idempotency key that identifies
 * "this exact subject, in this exact reviewed state, for this exact reason".
 * `stateId` is the PR's head SHA for a pull request, or a content fingerprint
 * for an issue (see computeIssueStateFingerprint); either way, any change to
 * the underlying state produces a new key, which is how stale evidence gets
 * invalidated rather than silently reused.
 */
export function buildIdempotencyKey({ subjectType, subjectNumber, stateId, reason }) {
  if (!SUBJECT_TYPES.has(subjectType)) {
    throw new Error(`buildIdempotencyKey: unsupported subjectType "${subjectType}"`);
  }
  if (!Number.isInteger(subjectNumber) || subjectNumber <= 0) {
    throw new Error("buildIdempotencyKey: subjectNumber must be a positive integer");
  }
  if (typeof stateId !== "string" || !STATE_ID_PATTERN.test(stateId)) {
    throw new Error(`buildIdempotencyKey: stateId "${stateId}" must be a lowercase hex string of length 7-64`);
  }
  if (typeof reason !== "string" || !REASON_PATTERN.test(reason)) {
    throw new Error(`buildIdempotencyKey: reason "${reason}" must be lowercase snake_case`);
  }
  return `${subjectType}:${subjectNumber}:${stateId}:${reason}`;
}

/**
 * Inverse of buildIdempotencyKey. Returns null for anything that does not
 * round-trip to a well-formed key, so a malformed or forged-looking key can
 * never be attributed a subjectType/subjectNumber/stateId/reason by
 * accident. Used to aggregate dispatch history across equivalent
 * remediation reasons for the same exact subject/state (the retry-attempt
 * cap counts "remediation cycles", not "times this exact wording was sent").
 */
export function parseIdempotencyKey(key) {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts.length !== 4) return null;
  const [subjectType, subjectNumberRaw, stateId, reason] = parts;
  const subjectNumber = Number(subjectNumberRaw);
  if (!SUBJECT_TYPES.has(subjectType)) return null;
  if (!Number.isInteger(subjectNumber) || subjectNumber <= 0) return null;
  if (!STATE_ID_PATTERN.test(stateId)) return null;
  if (!REASON_PATTERN.test(reason)) return null;
  return { subjectType, subjectNumber, stateId, reason };
}

/** The exact GitHub identity the supervisor itself posts dispatch markers
 * as. Injectable so tests never hardcode a magic string inline and so a
 * differently-configured deployment could override it explicitly. */
export const DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN = "github-actions[bot]";
export const DEFAULT_TRUSTED_MARKER_AUTHOR_TYPE = "Bot";

/**
 * DE-0010 cycle 2/3: a prior version parsed a dispatch marker out of *any*
 * issue/PR comment with no author check at all. Because the marker format
 * (subject type, number, head SHA, reason string) is entirely public, any
 * commenter could forge one with a future `dispatchedAt` and silence the
 * supervisor for that subject indefinitely. Only a comment authored by the
 * exact trusted marker-author identity (by default the supervisor's own
 * `github-actions[bot]` identity, of type `Bot`) is ever trusted as
 * dispatch-ledger evidence.
 */
export function isTrustedDispatchMarkerAuthor(
  author,
  { login = DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN, type = DEFAULT_TRUSTED_MARKER_AUTHOR_TYPE } = {},
) {
  return (
    typeof author?.login === "string" &&
    author.login === login &&
    typeof author?.type === "string" &&
    author.type === type
  );
}

/**
 * Parses only the trusted-author subset of a comment list into dispatch
 * markers, silently discarding any comment from an untrusted author -
 * including one whose body would otherwise parse as a well-formed marker.
 * `comments` is `{ body, author: { login, type }, createdAt, updatedAt }[]`.
 *
 * Security redesign (owner-authorized): trusting a marker purely by author
 * identity is not enough - GitHub lets a comment be edited after posting
 * while its reported author stays unchanged, so a marker comment's body
 * could in principle be rewritten after the supervisor posted it. A marker
 * is only ever trusted when its `createdAt`/`updatedAt` are present,
 * parseable, and exactly equal (see isUneditedProvenance); a missing or
 * differing timestamp fails closed exactly like an untrusted author.
 */
export function filterTrustedDispatchMarkers(comments, trustedAuthor = {}) {
  const markers = [];
  for (const comment of comments ?? []) {
    if (!isTrustedDispatchMarkerAuthor(comment?.author, trustedAuthor)) continue;
    if (!isUneditedProvenance({ createdAt: comment?.createdAt, updatedAt: comment?.updatedAt })) continue;
    const marker = parseDispatchMarker(comment?.body);
    if (marker !== null) markers.push(marker);
  }
  return markers;
}

/**
 * Renders the hidden HTML-comment bookkeeping marker posted to the subject's
 * comment thread after every attempted dispatch, whether it succeeded or
 * failed. The marker never carries the Workspace Agent token or any other
 * credential material - only the idempotency key, dispatch timestamp, and
 * (optionally) the outcome needed to detect duplicates and to count failed
 * attempts toward retry spacing and the remediation attempt budget.
 */
export function formatDispatchMarker({ key, dispatchedAt, outcome }) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("formatDispatchMarker: key is required");
  }
  if (Number.isNaN(Date.parse(dispatchedAt))) {
    throw new Error(`formatDispatchMarker: dispatchedAt "${dispatchedAt}" is not a parseable date-time`);
  }
  if (outcome !== undefined && !Object.values(DISPATCH_OUTCOMES).includes(outcome)) {
    throw new Error(`formatDispatchMarker: outcome "${outcome}" must be one of ${Object.values(DISPATCH_OUTCOMES).join(", ")}`);
  }
  const payload = JSON.stringify(outcome === undefined ? { key, dispatchedAt } : { key, dispatchedAt, outcome });
  return (
    `${MARKER_PREFIX}${payload}${MARKER_SUFFIX}\n` +
    "Autonomy supervisor recorded a dispatch attempt for this exact-state evidence. " +
    "This marker records dispatch bookkeeping only; it is not a review, acceptance, or merge decision."
  );
}

/**
 * Recovers a previously posted dispatch marker from a comment body. Returns
 * null for any comment that is not a well-formed marker so ordinary human and
 * bot commentary is never mistaken for dispatch history.
 */
export function parseDispatchMarker(commentBody) {
  if (typeof commentBody !== "string") return null;
  const start = commentBody.indexOf(MARKER_PREFIX);
  if (start === -1) return null;
  const end = commentBody.indexOf(MARKER_SUFFIX, start);
  if (end === -1) return null;
  const rawPayload = commentBody.slice(start + MARKER_PREFIX.length, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (typeof parsed.key !== "string" || parsed.key.length === 0) return null;
  if (typeof parsed.dispatchedAt !== "string" || Number.isNaN(Date.parse(parsed.dispatchedAt))) return null;
  const marker = { key: parsed.key, dispatchedAt: parsed.dispatchedAt };
  if (typeof parsed.outcome === "string" && Object.values(DISPATCH_OUTCOMES).includes(parsed.outcome)) {
    marker.outcome = parsed.outcome;
  }
  return marker;
}
