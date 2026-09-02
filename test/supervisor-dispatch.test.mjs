import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_AGENT_API_BASE,
  buildDispatchPayload,
  buildTriggerUrl,
  dispatchToWorkspaceAgent,
  requireWorkspaceAgentToken,
  validateAgentId,
} from "../scripts/lib/supervisor-dispatch.mjs";

// Obviously-fake fixture value, never a real credential.
const FIXTURE_TOKEN = "fixture-not-a-real-token";
const AGENT_ID = "agtch_directoryengineworkspace01";

describe("validateAgentId", () => {
  it("accepts a well-formed agtch_ channel id", () => {
    expect(validateAgentId(AGENT_ID)).toBe(AGENT_ID);
  });

  it.each([undefined, null, "", "  ", "agtch_", "x", "has a space", "semi;colon", "directory-engine-workspace-agent"])(
    "fails closed for invalid agent id %j",
    (value) => {
      expect(() => validateAgentId(value)).toThrow(/CHATGPT_WORKSPACE_AGENT_ID/);
    },
  );
});

describe("requireWorkspaceAgentToken", () => {
  it("fails closed when the token is missing", () => {
    expect(() => requireWorkspaceAgentToken(undefined)).toThrow(/CHATGPT_WORKSPACE_AGENT_TOKEN/);
    expect(() => requireWorkspaceAgentToken("")).toThrow(/CHATGPT_WORKSPACE_AGENT_TOKEN/);
  });

  it("returns a present token unchanged", () => {
    expect(requireWorkspaceAgentToken(FIXTURE_TOKEN)).toBe(FIXTURE_TOKEN);
  });
});

describe("buildTriggerUrl", () => {
  it("builds the official fixed-host, agent-id-in-path trigger URL", () => {
    expect(buildTriggerUrl(AGENT_ID)).toBe(`${WORKSPACE_AGENT_API_BASE}/workspace_agents/${AGENT_ID}/trigger`);
  });

  it("fails closed before building a URL for a malformed agent id", () => {
    expect(() => buildTriggerUrl("not-agtch-shaped")).toThrow(/CHATGPT_WORKSPACE_AGENT_ID/);
  });
});

describe("buildDispatchPayload", () => {
  it("builds the official conversation_key/input body carrying only non-secret fields", () => {
    const payload = buildDispatchPayload({
      idempotencyKey: "pull_request:26:abc:ci_failed",
      reason: "ci_failed",
      subject: { type: "pull_request", number: 26 },
    });
    expect(payload).toEqual({
      conversation_key: "pull_request:26:abc:ci_failed",
      input: JSON.stringify({ reason: "ci_failed", subject: { type: "pull_request", number: 26 } }),
    });
  });
});

describe("dispatchToWorkspaceAgent", () => {
  const baseArgs = {
    agentId: AGENT_ID,
    token: FIXTURE_TOKEN,
    idempotencyKey: "pull_request:26:abc:ci_failed",
    reason: "ci_failed",
    subject: { type: "pull_request", number: 26 },
  };

  it("posts to the fixed trigger endpoint with the Idempotency-Key header and the token only in Authorization", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 202 });
    const result = await dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl });

    expect(result).toEqual({ ok: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${WORKSPACE_AGENT_API_BASE}/workspace_agents/${AGENT_ID}/trigger`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    expect(init.headers["idempotency-key"]).toBe(baseArgs.idempotencyKey);
    expect(init.headers["openai-beta"]).toBe("workspace_agent_runs=v1");
    expect(JSON.stringify(init)).not.toContain(FIXTURE_TOKEN.slice(0, 4) + FIXTURE_TOKEN.slice(4).toUpperCase());
    expect(JSON.parse(init.body)).not.toHaveProperty("token");
    expect(JSON.parse(init.body)).toEqual({
      conversation_key: baseArgs.idempotencyKey,
      input: JSON.stringify({ reason: baseArgs.reason, subject: baseArgs.subject }),
    });
  });

  it("treats exactly HTTP 202 as success and any other status (even 200 OK) as not-ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    const result = await dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl });
    expect(result).toEqual({ ok: false, status: 200 });
  });

  it("fails closed instead of following a redirect from the trigger endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 302 });
    await expect(dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl })).rejects.toThrow(/redirect/);
  });

  it("reports a non-ok, non-redirect response as a failed dispatch rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 500 });
    const result = await dispatchToWorkspaceAgent({ ...baseArgs, fetchImpl });
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it("fails closed before any network call when the token is missing", async () => {
    const fetchImpl = vi.fn();
    await expect(dispatchToWorkspaceAgent({ ...baseArgs, token: undefined, fetchImpl })).rejects.toThrow(
      /CHATGPT_WORKSPACE_AGENT_TOKEN/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed before any network call when the agent id is invalid", async () => {
    const fetchImpl = vi.fn();
    await expect(dispatchToWorkspaceAgent({ ...baseArgs, agentId: "", fetchImpl })).rejects.toThrow(
      /CHATGPT_WORKSPACE_AGENT_ID/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
