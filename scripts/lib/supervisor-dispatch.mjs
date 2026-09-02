const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

/**
 * Fixed, code-reviewed trigger endpoint for the dedicated ChatGPT Workspace
 * Agent. It is a literal module constant, never read from a repository
 * variable, secret, issue/PR body, label, or any other repository content,
 * so it cannot be redirected or derived from untrusted repository content.
 *
 * This value is an RFC 2606 reserved ".invalid" placeholder. This work
 * packet's available tool access (no `gh`, `curl`, `WebFetch`, or unscoped
 * shell) could not independently confirm the literal fixed endpoint that
 * issue #25 authorizes, and this repository's policy is to never assert or
 * guess a live external system fact. Codex/owner review must confirm and
 * replace this constant with the verified literal endpoint before any live
 * dispatch is authorized; until then this endpoint cannot resolve, so a
 * misconfigured deployment fails closed instead of silently calling the
 * wrong host.
 */
export const WORKSPACE_AGENT_TRIGGER_ENDPOINT = "https://chatgpt-workspace-agent.invalid/v1/directory-engine/trigger";

export function validateAgentId(agentId) {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new Error("CHATGPT_WORKSPACE_AGENT_ID is missing or empty");
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("CHATGPT_WORKSPACE_AGENT_ID does not match the expected agent-id format");
  }
  return agentId;
}

export function requireWorkspaceAgentToken(token) {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("CHATGPT_WORKSPACE_AGENT_TOKEN is missing or empty");
  }
  return token;
}

export function buildDispatchPayload({ agentId, idempotencyKey, reason, subject }) {
  return {
    agent_id: validateAgentId(agentId),
    idempotency_key: idempotencyKey,
    reason,
    subject,
  };
}

/**
 * Sends one dispatch request to the fixed Workspace Agent trigger endpoint.
 * `fetchImpl` is always injected so no test ever performs a live network
 * call. Fails closed on either missing credential and never follows a
 * redirect response: a 3xx from the fixed endpoint is treated as a failure
 * rather than trusted, since following it would let a compromised or
 * misconfigured endpoint redirect the request (and its Authorization header)
 * somewhere else. The token is used only to build the Authorization header
 * and is never included in the returned result, logged, or thrown in an
 * error message.
 */
export async function dispatchToWorkspaceAgent({ agentId, token, idempotencyKey, reason, subject, fetchImpl }) {
  const payload = buildDispatchPayload({ agentId, idempotencyKey, reason, subject });
  const authorization = `Bearer ${requireWorkspaceAgentToken(token)}`;

  const response = await fetchImpl(WORKSPACE_AGENT_TRIGGER_ENDPOINT, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify(payload),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `workspace agent trigger endpoint returned a redirect (status ${response.status}); refusing to follow it`,
    );
  }

  return { ok: response.ok === true, status: response.status };
}
