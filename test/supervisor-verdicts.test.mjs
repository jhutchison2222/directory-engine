import { describe, expect, it } from "vitest";
import {
  OWNER_VERDICT_KINDS,
  buildOwnerVerdictEvents,
  classifyOwnerCommentBody,
  isTrustedOwnerLogin,
  selectLatestOwnerVerdict,
} from "../scripts/lib/supervisor-verdicts.mjs";

const OWNER = "jhutchison2222";
const HEAD_A = "8f9ac2d53f4ea3b014c6ebb74d543b8652cbc88a";
const HEAD_B = "b".repeat(40);

describe("isTrustedOwnerLogin", () => {
  it("trusts only the exact owner login, case-insensitively", () => {
    expect(isTrustedOwnerLogin("jhutchison2222", OWNER)).toBe(true);
    expect(isTrustedOwnerLogin("JHutchison2222", OWNER)).toBe(true);
  });

  it("never trusts a guessed reviewer identity, generic bot, or arbitrary commenter", () => {
    expect(isTrustedOwnerLogin("codex", OWNER)).toBe(false);
    expect(isTrustedOwnerLogin("chatgpt-codex-connector", OWNER)).toBe(false);
    expect(isTrustedOwnerLogin("github-actions[bot]", OWNER)).toBe(false);
    expect(isTrustedOwnerLogin("some-random-commenter", OWNER)).toBe(false);
  });

  it("fails closed on missing input", () => {
    expect(isTrustedOwnerLogin(undefined, OWNER)).toBe(false);
    expect(isTrustedOwnerLogin("", OWNER)).toBe(false);
    expect(isTrustedOwnerLogin(OWNER, undefined)).toBe(false);
  });
});

describe("classifyOwnerCommentBody", () => {
  it("recognizes an explicit ACCEPTED marker", () => {
    expect(classifyOwnerCommentBody(`ACCEPTED — exact head ${HEAD_A}`)).toEqual({
      kind: OWNER_VERDICT_KINDS.ACCEPTED,
      headSha: HEAD_A,
    });
  });

  it("recognizes an explicit REJECTED marker", () => {
    expect(classifyOwnerCommentBody(`REJECTED — exact head ${HEAD_A}`)).toEqual({
      kind: OWNER_VERDICT_KINDS.REJECTED,
      headSha: HEAD_A,
    });
  });

  it("recognizes an explicit SUPERSEDED marker with arbitrary text before the head", () => {
    expect(classifyOwnerCommentBody(`SUPERSEDED by a later remediation request, exact head ${HEAD_A}`)).toEqual({
      kind: OWNER_VERDICT_KINDS.SUPERSEDED,
      headSha: HEAD_A,
    });
  });

  it("recognizes the owner's own real-world remediation-request phrasing", () => {
    expect(classifyOwnerCommentBody(`@claude Remediate DE-0010 at exact head \`${HEAD_A}\` (cycle 2/3).`)).toEqual({
      kind: OWNER_VERDICT_KINDS.REMEDIATION_REQUESTED,
      headSha: HEAD_A,
    });
  });

  it("normalizes a captured head SHA to lowercase", () => {
    expect(classifyOwnerCommentBody(`ACCEPTED — exact head ${HEAD_A.toUpperCase()}`)).toEqual({
      kind: OWNER_VERDICT_KINDS.ACCEPTED,
      headSha: HEAD_A,
    });
  });

  it("returns null for ordinary commentary with no marker", () => {
    expect(classifyOwnerCommentBody("Looks good to me!")).toBeNull();
    expect(classifyOwnerCommentBody("This accepted design is nice, but no head reference here.")).toBeNull();
  });

  it("never classifies a negated or qualified non-acceptance phrase as ACCEPTED", () => {
    expect(classifyOwnerCommentBody(`NOT ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`UNACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`NOT YET ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`NEVER ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`NON-ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`UN-ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
  });

  it("returns null for incidental prose that mentions 'accepted' without being a standalone marker line", () => {
    expect(
      classifyOwnerCommentBody(`The status is now ACCEPTED — exact head ${HEAD_A} after review.`),
    ).toBeNull();
    expect(
      classifyOwnerCommentBody(`DE-0010 remediation cycle 2/3 complete. ACCEPTED — exact head ${HEAD_A}`),
    ).toBeNull();
  });

  it("recognizes a valid exact standalone ACCEPTED marker line even amid other prose lines", () => {
    expect(
      classifyOwnerCommentBody(`DE-0010 remediation cycle 2/3 complete.\n\nACCEPTED — exact head ${HEAD_A}`),
    ).toEqual({ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A });
  });

  it("recognizes an ACCEPTED marker line wrapped in harmless Markdown decoration", () => {
    expect(classifyOwnerCommentBody(`**ACCEPTED — exact head \`${HEAD_A}\`**`)).toEqual({
      kind: OWNER_VERDICT_KINDS.ACCEPTED,
      headSha: HEAD_A,
    });
    expect(classifyOwnerCommentBody(`### ACCEPTED — exact head ${HEAD_A}`)).toEqual({
      kind: OWNER_VERDICT_KINDS.ACCEPTED,
      headSha: HEAD_A,
    });
  });

  it("DE-0010-R1 regression: a blockquoted/reply-quoted ACCEPTED line can never create acceptance", () => {
    // GitHub renders a quoted line (a reply quoting an earlier comment, or
    // the owner quoting a rejected/superseded draft while discussing it)
    // with a leading "> ". Quoting a marker is not the same act as asserting
    // it, so this must fail closed exactly like negated/qualified prose does
    // - even though the blockquote is the only thing preceding "ACCEPTED" on
    // the line.
    expect(classifyOwnerCommentBody(`> ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`>ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`>> ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(
      classifyOwnerCommentBody(
        `Someone else claimed:\n> ACCEPTED — exact head ${HEAD_A}\n\nI have not reviewed this yet.`,
      ),
    ).toBeNull();
    // A genuine, unquoted marker line elsewhere in the same body is still
    // honored - only the quoted line itself fails closed.
    expect(
      classifyOwnerCommentBody(
        `> ACCEPTED — exact head ${HEAD_B}\n\nThat quote is stale.\n\nACCEPTED — exact head ${HEAD_A}`,
      ),
    ).toEqual({ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A });
  });

  it("DE-0010-R1 cycle 3 regression: a fenced-code-block ACCEPTED line can never create acceptance", () => {
    // GitHub renders content between matching ``` fences as a code block -
    // quoted example text, not an assertion - the same "quoting is not
    // asserting" gap the blockquote fix closed, reopened via a sibling
    // GitHub quoting mechanism.
    expect(classifyOwnerCommentBody(`\`\`\`\nACCEPTED — exact head ${HEAD_A}\n\`\`\``)).toBeNull();
    expect(classifyOwnerCommentBody(`\`\`\`text\nACCEPTED — exact head ${HEAD_A}\n\`\`\``)).toBeNull();
    expect(classifyOwnerCommentBody(`~~~\nACCEPTED — exact head ${HEAD_A}\n~~~`)).toBeNull();
    expect(
      classifyOwnerCommentBody(
        `That stale draft read:\n\n\`\`\`\nACCEPTED — exact head ${HEAD_A}\n\`\`\`\n\nI have not reviewed this yet.`,
      ),
    ).toBeNull();
    // A genuine, unquoted marker line elsewhere in the same body is still
    // honored - only the fenced line itself fails closed.
    expect(
      classifyOwnerCommentBody(
        `\`\`\`\nACCEPTED — exact head ${HEAD_B}\n\`\`\`\n\nThat quote is stale.\n\nACCEPTED — exact head ${HEAD_A}`,
      ),
    ).toEqual({ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A });
  });

  it("DE-0010-R1 cycle 3 regression: a 4-space/tab-indented ACCEPTED line can never create acceptance", () => {
    // GitHub renders a 4-space or tab-indented line as an indented code
    // block - quoted example text, not an assertion.
    expect(classifyOwnerCommentBody(`    ACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(classifyOwnerCommentBody(`\tACCEPTED — exact head ${HEAD_A}`)).toBeNull();
    expect(
      classifyOwnerCommentBody(
        `That stale draft read:\n\n    ACCEPTED — exact head ${HEAD_A}\n\nI have not reviewed this yet.`,
      ),
    ).toBeNull();
    // A genuine, unquoted marker line elsewhere in the same body is still
    // honored - only the indented line itself fails closed.
    expect(
      classifyOwnerCommentBody(`    ACCEPTED — exact head ${HEAD_B}\n\nThat quote is stale.\n\nACCEPTED — exact head ${HEAD_A}`),
    ).toEqual({ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A });
  });

  it("resolves combined blocking evidence safely when an ACCEPTED line and a later blocking marker line both exist", () => {
    expect(
      classifyOwnerCommentBody(`ACCEPTED — exact head ${HEAD_A}\n\nREJECTED — exact head ${HEAD_A}`),
    ).toEqual({ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A });
  });

  it("returns null for a missing or non-string body", () => {
    expect(classifyOwnerCommentBody(undefined)).toBeNull();
    expect(classifyOwnerCommentBody(null)).toBeNull();
  });

  it("prefers blocking markers (REJECTED/SUPERSEDED/remediation) over ACCEPTED when a body combines both", () => {
    expect(
      classifyOwnerCommentBody(`ACCEPTED — exact head ${HEAD_A}, later REJECTED — exact head ${HEAD_A}`),
    ).toEqual({ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A });
  });
});

describe("buildOwnerVerdictEvents", () => {
  it("only counts comments authored by the trusted owner login", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: "codex",
          body: `ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:00:00Z",
        },
        {
          authorLogin: OWNER,
          body: `REJECTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T10:00:00Z",
          updatedAt: "2026-09-02T10:00:00Z",
        },
      ],
    });
    expect(events).toEqual([{ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A, submittedAt: "2026-09-02T10:00:00Z" }]);
  });

  it("ignores an owner comment without an explicit marker", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: "Sounds good, thanks!",
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("classifies an owner formal review's native APPROVED/CHANGES_REQUESTED state", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: OWNER,
          state: "APPROVED",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([{ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" }]);
  });

  it("ignores a non-actionable owner formal review state (COMMENTED)", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: OWNER,
          state: "COMMENTED",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("ignores a DISMISSED review entirely, regardless of its body", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: OWNER,
          body: `ACCEPTED — exact head ${HEAD_A}`,
          state: "DISMISSED",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("ignores a PENDING review entirely, regardless of its body", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: OWNER,
          body: `ACCEPTED — exact head ${HEAD_A}`,
          state: "PENDING",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("remediation regression: never honors an explicit marker in a formal review's body - only its immutable native state is trusted, since GitHub exposes no real edit-provenance field for reviews", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: OWNER,
          body: `REJECTED — exact head ${HEAD_A}`,
          state: "APPROVED",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    // The native APPROVED state wins, not the (unverifiable) body text.
    expect(events).toEqual([{ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" }]);
  });

  it("remediation regression: an explicit ACCEPTED marker in a non-actionable (COMMENTED) review body is never trusted as an event", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: OWNER,
          body: `ACCEPTED — exact head ${HEAD_A}`,
          state: "COMMENTED",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("remediation regression: trusts a formal review's native state even with no body/updatedAt supplied at all - no provenance value is manufactured or required for reviews", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [{ authorLogin: OWNER, state: "CHANGES_REQUESTED", headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" }],
    });
    expect(events).toEqual([{ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" }]);
  });

  it("never trusts a formal review from a non-owner login, even with an APPROVED state", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      reviews: [
        {
          authorLogin: "codex",
          state: "APPROVED",
          headSha: HEAD_A,
          submittedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("never trusts a comment whose updatedAt differs from createdAt (edited after posting)", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: `ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:05:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("fails closed on a comment missing updatedAt entirely", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [{ authorLogin: OWNER, body: `ACCEPTED — exact head ${HEAD_A}`, createdAt: "2026-09-02T09:00:00Z" }],
    });
    expect(events).toEqual([]);
  });

  it("never classifies a negated ACCEPTED phrase as acceptance", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: `NOT ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:00:00Z",
        },
        {
          authorLogin: OWNER,
          body: `UNACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:01:00Z",
          updatedAt: "2026-09-02T09:01:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("does not credit an ACCEPTED clause sharing a single line with remediation prose - only a standalone marker line counts", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: `DE-0010 remediation cycle 2/3 complete. ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it("still recognizes a standalone ACCEPTED marker line even when remediation prose appears on an earlier line of the same comment", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: `DE-0010 remediation cycle 2/3 complete.\n\nACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:00:00Z",
        },
      ],
    });
    expect(events).toEqual([{ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" }]);
  });

  it("never classifies negated/qualified non-acceptance phrasing as ACCEPTED, including phrasings beyond the two originally patched", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: `NOT YET ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:00:00Z",
          updatedAt: "2026-09-02T09:00:00Z",
        },
        {
          authorLogin: OWNER,
          body: `NEVER ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:01:00Z",
          updatedAt: "2026-09-02T09:01:00Z",
        },
        {
          authorLogin: OWNER,
          body: `NON-ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:02:00Z",
          updatedAt: "2026-09-02T09:02:00Z",
        },
        {
          authorLogin: OWNER,
          body: `UN-ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T09:03:00Z",
          updatedAt: "2026-09-02T09:03:00Z",
        },
      ],
    });
    expect(events).toEqual([]);
  });
});

describe("selectLatestOwnerVerdict: the PR #24 stale-verdict race", () => {
  it("returns null when no event matches the exact head", () => {
    expect(
      selectLatestOwnerVerdict(
        [{ kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_B, submittedAt: "2026-09-02T09:00:00Z" }],
        HEAD_A,
      ),
    ).toBeNull();
  });

  it("returns the chronologically latest event at the exact head regardless of array order", () => {
    const latest = selectLatestOwnerVerdict(
      [
        { kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A, submittedAt: "2026-09-02T10:00:00Z" },
        { kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_A, submittedAt: "2026-09-02T09:00:00Z" },
        { kind: OWNER_VERDICT_KINDS.ACCEPTED, headSha: HEAD_B, submittedAt: "2026-09-02T12:00:00Z" },
      ],
      HEAD_A,
    );
    expect(latest).toEqual({ kind: OWNER_VERDICT_KINDS.REJECTED, headSha: HEAD_A, submittedAt: "2026-09-02T10:00:00Z" });
  });

  it("an earlier acceptance is never authoritative once later evidence exists at the same exact head - the actual PR #24 sequence", () => {
    const events = buildOwnerVerdictEvents({
      ownerLogin: OWNER,
      comments: [
        {
          authorLogin: OWNER,
          body: `ACCEPTED — exact head ${HEAD_A}`,
          createdAt: "2026-09-02T19:00:00Z",
          updatedAt: "2026-09-02T19:00:00Z",
        },
        {
          authorLogin: OWNER,
          body: `REJECTED — exact head ${HEAD_A}, remediation required before merge`,
          createdAt: "2026-09-02T20:17:59Z",
          updatedAt: "2026-09-02T20:17:59Z",
        },
      ],
    });
    expect(selectLatestOwnerVerdict(events, HEAD_A)).toEqual({
      kind: OWNER_VERDICT_KINDS.REJECTED,
      headSha: HEAD_A,
      submittedAt: "2026-09-02T20:17:59Z",
    });
  });
});
