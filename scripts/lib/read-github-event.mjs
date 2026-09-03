import { readFileSync } from "node:fs";

/**
 * Reads and parses the local GitHub Actions event payload file (the runner
 * writes this to disk before the job starts; `GITHUB_EVENT_PATH` names it).
 * The payload is treated purely as untrusted JSON DATA - it is parsed here
 * and nothing else; it is never sourced, evaluated, or passed to a shell.
 * A missing or unparseable payload is reported via `payloadAvailable:
 * false` rather than thrown, so callers can fail closed instead of
 * crashing. Shared by both of DE-0010's entry scripts (the unprivileged
 * wake script and the secret-bearing supervisor script) so the same
 * file-reading behavior is guaranteed identical between them.
 */
export function readGithubEvent(env = process.env) {
  const eventName = env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPath = env.GITHUB_EVENT_PATH;
  let payload = null;
  let payloadAvailable = false;
  if (typeof eventPath === "string" && eventPath.trim().length > 0) {
    try {
      payload = JSON.parse(readFileSync(eventPath, "utf8"));
      payloadAvailable = true;
    } catch {
      payloadAvailable = false;
    }
  }
  return { eventName, payload, payloadAvailable };
}

/** Parses the fixed, reviewed, non-secret environment variable naming any
 * GitHub bot identity trusted to bypass the generic bot-actor recursion
 * guard (see NEVER_TRUSTED_BOT_LOGINS in supervisor-event-guard.mjs, which
 * still always rejects github-actions[bot] regardless of this value). This
 * is read from the process environment only - never from issue/PR content,
 * a label, or any other repository-controlled text - and is optional: if
 * unset, no bot identity beyond the hardcoded exclusions is trusted. */
export function parseTrustedBotLogins(rawValue) {
  if (typeof rawValue !== "string") return [];
  return rawValue
    .split(",")
    .map((login) => login.trim())
    .filter((login) => login.length > 0);
}
