import { expect, test } from "bun:test";
import { fakeBb, fileKeyOf } from "../fake-bb.ts";
import { proposals } from "./proposals.ts";

test("proposals reads a directly written sidecar on the canvas host", async () => {
  const source = { kind: "host", hostId: "other-host", path: "/canvas.mdx" } as const;
  const bb = fakeBb({
    files: {
      [fileKeyOf("other-host", undefined, "/canvas.mdx.suggestions.json")]: {
        content: '{"version":1,"proposals":[]}',
      },
    },
  });
  expect(await proposals.execute({ bb }, { source })).toEqual({
    file: { version: 1, proposals: [] },
  });
  expect(bb.calls.filesRead[0]?.hostId).toBe("other-host");
});
