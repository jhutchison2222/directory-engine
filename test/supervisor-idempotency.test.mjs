import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN,
  DEFAULT_TRUSTED_MARKER_AUTHOR_TYPE,
  buildIdempotencyKey,
  filterTrustedDispatchMarkers,
  formatDispatchMarker,
  isTrustedDispatchMarkerAuthor,
  parseDispatchMarker,
  parseIdempotencyKey,
} from "../scripts/lib/supervisor-idempotency.mjs";

describe("buildIdempotencyKey", () => {
  it("builds a deterministic key from subject type, number, state, and reason", () => {
    const key = buildIdempotencyKey({
      subjectType: "pull_request",
      subjectNumber: 26,
      stateId: "a".repeat(40),
      reason: "ci_failed",
    });
    expect(key).toBe(`pull_request:26:${"a".repeat(40)}:ci_failed`);
  });

  it("is stable across repeated calls with the same inputs", () => {
    const input = {
      subjectType: "issue",
      subjectNumber: 25,
      stateId: "b".repeat(64),
      reason: "queued_task_start",
    };
    expect(buildIdempotencyKey(input)).toBe(buildIdempotencyKey({ ...input }));
  });

  it("changes the key when the state id changes (stale-evidence invalidation)", () => {
    const base = { subjectType: "pull_request", subjectNumber: 26, reason: "ci_failed" };
    const keyAtOldHead = buildIdempotencyKey({ ...base, stateId: "a".repeat(40) });
    const keyAtNewHead = buildIdempotencyKey({ ...base, stateId: "c".repeat(40) });
    expect(keyAtOldHead).not.toBe(keyAtNewHead);
  });

  it.each([
    [{ subjectType: "workflow_run", subjectNumber: 1, stateId: "a".repeat(40), reason: "ci_failed" }, /subjectType/],
    [{ subjectType: "issue", subjectNumber: 0, stateId: "a".repeat(40), reason: "ci_failed" }, /subjectNumber/],
    [{ subjectType: "issue", subjectNumber: 1, stateId: "not-hex", reason: "ci_failed" }, /stateId/],
    [{ subjectType: "issue", subjectNumber: 1, stateId: "a".repeat(40), reason: "CI Failed" }, /reason/],
  ])("fails closed on invalid input %#", (input, expectedMessage) => {
    expect(() => buildIdempotencyKey(input)).toThrow(expectedMessage);
  });
});

describe("parseIdempotencyKey", () => {
  it("is the exact inverse of buildIdempotencyKey", () => {
    const input = { subjectType: "pull_request", subjectNumber: 26, stateId: "a".repeat(40), reason: "ci_failed" };
    expect(parseIdempotencyKey(buildIdempotencyKey(input))).toEqual(input);
  });

  it("returns null for a malformed or forged-looking key", () => {
    expect(parseIdempotencyKey("not-a-key")).toBeNull();
    expect(parseIdempotencyKey("pull_request:26:not-hex:ci_failed")).toBeNull();
    expect(parseIdempotencyKey("workflow_run:26:" + "a".repeat(40) + ":ci_failed")).toBeNull();
    expect(parseIdempotencyKey("pull_request:0:" + "a".repeat(40) + ":ci_failed")).toBeNull();
    expect(parseIdempotencyKey("pull_request:26:" + "a".repeat(40) + ":CI Failed")).toBeNull();
    expect(parseIdempotencyKey(undefined)).toBeNull();
  });
});

describe("isTrustedDispatchMarkerAuthor", () => {
  it("trusts exactly the default supervisor bot identity", () => {
    expect(isTrustedDispatchMarkerAuthor({ login: DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN, type: DEFAULT_TRUSTED_MARKER_AUTHOR_TYPE })).toBe(
      true,
    );
  });

  it("rejects an attacker-controlled author impersonating the login but not the type, or vice versa", () => {
    expect(isTrustedDispatchMarkerAuthor({ login: DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN, type: "User" })).toBe(false);
    expect(isTrustedDispatchMarkerAuthor({ login: "some-attacker", type: DEFAULT_TRUSTED_MARKER_AUTHOR_TYPE })).toBe(false);
  });

  it("supports an injected trusted identity override for tests/alternate deployments", () => {
    expect(isTrustedDispatchMarkerAuthor({ login: "custom-bot", type: "Bot" }, { login: "custom-bot", type: "Bot" })).toBe(
      true,
    );
  });

  it("fails closed on a missing author", () => {
    expect(isTrustedDispatchMarkerAuthor(undefined)).toBe(false);
    expect(isTrustedDispatchMarkerAuthor({})).toBe(false);
  });
});

describe("filterTrustedDispatchMarkers", () => {
  const key = "pull_request:26:abc:ci_failed";
  const trustedMarkerBody = formatDispatchMarker({ key, dispatchedAt: "2026-09-02T00:00:00Z" });

  it("counts a marker only when authored by the trusted identity", () => {
    const markers = filterTrustedDispatchMarkers([
      { body: trustedMarkerBody, author: { login: DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN, type: DEFAULT_TRUSTED_MARKER_AUTHOR_TYPE } },
    ]);
    expect(markers).toEqual([{ key, dispatchedAt: "2026-09-02T00:00:00Z" }]);
  });

  it("discards an identical, well-formed marker forged by an untrusted commenter", () => {
    const forgedBody = formatDispatchMarker({ key, dispatchedAt: "2099-01-01T00:00:00Z" });
    const markers = filterTrustedDispatchMarkers([
      { body: forgedBody, author: { login: "some-attacker", type: "User" } },
    ]);
    expect(markers).toEqual([]);
  });

  it("discards a marker from a bot with the right login but wrong type", () => {
    const markers = filterTrustedDispatchMarkers([
      { body: trustedMarkerBody, author: { login: DEFAULT_TRUSTED_MARKER_AUTHOR_LOGIN, type: "User" } },
    ]);
    expect(markers).toEqual([]);
  });
});

describe("dispatch marker round trip", () => {
  it("formats and parses a marker without losing the key or timestamp", () => {
    const marker = formatDispatchMarker({ key: "pull_request:26:abc:ci_failed", dispatchedAt: "2026-09-02T00:00:00Z" });
    expect(parseDispatchMarker(marker)).toEqual({
      key: "pull_request:26:abc:ci_failed",
      dispatchedAt: "2026-09-02T00:00:00Z",
    });
  });

  it("never embeds any credential-shaped token text in the marker", () => {
    const marker = formatDispatchMarker({ key: "pull_request:26:abc:ci_failed", dispatchedAt: "2026-09-02T00:00:00Z" });
    expect(marker.toLowerCase()).not.toContain("token");
    expect(marker.toLowerCase()).not.toContain("bearer");
    expect(marker.toLowerCase()).not.toContain("authorization");
  });

  it("returns null for ordinary human or bot comments", () => {
    expect(parseDispatchMarker("Looks good to me!")).toBeNull();
    expect(parseDispatchMarker("<!-- some-other-tool:not-json -->")).toBeNull();
  });

  it("returns null for a malformed marker payload", () => {
    expect(parseDispatchMarker("<!-- autonomy-supervisor:{not json} -->")).toBeNull();
    expect(parseDispatchMarker("<!-- autonomy-supervisor:{\"key\":\"x\"} -->")).toBeNull();
    expect(
      parseDispatchMarker('<!-- autonomy-supervisor:{"key":"x","dispatchedAt":"not-a-date"} -->'),
    ).toBeNull();
  });

  it("rejects building a marker with an unparseable dispatchedAt", () => {
    expect(() => formatDispatchMarker({ key: "k", dispatchedAt: "not-a-date" })).toThrow(/dispatchedAt/);
  });
});
