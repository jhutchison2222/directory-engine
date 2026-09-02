const STATE_ID_PATTERN = /^[0-9a-f]{7,64}$/;
const SUBJECT_TYPES = new Set(["pull_request", "issue"]);
const REASON_PATTERN = /^[a-z][a-z0-9_]*$/;

const MARKER_PREFIX = "<!-- autonomy-supervisor:";
const MARKER_SUFFIX = " -->";

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
 * Renders the hidden HTML-comment bookkeeping marker posted to the subject's
 * comment thread after a successful dispatch. The marker never carries the
 * Workspace Agent token or any other credential material - only the
 * idempotency key and dispatch timestamp needed to detect duplicates.
 */
export function formatDispatchMarker({ key, dispatchedAt }) {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("formatDispatchMarker: key is required");
  }
  if (Number.isNaN(Date.parse(dispatchedAt))) {
    throw new Error(`formatDispatchMarker: dispatchedAt "${dispatchedAt}" is not a parseable date-time`);
  }
  const payload = JSON.stringify({ key, dispatchedAt });
  return (
    `${MARKER_PREFIX}${payload}${MARKER_SUFFIX}\n` +
    "Autonomy supervisor dispatched the Workspace Agent for this exact-state evidence. " +
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
  return { key: parsed.key, dispatchedAt: parsed.dispatchedAt };
}
