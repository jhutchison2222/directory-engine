import { AUTONOMY_BLOCKED_LABEL, evaluatePullRequestAction, selectQueuedTasks } from "./supervisor-policy.mjs";
import { formatDispatchMarker } from "./supervisor-idempotency.mjs";

/**
 * Applies one already-computed decision: dispatches to the Workspace Agent
 * and records the dispatch marker when the decision is "dispatch", applies
 * AUTONOMY_BLOCKED_LABEL when the decision is "blocked" (the exact-head/
 * reason retry cap was reached), otherwise just reports the skip/hold reason.
 * Isolated into its own function so a dispatch, labeling, or comment-posting
 * failure for one subject cannot be conflated with the decision logic
 * itself.
 */
async function applyDecision({ subjectType, number, headSha, decision, now, deps }) {
  if (decision.action === "blocked") {
    await deps.addLabel(subjectType, number, AUTONOMY_BLOCKED_LABEL);
    return { status: "blocked", reason: decision.reason, idempotencyKey: decision.idempotencyKey };
  }

  if (decision.action !== "dispatch") {
    return { status: decision.action, reason: decision.reason, idempotencyKey: decision.idempotencyKey ?? null };
  }

  const dispatchResult = await deps.dispatchToWorkspaceAgent({
    idempotencyKey: decision.idempotencyKey,
    reason: decision.reason,
    subject: { type: subjectType, number, headSha: headSha ?? null },
  });

  if (!dispatchResult.ok) {
    return { status: "dispatch_failed", reason: decision.reason, idempotencyKey: decision.idempotencyKey };
  }

  const marker = formatDispatchMarker({ key: decision.idempotencyKey, dispatchedAt: now.toISOString() });
  await deps.postDispatchMarker(subjectType, number, marker);

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
