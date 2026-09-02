import { AUTONOMY_BLOCKED_LABEL, evaluatePullRequestAction, selectQueuedTasks } from "./supervisor-policy.mjs";
import { DISPATCH_OUTCOMES, formatDispatchMarker } from "./supervisor-idempotency.mjs";

/**
 * Applies one already-computed decision: dispatches to the Workspace Agent
 * and records a trusted dispatch marker for every attempted dispatch -
 * success or failure - when the decision is "dispatch", applies
 * AUTONOMY_BLOCKED_LABEL when the decision is "blocked" (the exact-head/
 * reason retry cap was reached), otherwise just reports the skip/hold reason.
 * Isolated into its own function so a dispatch, labeling, or comment-posting
 * failure for one subject cannot be conflated with the decision logic
 * itself.
 *
 * DE-0010 cycle 3/3: a prior version only posted a marker after a
 * *successful* dispatch. A non-202 response, or a thrown error (e.g. the
 * dispatch endpoint refusing a redirect, or a network failure), left no
 * evidence at all, so the five-minute schedule retried immediately and
 * indefinitely for a persistently failing endpoint - bypassing both retry
 * spacing (RETRY_INTERVAL_MS) and the shared remediation attempt budget
 * (MAX_DISPATCH_ATTEMPTS_PER_KEY), both of which count every marker
 * regardless of its outcome. A marker recording the outcome (never a
 * credential) is now posted for every attempted dispatch.
 */
async function applyDecision({ subjectType, number, headSha, decision, now, deps }) {
  if (decision.action === "blocked") {
    await deps.addLabel(subjectType, number, AUTONOMY_BLOCKED_LABEL);
    return { status: "blocked", reason: decision.reason, idempotencyKey: decision.idempotencyKey };
  }

  if (decision.action !== "dispatch") {
    return { status: decision.action, reason: decision.reason, idempotencyKey: decision.idempotencyKey ?? null };
  }

  let dispatchResult;
  try {
    dispatchResult = await deps.dispatchToWorkspaceAgent({
      idempotencyKey: decision.idempotencyKey,
      reason: decision.reason,
      subject: { type: subjectType, number, headSha: headSha ?? null },
    });
  } catch {
    // A thrown dispatch (e.g. the endpoint refusing a redirect, or a network
    // failure) is still one attempted dispatch and must be recorded exactly
    // like an ordinary non-202 response; dispatchToWorkspaceAgent never
    // throws with the token in its message, and nothing about the error is
    // persisted here.
    dispatchResult = { ok: false };
  }

  const marker = formatDispatchMarker({
    key: decision.idempotencyKey,
    dispatchedAt: now.toISOString(),
    outcome: dispatchResult.ok ? DISPATCH_OUTCOMES.DISPATCHED : DISPATCH_OUTCOMES.FAILED,
  });
  await deps.postDispatchMarker(subjectType, number, marker);

  if (!dispatchResult.ok) {
    return { status: "dispatch_failed", reason: decision.reason, idempotencyKey: decision.idempotencyKey };
  }

  return { status: "dispatched", reason: decision.reason, idempotencyKey: decision.idempotencyKey };
}

/**
 * Runs one supervisor evaluation cycle over every supervised pull request and
 * queued issue. Every dependency is injected so this orchestrator is fully
 * deterministic and network-free under test:
 *
 * - `now`: a Date, the single evaluation instant for this cycle.
 * - `listPullRequests()`: resolves non-draft-or-draft PR snapshots
 *   `{ number, headSha, isDraft, labels, checks, ownerVerdictEvents }`
 *   (`ownerVerdictEvents` already filtered to the trusted repository owner
 *   login by the caller, and `checks` already scoped to the named
 *   governance CI check).
 * - `listIssues()`: resolves open issue snapshots `{ number, labels, title,
 *   body }`.
 * - `listDispatchMarkers(subjectType, number)`: resolves prior
 *   `{ key, dispatchedAt }` dispatch records for one subject, already
 *   restricted to the trusted marker-author identity by the caller.
 * - `dispatchToWorkspaceAgent({ idempotencyKey, reason, subject })`: resolves
 *   `{ ok, status }`. The caller's implementation is responsible for
 *   supplying repository identity to the underlying request; this
 *   orchestrator only ever supplies `subject.headSha` when one applies.
 * - `postDispatchMarker(subjectType, number, markerBody)`: records a
 *   dispatch marker.
 * - `addLabel(subjectType, number, label)`: applies a label to the subject;
 *   used only to apply AUTONOMY_BLOCKED_LABEL once the retry cap is reached.
 *
 * Each subject is evaluated and applied inside its own try/catch so one
 * subject's failure never stops evaluation of the rest (per-item failure
 * isolation). Active pull-request work takes precedence: as long as any
 * non-draft pull request is under supervision at all, queued issues are left
 * untouched this cycle - even if that pull request needs no dispatch on this
 * specific tick - because it is not yet in a terminal (merged/closed) state.
 * Queued autonomous work only ever starts once the non-draft pull-request
 * pipeline is completely empty.
 */
export async function runAutonomySupervisor(deps) {
  const { now, listPullRequests, listIssues, listDispatchMarkers } = deps;
  const results = [];

  const pullRequests = await listPullRequests();
  for (const pr of pullRequests) {
    try {
      const dispatches = await listDispatchMarkers("pull_request", pr.number);
      const decision = evaluatePullRequestAction(pr, now, dispatches);
      const outcome = await applyDecision({
        subjectType: "pull_request",
        number: pr.number,
        headSha: pr.headSha,
        decision,
        now,
        deps,
      });
      results.push({ subjectType: "pull_request", number: pr.number, ...outcome });
    } catch (error) {
      results.push({ subjectType: "pull_request", number: pr.number, status: "error", message: error.message });
    }
  }

  const hasActivePullRequestWork = pullRequests.some((pr) => !pr.isDraft);
  if (hasActivePullRequestWork) {
    return results;
  }

  const issues = await listIssues();
  const itemsWithDispatches = [];
  for (const issue of issues) {
    try {
      const dispatches = await listDispatchMarkers("issue", issue.number);
      itemsWithDispatches.push({ issue, dispatches });
    } catch (error) {
      results.push({ subjectType: "issue", number: issue.number, status: "error", message: error.message });
    }
  }

  const queued = selectQueuedTasks(itemsWithDispatches, now);
  for (const { issue, decision } of queued) {
    try {
      const outcome = await applyDecision({ subjectType: "issue", number: issue.number, decision, now, deps });
      results.push({ subjectType: "issue", number: issue.number, ...outcome });
    } catch (error) {
      results.push({ subjectType: "issue", number: issue.number, status: "error", message: error.message });
    }
  }

  return results;
}
