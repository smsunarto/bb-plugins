import { describe, expect, it, mock } from "bun:test";
import { openParkedThread } from "../lib/parked-thread-navigation.ts";

function navigation() {
  return {
    openVisibleThread: mock(() => {}),
    openAnyThread: mock(() => {}),
    onNavigate: mock(() => {}),
  };
}

describe("openParkedThread", () => {
  it("uses general navigation for an archived settled thread", () => {
    const calls = navigation();

    openParkedThread("settled", "thread-1", false, calls);

    expect(calls.openAnyThread).toHaveBeenCalledWith("thread-1");
    expect(calls.openVisibleThread).not.toHaveBeenCalled();
    expect(calls.onNavigate).toHaveBeenCalledTimes(1);
  });

  it("keeps sidebar navigation and split intent for a snoozed thread", () => {
    const calls = navigation();

    openParkedThread("snoozed", "thread-2", true, calls);

    expect(calls.openVisibleThread).toHaveBeenCalledWith("thread-2", true);
    expect(calls.openAnyThread).not.toHaveBeenCalled();
    expect(calls.onNavigate).toHaveBeenCalledTimes(1);
  });
});
