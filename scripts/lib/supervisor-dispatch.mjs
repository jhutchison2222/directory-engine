/**
 * Official ChatGPT Workspace Agents API contract (per Codex exact-head review
 * on PR #26): a fixed base host, a channel id shaped `agtch_XXX` in the URL
 * path, a `{ conversation_key, input }` JSON body, the deterministic
 * idempotency key sent in the `Idempotency-Key` request header (not only
 * recorded after the fact), an optional `OpenAI-Beta` header for run proof,
 * and success is exactly HTTP 202 Accepted.
 */
const AGENT_ID_PATTERN = /^agtch_[A-Za-z0-9]{6,64}$/;

/**
 * Fixed, code-reviewed API base for the ChatGPT Workspace Agents trigger
 * endpoint. It is a literal module constant, never read from a repository
 * variable, secret, issue/PR body, label, or any other repository content.
 * Only the agent id - itself validated against AGENT_ID_PATTERN before it is
 * ever interpolated - varies the resulting URL, so the trigger URL can never
 * be redirected or derived from untrusted repository content.
 */
export const WORKSPACE_AGENT_API_BASE = "https://api.chatgpt.com/v1";

export function validateAgentId(agentId) {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new Error("CHATGPT_WORKSPACE_AGENT_ID is missing or empty");
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("CHATGPT_WORKSPACE_AGENT_ID does not match the expected agtch_ channel-id format");
  }
  return agentId;
}

export function requireWorkspaceAgentToken(token) {
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("CHATGPT_WORKSPACE_AGENT_TOKEN is missing or empty");
  }
  return token;
}

/**
 * Builds the fixed trigger URL for one validated agent id. Fails closed
 * (throws) before returning a URL if the agent id is malformed, so a
 * malformed identifier can never reach a network call.
 */
export function buildTriggerUrl(agentId) {
  return `${WORKSPACE_AGENT_API_BASE}/workspace_agents/${validateAgentId(agentId)}/trigger`;
}

export function buildDispatchPayload({ idempotencyKey, reason, subject }) {
  return {
    conversation_key: idempotencyKey,
    input: JSON.stringify({ reason, subject }),
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
 * error message. The deterministic idempotency key is sent in the
 * `Idempotency-Key` header (not only recorded in a marker after the fact),
 * so the official API can itself deduplicate two concurrent requests for the
 * same exact-state/reason key even if both reach the network before either
 * dispatch marker is recorded. Success is exactly HTTP 202 Accepted; any
 * other non-redirect status is reported as a failed (but not thrown) result.
 */
export async function dispatchToWorkspaceAgent({ agentId, token, idempotencyKey, reason, subject, fetchImpl }) {
  const url = buildTriggerUrl(agentId);
  const authorization = `Bearer ${requireWorkspaceAgentToken(token)}`;
  const payload = buildDispatchPayload({ idempotencyKey, reason, subject });

  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      authorization,
      "idempotency-key": idempotencyKey,
      "openai-beta": "workspace_agent_runs=v1",
    },
    body: JSON.stringify(payload),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `workspace agent trigger endpoint returned a redirect (status ${response.status}); refusing to follow it`,
    );
  }

  return { ok: response.status === 202, status: response.status };
}
