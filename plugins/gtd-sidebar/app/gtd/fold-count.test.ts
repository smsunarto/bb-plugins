import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "../model/fixtures.ts";
import { foldCount, spokenFoldCount } from "./fold-count.ts";

describe("foldCount", () => {
  it("counts root families and the ones whose rows need the user", () => {
    const read = { isUnread: false };
    const threads = [
      makeSidebarThread({ id: "quiet", ...read }),
      makeSidebarThread({ id: "parent", ...read }),
      makeSidebarThread({ id: "child", parentThreadId: "parent", ...read }),
      makeSidebarThread({ id: "grandchild", parentThreadId: "child", isUnread: true }),
      // Its parent sits on another shelf, so it heads its own family here.
      makeSidebarThread({ id: "orphan", parentThreadId: "elsewhere", hasPendingInteraction: true }),
    ];
    expect(foldCount(threads)).toEqual({ families: 3, attention: 2 });
  });

  it("survives a parent cycle", () => {
    const threads = [
      makeSidebarThread({ id: "a", parentThreadId: "b" }),
      makeSidebarThread({ id: "b", parentThreadId: "a", indicator: "waiting-for-input" }),
    ];
    expect(foldCount(threads).attention).toBeLessThanOrEqual(foldCount(threads).families);
  });

  it("says the count in words", () => {
    expect(spokenFoldCount({ families: 1, attention: 0 })).toBe("1 thread");
    expect(spokenFoldCount({ families: 5, attention: 2 })).toBe("5 threads, 2 need you");
  });
});
