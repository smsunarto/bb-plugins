import { expect, mock, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { AGENT_GIT_ACTIONS } from "../../shared/thread-details.ts";
import { askAgent } from "./ask-agent.ts";

test("each git action queues its instruction file as a message to the thread", async () => {
  for (const action of AGENT_GIT_ACTIONS) {
    const send = mock(async () => ({}));
    const bb = { sdk: { threads: { send } } } as unknown as BbPluginApi;
    expect(await askAgent({ bb }, { threadId: "thr_1", action })).toEqual({ ok: true });
    const [args] = send.mock.calls[0] as unknown as [
      { threadId: string; mode: string; input: Array<{ text: string }> },
    ];
    expect(args.threadId).toBe("thr_1");
    expect(args.mode).toBe("queue-if-active");
    expect(args.input[0]?.text.length).toBeGreaterThan(20);
  }
});
