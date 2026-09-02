import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  formatDispatchMarker,
  parseDispatchMarker,
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
