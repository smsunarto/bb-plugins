import { expect, test } from "bun:test";
import { publishWorkspaceChanged } from "./workspace-signal.ts";

function recorder() {
  const published: { channel: string; payload: unknown }[] = [];
  const bb = {
    realtime: {
      publish: (channel: string, payload: unknown) => published.push({ channel, payload }),
    },
  };
  return { bb, published };
}

test("a turn that ends on an environment names that environment and the thread once", () => {
  const { bb, published } = recorder();
  publishWorkspaceChanged(bb, { id: "thr_child", environmentId: "env_1", parentThreadId: "thr_1" });

  expect(published).toEqual([
    {
      channel: "workspace-changed",
      payload: { environmentId: "env_1", threadId: "thr_child", parentThreadId: "thr_1" },
    },
  ]);
});

test("a thread with no environment publishes nothing", () => {
  const { bb, published } = recorder();
  publishWorkspaceChanged(bb, { id: "thr_1", environmentId: null, parentThreadId: null });

  expect(published).toEqual([]);
});
