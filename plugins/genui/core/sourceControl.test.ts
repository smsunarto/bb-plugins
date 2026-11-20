import { describe, expect, it } from "vitest";
import { environmentPull, forgeReadAt, noPullLabel, parseThreadStatuses } from "./sourceControl";

const PR = { number: 7, title: "Fix", url: "https://github.com/acme/app/pull/7", state: "open" };
const row = (extra: Record<string, unknown> = {}) => ({
  state: "change",
  key: "gh:1",
  branch: "b",
  pullRequest: PR,
  line: "Ready to merge",
  chips: [],
  tone: "success",
  sort: 3,
  ...extra,
});

describe("Source Control's statusForThread rows", () => {
  it("keeps the fields GenUI reads, ignores fields it doesn't, and leaves out rows that aren't rows", () => {
    expect(
      parseThreadStatuses({
        a: row({ source: "remembered", future: 1 }),
        b: { state: "pending" },
        c: { state: "none" },
        d: { state: "change" },
        e: 7,
      }),
    ).toEqual({
      a: {
        state: "change",
        branch: "b",
        pullRequest: { number: 7, title: "Fix", url: PR.url, state: "open" },
        line: "Ready to merge",
        tone: "success",
        forge: { state: "unknown" },
      },
      b: { state: "pending" },
      c: { state: "none" },
    });
  });

  it("reads BBP-32's forge state when the row has it", () => {
    const forge = (value: unknown) => {
      const parsed = parseThreadStatuses({ a: row({ forge: value }) }).a;
      return parsed?.state === "change" ? parsed.forge : null;
    };
    expect(forge({ state: "read", at: 5 })).toEqual({ state: "read", at: 5 });
    expect(forge({ state: "unread" })).toEqual({ state: "unread" });
    expect(forge({ state: "unsupported" })).toEqual({ state: "unsupported" });
    expect(forge({ state: "failed", at: null, problem: { kind: "rate-limited" } })).toEqual({
      state: "failed",
      at: null,
      problem: "GitHub is rate-limiting Source Control",
    });
    expect(forge({ state: "later" })).toEqual({ state: "unknown" });
  });

  it("says only what the row knows when a branch shows no pull request", () => {
    expect(noPullLabel({ state: "unknown" })).toBe("no PR seen");
    expect(noPullLabel({ state: "read", at: 1 })).toBe("no PR");
    expect(noPullLabel({ state: "unread" })).toBe("PR not read yet");
    expect(noPullLabel({ state: "failed", at: null, problem: "x" })).toBe("PR unknown");
    expect(noPullLabel({ state: "unsupported" })).toBe("no GitHub PR");
    expect(forgeReadAt({ state: "unknown" })).toBeNull();
    expect(forgeReadAt({ state: "failed", at: 4, problem: "x" })).toEqual({ at: 4, failed: "x" });
  });

  it("names the environment's pull request from the first thread on its branch that has one", () => {
    const rows = parseThreadStatuses({
      a: row({ pullRequest: null }),
      b: row(),
      c: row({ branch: "other" }),
    });
    expect(environmentPull(["a", "b"], rows, "b")).toMatchObject({
      ok: true,
      pullRequest: { number: 7 },
    });
    expect(environmentPull(["a"], rows, "b")).toMatchObject({ ok: true, pullRequest: null });
    expect(environmentPull(["c"], rows, "b")).toEqual({
      ok: false,
      message: "Source Control has no thread on b",
    });
    expect(environmentPull([], rows, "b")).toMatchObject({ ok: false });
  });
});
