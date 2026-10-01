import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostSignalPayload } from "../../../shared/contracts/host-contract.ts";
import { structuralDiff as upstreamStructuralDiff } from "../../../shared/node/vendor/review/src/server/structural-diff.ts";
import type { StructuralDiffEvent } from "../../../shared/vendor/review-protocol/src/index.ts";
import { type WhiteboardHostClient, installHostClient } from "./client.ts";
import { structuralDiff } from "./structural-diff.ts";
import { type GitFixture, gitFixture } from "./testing/git-fixture.ts";
import {
  type InProcessHostClient,
  inProcessResolver,
  installInProcessHostIo,
} from "./testing/in-process.ts";

const APP_DIFFR = "/Applications/Whiteboard.app/Contents/Resources/app/review-runtime/bin/diffr";

const START = {
  type: "start",
  version: 4,
  lhs: { type: "revision", rev: "base" },
  rhs: { type: "revision", rev: "head" },
  files: [{ file: { rhs: { path: "a.ts", oid: "2", mode: "100644" } }, status: "added" }],
};
const binary = (size: number) => ({
  type: "file",
  file: { rhs: { path: "a.ts", oid: "2", mode: "100644" } },
  diff: { type: "binary", rhs: { size } },
});
const COMPLETE = { type: "complete", succeeded: 1, failed: 0 };

const roots: string[] = [];
let repo: GitFixture;
let client: InProcessHostClient;
let uninstall: () => void;

beforeAll(() => {
  repo = gitFixture();
  ({ client, uninstall } = installInProcessHostIo());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(() => {
  uninstall();
  repo.remove();
});

/** A fake diffr the host spawns through REVIEW_DIFFR_BINARY, as upstream's spec does. */
async function fakeDiffr(script: string) {
  const root = await mkdtemp(path.join(tmpdir(), "whiteboard-diffr-"));
  roots.push(root);
  const file = path.join(root, "diffr");
  await writeFile(file, `#!${process.execPath}\n${script}`, { mode: 0o755 });
  vi.stubEnv("REVIEW_DIFFR_BINARY", file);
  return root;
}

const comparison = { kind: "trees", base: "base", head: "head" } as const;

describe("structuralDiff over host signals", () => {
  it("streams every event in diffr's order across many signal batches", async () => {
    // 2000 binary records of ~100 bytes: several 50 ms / 256 KiB batches.
    const lines = [START, ...Array.from({ length: 2000 }, (_, i) => binary(i)), COMPLETE];
    await fakeDiffr(
      `const lines = ${JSON.stringify(lines.map((line) => JSON.stringify(line)))};
       (async () => { for (let i = 0; i < lines.length; i++) {
         process.stdout.write(lines[i] + "\\n");
         if (i % 500 === 0) await new Promise((r) => setTimeout(r, 60));
       } })();`,
    );
    const events: StructuralDiffEvent[] = [];
    for await (const event of structuralDiff({
      repositoryPath: repo.root,
      comparison,
      signal: new AbortController().signal,
    }))
      events.push(event);

    expect(events.length).toBe(2002);
    expect(events[0]!.type).toBe("start");
    expect(
      events
        .slice(1, -1)
        .map((event) => (event as { diff: { rhs: { size: number } } }).diff.rhs.size),
    ).toEqual(Array.from({ length: 2000 }, (_, i) => i));
    expect(events.at(-1)).toEqual({ type: "complete", succeeded: 1, failed: 0 });
  });

  it("a break cancels the host run and terminates diffr", async () => {
    const root = await fakeDiffr(
      `require("node:fs").writeFileSync(require("node:path").join(__dirname, "pid"), String(process.pid));
       console.log(${JSON.stringify(JSON.stringify(START))});
       setInterval(() => {}, 1000);`,
    );
    const before = client.calls.filter((call) => call.method === "cancelStructuralDiff").length;
    for await (const event of structuralDiff({
      repositoryPath: repo.root,
      comparison,
      signal: new AbortController().signal,
    })) {
      expect(event.type).toBe("start");
      break;
    }
    const pid = Number(await readFile(path.join(root, "pid"), "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 5_000 }).toBe(false);
    expect(client.calls.filter((call) => call.method === "cancelStructuralDiff").length).toBe(
      before + 1,
    );
  });

  it("aborting the request signal stops the stream with its reason", async () => {
    await fakeDiffr(
      `console.log(${JSON.stringify(JSON.stringify(START))}); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const event of structuralDiff({
        repositoryPath: repo.root,
        comparison,
        signal: controller.signal,
      })) {
        seen.push(event.type);
        controller.abort(new Error("closed by the viewer"));
      }
    })();
    await expect(run).rejects.toThrow("closed by the viewer");
    expect(seen).toEqual(["start"]);
  });

  it("carries a diffr failure as upstream's error", async () => {
    vi.stubEnv("REVIEW_DIFFR_BINARY", path.join(tmpdir(), "whiteboard-no-such-diffr"));
    const run = async () => {
      for await (const _ of structuralDiff({
        repositoryPath: repo.root,
        comparison,
        signal: new AbortController().signal,
      }));
    };
    await expect(run()).rejects.toThrow(
      `Cannot find diffr at ${path.join(tmpdir(), "whiteboard-no-such-diffr")}.`,
    );
  });

  it("reorders batches that arrive out of seq order", async () => {
    const signals = new Map<string, (event: { hostId: string; payload: unknown }) => void>();
    const batch = (
      streamId: string,
      seq: number,
      events: unknown[],
      done = false,
    ): HostSignalPayload<"structuralEvents"> => ({
      streamId,
      seq,
      events: events as HostSignalPayload<"structuralEvents">["events"],
      done,
    });
    const fake = {
      async call(method: string, input: { streamId: string }) {
        if (method !== "structuralDiff") return { ok: true };
        const emit = (payload: HostSignalPayload<"structuralEvents">) =>
          signals.get("structuralEvents")!({ hostId: "in-process", payload });
        emit(batch(input.streamId, 2, [COMPLETE], true));
        emit(batch(input.streamId, 1, [binary(1)]));
        emit(batch("another-stream", 0, [binary(99)]));
        emit(batch(input.streamId, 0, [START, binary(0)]));
        return { ok: true };
      },
      experimental_onSignal(
        name: string,
        handler: (event: { hostId: string; payload: unknown }) => void,
      ) {
        signals.set(name, handler);
        return () => signals.delete(name);
      },
      experimental_onWorkerExit() {
        return () => {};
      },
    } as unknown as WhiteboardHostClient;
    const restore = installHostClient(fake, inProcessResolver());
    try {
      const types: unknown[] = [];
      for await (const event of structuralDiff({
        repositoryPath: repo.root,
        comparison,
        signal: new AbortController().signal,
      }))
        types.push(
          event.type === "file"
            ? (event as { diff: { rhs: { size: number } } }).diff.rhs.size
            : event.type,
        );
      expect(types).toEqual(["start", 0, 1, "complete"]);
    } finally {
      restore();
    }
  });

  it("a host worker exit fails the stream", async () => {
    await fakeDiffr(
      `console.log(${JSON.stringify(JSON.stringify(START))}); setInterval(() => {}, 1000);`,
    );
    const run = (async () => {
      for await (const _ of structuralDiff({
        repositoryPath: repo.root,
        comparison,
        signal: new AbortController().signal,
      }))
        await client.simulateWorkerExit();
    })();
    await expect(run).rejects.toThrow(
      "whiteboard: the host worker exited during the structural diff.",
    );
  });

  it.skipIf(!existsSync(APP_DIFFR))(
    "runs the real Whiteboard.app diffr and matches upstream run in-process",
    async () => {
      const real = { kind: "trees", base: repo.base, head: repo.head } as const;
      const collect = async (stream: AsyncIterable<StructuralDiffEvent>) => {
        const events: StructuralDiffEvent[] = [];
        for await (const event of stream) events.push(event);
        return events;
      };
      const viaHost = await collect(
        structuralDiff({
          repositoryPath: repo.root,
          comparison: real,
          signal: new AbortController().signal,
        }),
      );
      expect(viaHost[0]!.type).toBe("start");
      expect(viaHost.at(-1)).toEqual({ type: "complete", succeeded: 3, failed: 0 });
      const paths = viaHost
        .filter((event) => event.type === "file")
        .map((event) => (event as { file: { rhs: { path: string } } }).file.rhs.path)
        .sort();
      expect(paths).toEqual(["docs/readme.md", "src/a.ts", "src/c.ts"]);
      const direct = await collect(
        upstreamStructuralDiff({
          repositoryPath: repo.root,
          comparison: real,
          signal: new AbortController().signal,
        }),
      );
      const key = (event: StructuralDiffEvent) => JSON.stringify(event);
      expect(viaHost.map(key).sort()).toEqual(direct.map(key).sort());
    },
  );
});
