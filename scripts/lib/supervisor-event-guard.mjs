import { AUTONOMY_READY_LABEL } from "./supervisor-policy.mjs";

/**
 * Pure gate deciding whether one native GitHub Actions webhook invocation
 * should proceed to a full supervisor evaluation cycle. This is the
 * event-driven entry path's guard: it runs before any credential is read or
 * any dispatch is attempted, so an irrelevant, out-of-repository, or
 * self/bot-generated event never reaches decision logic at all.
 *
 * The scheduled five-minute tick and `workflow_dispatch` always proceed - the
 * event-driven path is an additive fast path, never a replacement for the
 * recovery backstop.
 */

const RELEVANT_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "closed",
]);

const RELEVANT_REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);

const RELEVANT_COMMENT_ACTIONS = new Set(["created", "edited"]);

/** Governance/Claude workflow names whose completion is relevant to
 * supervision. Any other workflow_run is ignored before any dispatch. */
const SUPERVISED_WORKFLOW_RUN_NAMES = new Set(["Project governance", "Claude Code"]);

/** Matches the supervisor's own actor identity and any Claude-implementer
 * identity, so the supervisor never reacts to its own dispatch-marker
 * comments or label changes (recursion prevention). */
const SELF_OR_RECURSIVE_ACTOR_PATTERN = /claude|autonomy-supervisor/i;

/** GitHub identities that must never bypass the bot-actor recursion guard,
 * regardless of any injected trusted-identity configuration. This is a
 * hardcoded exclusion (never overridable via `trustedBotLogins`) so that a
 * misconfigured or overly broad trusted-login list could never re-enable
 * recursion against the supervisor's own `GITHUB_TOKEN`-authored dispatch
 * markers and label changes. */
const NEVER_TRUSTED_BOT_LOGINS = new Set(["github-actions[bot]"]);

function isExplicitlyTrustedBotLogin(senderLogin, trustedBotLogins) {
  if (typeof senderLogin !== "string" || senderLogin.length === 0) return false;
  const normalized = senderLogin.toLowerCase();
  if (NEVER_TRUSTED_BOT_LOGINS.has(normalized)) return false;
  return (trustedBotLogins ?? []).some(
    (login) => typeof login === "string" && login.toLowerCase() === normalized,
  );
}

/**
 * DE-0010 cycle 3/3: a prior version rejected *every* non-`workflow_run`
 * event whose sender type was `Bot`, which is the correct default for
 * recursion prevention (the supervisor's own `github-actions[bot]` marker
 * posts, dependabot, etc.) but also silently discarded a review or comment
 * posted by a specifically trusted reviewer/agent identity - GitHub App and
 * bot-type integration accounts post as sender type `Bot` too, so the fast
 * event-driven path never fired for exactly the kind of evidence
 * (independent review/handoff) it exists to react to quickly; only the
 * five-minute schedule ever picked it up. `trustedBotLogins` is an
 * explicit, injectable allowlist the caller supplies from a fixed reviewed
 * configuration or verified environment (e.g. an environment variable set
 * by the workflow) - never from issue/PR content - and defaults to empty,
 * so behavior is unchanged (every bot actor is still rejected) until a
 * caller explicitly configures one. `NEVER_TRUSTED_BOT_LOGINS` always wins
 * over this allowlist.
 */
export function shouldHandleEvent({
  eventName,
  payloadAvailable = true,
  action,
  repositoryFullName,
  expectedRepositoryFullName,
  senderLogin,
  senderType,
  isPullRequestComment = false,
  labels = [],
  workflowName,
  trustedBotLogins = [],
} = {}) {
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    return { handle: true, reason: eventName };
  }

  // A missing or unreadable event payload for any guarded event-driven
  // invocation must fail closed rather than fall back to an unguarded scan;
  // only the schedule/manual paths above may proceed without one.
  if (!payloadAvailable) {
    return { handle: false, reason: "missing_or_unreadable_event_payload" };
  }

  if (typeof expectedRepositoryFullName === "string" && repositoryFullName !== expectedRepositoryFullName) {
    return { handle: false, reason: "wrong_repository" };
  }

  if (typeof senderLogin === "string" && SELF_OR_RECURSIVE_ACTOR_PATTERN.test(senderLogin)) {
    return { handle: false, reason: "self_or_recursive_actor" };
  }

  // workflow_run's effective actor is GitHub itself completing a run, not a
  // human or bot posting new content, so the generic bot check does not apply
  // to it; every other event type ignores bot-authored activity to prevent
  // recursion against the supervisor's own GITHUB_TOKEN-authored comments and
  // labels, and against unrelated bot noise (e.g. dependabot) - unless the
  // sender is on the caller-supplied trusted-bot allowlist (never
  // github-actions[bot], see NEVER_TRUSTED_BOT_LOGINS).
  if (
    eventName !== "workflow_run" &&
    senderType === "Bot" &&
    !isExplicitlyTrustedBotLogin(senderLogin, trustedBotLogins)
  ) {
    return { handle: false, reason: "bot_actor" };
  }

  switch (eventName) {
    case "pull_request":
      if (!RELEVANT_PULL_REQUEST_ACTIONS.has(action)) {
        return { handle: false, reason: "irrelevant_pull_request_action" };
      }
      return { handle: true, reason: "pull_request_event" };

    case "pull_request_review":
      if (!RELEVANT_REVIEW_ACTIONS.has(action)) {
        return { handle: false, reason: "irrelevant_review_action" };
      }
      return { handle: true, reason: "pull_request_review_event" };

    case "issue_comment":
      if (!RELEVANT_COMMENT_ACTIONS.has(action)) {
        return { handle: false, reason: "irrelevant_comment_action" };
      }
      if (!isPullRequestComment && !labels.includes(AUTONOMY_READY_LABEL)) {
        return { handle: false, reason: "not_pull_request_or_autonomy_ready" };
      }
      return { handle: true, reason: "issue_comment_event" };

    case "workflow_run":
      if (action !== "completed") {
        return { handle: false, reason: "irrelevant_workflow_run_action" };
      }
      if (!SUPERVISED_WORKFLOW_RUN_NAMES.has(workflowName)) {
        return { handle: false, reason: "unsupervised_workflow" };
      }
      return { handle: true, reason: "workflow_run_event" };

    default:
      return { handle: false, reason: "unrecognized_event" };
  }
}
