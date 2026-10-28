import { describe, expect, it } from "vitest";
import { answerSignature, pollDelay, POLL_MAX_MS, POLL_START_MS, ratioBlocks } from "./project-logic";

describe("polling", () => {
  it("backs off while nothing changes and never waits longer than the cap", () => {
    expect(pollDelay(0)).toBe(POLL_START_MS);
    expect(pollDelay(1)).toBe(2 * POLL_START_MS);
    expect(pollDelay(50)).toBe(POLL_MAX_MS);
  });

  it("compares answers without the time they were read", () => {
    expect(answerSignature({ ok: true, fetchedAt: 1, threads: [{ status: "active" }] })).toBe(
      answerSignature({ ok: true, fetchedAt: 2, threads: [{ status: "active" }] }),
    );
    expect(answerSignature({ fetchedAt: 1, threads: [{ status: "active" }] })).not.toBe(
      answerSignature({ fetchedAt: 1, threads: [{ status: "idle" }] }),
    );
  });
});

describe("proportion blocks", () => {
  it("splits five blocks by share, keeping one for each side that changed", () => {
    expect(ratioBlocks(100, 0)).toEqual({ added: 5, removed: 0, neutral: 0 });
    expect(ratioBlocks(60, 40)).toEqual({ added: 3, removed: 2, neutral: 0 });
    expect(ratioBlocks(1000, 1)).toEqual({ added: 4, removed: 1, neutral: 0 });
    expect(ratioBlocks(1, 1000)).toEqual({ added: 1, removed: 4, neutral: 0 });
  });

  it("colors no more blocks than lines changed", () => {
    expect(ratioBlocks(2, 0)).toEqual({ added: 2, removed: 0, neutral: 3 });
    expect(ratioBlocks(0, 0)).toEqual({ added: 0, removed: 0, neutral: 5 });
  });
});
