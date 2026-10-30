import { makePluginRuntime, type PluginRuntimeHost } from "@bb-plugins/effect-bridge";
import { Clock, Effect, Layer, Stream } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { delay, settlesWithin, virtualClock } from "../test-support.ts";
import { BoatApiError, type BoatAttachFrame, type BoatClient } from "./boat-api.ts";
import { createBoatExecutor, shellCommand, shellQuote } from "./executor.ts";

type CommandStatus = Awaited<ReturnType<BoatClient["commandStatus"]>>;

/** An attach stream that sends `frames` and then nothing at all, not even a heartbeat. */
const stalled = (frames: BoatAttachFrame[]) => ({ stalled: frames });
type FakeStream = BoatAttachFrame[] | ReturnType<typeof stalled>;

const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

/** The executor under test; `elapsed` is how long it waited between Boat calls. */
async function executorFor(client: BoatClient, options: { liveTime?: boolean } = {}) {
  const time = virtualClock(0);
  const host = {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onDispose: (dispose: () => void | Promise<void>) => {
      disposers.push(dispose);
    },
  } as unknown as PluginRuntimeHost;
  const runtime = await makePluginRuntime(
    host,
    options.liveTime ? Layer.empty : Layer.succeed(Clock.Clock, time.clock),
  );
  return {
    executor: createBoatExecutor(client, "bx_1", { randomId: () => "r1", run: runtime.run }),
    elapsed: () => time.now(),
  };
}

function fakeClient(
  streams: FakeStream[],
  status: CommandStatus = { status: "exited", running: false, exitCode: 0 },
) {
  const files = new Map<string, string>();
  const commands: string[] = [];
  const stopped: number[] = [];
  let attachCount = 0;
  const client = {
    async writeFile(_id: string, path: string, content: string) {
      files.set(path, content);
    },
    async deleteFile(_id: string, path: string) {
      files.delete(path);
    },
    async startCommand(_id: string, command: string) {
      commands.push(command);
      return 42;
    },
    async commandStatus() {
      return status;
    },
    attach() {
      const stream = streams[attachCount] ?? [];
      attachCount += 1;
      return Array.isArray(stream)
        ? Stream.fromIterable(stream)
        : Stream.fromIterable(stream.stalled).pipe(Stream.concat(Stream.never));
    },
    async stopCommand(_id: string, processId: number) {
      stopped.push(processId);
    },
  } satisfies Partial<BoatClient>;
  return {
    client: client as unknown as BoatClient,
    files,
    commands,
    stopped,
    attachCount: () => attachCount,
  };
}

test("quotes argv for a POSIX shell", () => {
  expect(shellQuote("it's")).toBe(String.raw`'it'\''s'`);
  expect(shellCommand(["echo", "a b"], null)).toBe("'echo' 'a b' < /dev/null");
  expect(shellCommand(["sh", "-c", "x"], "/tmp/in")).toBe(
    "{ 'sh' '-c' 'x'; } < '/tmp/in'; rc=$?; rm -f '/tmp/in'; exit $rc",
  );
});

test("stages stdin as a base64 file, streams output, and cleans the file up", async () => {
  const fake = fakeClient([
    [
      { type: "attached" },
      { type: "stdout", data: "one\n", nextOffset: 4 },
      { type: "stderr", data: "two\n", nextOffset: 4 },
      { type: "exit", status: "exited", exitCode: 3, signal: null },
    ],
  ]);
  const { executor } = await executorFor(fake.client);
  const output: string[] = [];
  const result = await executor.exec({
    command: ["bash", "-c", "cat"],
    stdin: "secret bundle",
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onOutput: (chunk) => output.push(chunk),
  });
  expect(result).toEqual({ exitCode: 3 });
  expect(output).toEqual(["one\n", "two\n"]);
  expect(fake.commands[0]).toContain("< '/tmp/bb-exec-r1.stdin'");
  expect(fake.files.size).toBe(0);
});

test("re-attaches after a reconnect frame with the offsets it names", async () => {
  const fake = fakeClient([
    [
      { type: "stdout", data: "a", nextOffset: 1 },
      { type: "reconnect", stdoutOffset: 1, stderrOffset: 0 },
    ],
    [
      { type: "stdout", data: "b", nextOffset: 2 },
      { type: "exit", status: "exited", exitCode: 0, signal: null },
    ],
  ]);
  const { executor } = await executorFor(fake.client);
  const output: string[] = [];
  await executor.exec({
    command: ["true"],
    stdin: "",
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onOutput: (c) => output.push(c),
  });
  expect(output.join("")).toBe("ab");
  expect(fake.attachCount()).toBe(2);
});

test("a stream that closes without an exit frame falls back to the command status", async () => {
  const fake = fakeClient([[{ type: "stdout", data: "x", nextOffset: 1 }]], {
    status: "exited",
    running: false,
    exitCode: 7,
  });
  const { executor } = await executorFor(fake.client);
  const result = await executor.exec({
    command: ["true"],
    stdin: "",
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onOutput: () => {},
  });
  expect(result).toEqual({ exitCode: 7 });
});

test("a cancelled exec stops the detached command", async () => {
  const controller = new AbortController();
  const fake = fakeClient([]);
  fake.client.attach = () =>
    Stream.unwrap(
      Effect.sync(() => {
        controller.abort(new Error("cancelled"));
        return Stream.fail(controller.signal.reason);
      }),
    );
  const { executor } = await executorFor(fake.client);
  await expect(
    executor.exec({
      command: ["sleep", "100"],
      stdin: "",
      timeoutMs: 60_000,
      signal: controller.signal,
      onOutput: () => {},
    }),
  ).rejects.toThrow("cancelled");
  expect(fake.stopped).toEqual([42]);
});

test("a stream that keeps failing stops the detached command before giving up", async () => {
  const fake = fakeClient([], { status: "running", running: true, exitCode: null });
  fake.client.attach = () => Stream.fail(new Error("socket hang up"));
  const { executor } = await executorFor(fake.client);
  await expect(
    executor.exec({
      command: ["sleep", "100"],
      stdin: "",
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    }),
  ).rejects.toThrow(/closed the command stream 5 times .*socket hang up/);
  expect(fake.stopped).toEqual([42]);
});

test("a timed-out exec stops the command and names the timeout", async () => {
  const fake = fakeClient([], { status: "running", running: true, exitCode: null });
  fake.client.attach = () => Stream.never;
  const { executor } = await executorFor(fake.client);
  await expect(
    executor.exec({
      command: ["sleep", "100"],
      stdin: "",
      timeoutMs: 20,
      signal: new AbortController().signal,
      onOutput: () => {},
    }),
  ).rejects.toThrow("Boat command timed out after 20 ms");
  expect(fake.stopped).toEqual([42]);
});

test("repeats the first machine calls while a resumed sandbox is still restoring", async () => {
  const fake = fakeClient([[{ type: "exit", status: "exited", exitCode: 0, signal: null }]]);
  const writeFile = fake.client.writeFile;
  const startCommand = fake.client.startCommand;
  let writes = 0;
  let starts = 0;
  fake.client.writeFile = async (...args) => {
    writes += 1;
    if (writes === 1) {
      throw new BoatApiError(502, "sandbox_direct_failed", "x", null, "sandbox_restoring", true);
    }
    return writeFile(...args);
  };
  fake.client.startCommand = async (...args) => {
    starts += 1;
    if (starts === 1) throw new BoatApiError(409, "sandbox_starting", "x", null);
    return startCommand(...args);
  };
  const { executor } = await executorFor(fake.client);
  const result = await executor.exec({
    command: ["true"],
    stdin: "payload",
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onOutput: () => {},
  });
  expect(result).toEqual({ exitCode: 0 });
  expect({ writes, starts }).toEqual({ writes: 2, starts: 2 });
  expect(fake.commands).toHaveLength(1);
  expect(fake.files.size).toBe(0);
});

test("refuses stdin larger than Boat's file write before touching the sandbox", async () => {
  const fake = fakeClient([]);
  const { executor } = await executorFor(fake.client);
  await expect(
    executor.exec({
      command: ["true"],
      stdin: "x".repeat(5 * 1024 * 1024 + 1),
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    }),
  ).rejects.toThrow(/5 MiB/);
  expect(fake.commands).toEqual([]);
  expect(fake.files.size).toBe(0);
});

test("a lost process has no exit code and fails loudly", async () => {
  const fake = fakeClient([[{ type: "exit", status: "lost", exitCode: null, signal: null }]]);
  const { executor } = await executorFor(fake.client);
  await expect(
    executor.exec({
      command: ["true"],
      stdin: "",
      timeoutMs: 60_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    }),
  ).rejects.toThrow(/lost track/);
  expect(vi.isMockFunction(fake.client.attach)).toBe(false);
});

const running: CommandStatus = { status: "running", running: true, exitCode: null };
const exited = (exitCode: number): BoatAttachFrame => ({
  type: "exit",
  status: "exited",
  exitCode,
  signal: null,
});
const request = (
  overrides: Partial<Parameters<ReturnType<typeof createBoatExecutor>["exec"]>[0]>,
) => ({
  command: ["true"],
  stdin: "",
  timeoutMs: 60_000,
  signal: new AbortController().signal,
  onOutput: () => {},
  ...overrides,
});

test("gives up after 15 attempts, 2 s apart, while Boat keeps answering retryable", async () => {
  const fake = fakeClient([]);
  let writes = 0;
  fake.client.writeFile = async () => {
    writes += 1;
    throw new BoatApiError(503, "no_ready_machine", "Boat no_ready_machine: busy", null);
  };
  const { executor, elapsed } = await executorFor(fake.client);
  await expect(executor.exec(request({ stdin: "payload" }))).rejects.toThrow(
    "Boat no_ready_machine: busy",
  );
  expect(writes).toBe(15);
  expect(elapsed()).toBe(14 * 2_000);
  expect(fake.commands).toEqual([]);
});

test("does not repeat a command the machine may have run", async () => {
  const fake = fakeClient([]);
  let starts = 0;
  fake.client.startCommand = async () => {
    starts += 1;
    throw new BoatApiError(
      502,
      "sandbox_direct_failed",
      "Boat agent timeout",
      null,
      "agent timeout",
      true,
    );
  };
  const { executor } = await executorFor(fake.client);
  await expect(executor.exec(request({}))).rejects.toThrow("Boat agent timeout");
  expect(starts).toBe(1);
});

test("counts dropped streams per quiet stretch, waiting 1 s before each re-attach", async () => {
  const drop = (n: number): BoatAttachFrame[] => [{ type: "stdout", data: `${n}`, nextOffset: n }];
  const fake = fakeClient(
    [drop(1), drop(2), drop(3), drop(4), drop(5), drop(6), [exited(0)]],
    running,
  );
  const { executor, elapsed } = await executorFor(fake.client);
  const output: string[] = [];
  await expect(
    executor.exec(request({ onOutput: (chunk) => output.push(chunk) })),
  ).resolves.toEqual({
    exitCode: 0,
  });
  expect(output.join("")).toBe("123456");
  expect(elapsed()).toBe(6 * 1_000);
});

test("removes the staged stdin even when the upload's outcome is unknown", async () => {
  const fake = fakeClient([]);
  const writeFile = fake.client.writeFile;
  fake.client.writeFile = async (...args) => {
    await writeFile(...args);
    throw new Error("socket hang up");
  };
  const { executor } = await executorFor(fake.client);
  await expect(executor.exec(request({ stdin: "secret" }))).rejects.toThrow("socket hang up");
  expect(fake.files.size).toBe(0);
  expect(fake.commands).toEqual([]);
});

test("a timed-out exec removes the staged stdin as well as stopping the command", async () => {
  const fake = fakeClient([stalled([])], running);
  const { executor } = await executorFor(fake.client);
  await expect(executor.exec(request({ stdin: "secret", timeoutMs: 20 }))).rejects.toThrow(
    "Boat command timed out after 20 ms",
  );
  expect(fake.stopped).toEqual([42]);
  expect(fake.files.size).toBe(0);
});

test("a cancel while waiting to repeat a call settles at once", async () => {
  const controller = new AbortController();
  const fake = fakeClient([]);
  fake.client.writeFile = async () => {
    throw new BoatApiError(502, "sandbox_direct_failed", "x", null, "sandbox_restoring", true);
  };
  const { executor } = await executorFor(fake.client, { liveTime: true });
  const exec = executor.exec(request({ stdin: "payload", signal: controller.signal }));
  // Boat asked for a retry 2 s from now; the cancel arrives while the executor waits for it.
  await delay(50);
  controller.abort(new Error("cancelled"));
  expect(await settlesWithin(exec, 500)).toBe("rejected");
  await expect(exec).rejects.toThrow("cancelled");
});

test("a stream that goes silent is attached again instead of waiting out the exec timeout", async () => {
  const fake = fakeClient(
    [
      stalled([{ type: "attached" }, { type: "stdout", data: "a", nextOffset: 1 }]),
      [{ type: "stdout", data: "b", nextOffset: 2 }, exited(0)],
    ],
    running,
  );
  const { executor } = await executorFor(fake.client);
  const output: string[] = [];
  const exec = executor.exec(
    request({ timeoutMs: 10 * 60_000, onOutput: (chunk) => output.push(chunk) }),
  );
  expect(await settlesWithin(exec, 1_000)).toBe("resolved");
  await expect(exec).resolves.toEqual({ exitCode: 0 });
  expect(output.join("")).toBe("ab");
  expect(fake.attachCount()).toBe(2);
});

test("a cancel while Boat is still starting the command settles at once", async () => {
  const controller = new AbortController();
  const fake = fakeClient([]);
  fake.client.startCommand = async () => {
    throw new BoatApiError(409, "sandbox_starting", "x", null);
  };
  const { executor } = await executorFor(fake.client, { liveTime: true });
  const exec = executor.exec(request({ signal: controller.signal }));
  await delay(50);
  controller.abort(new Error("cancelled"));
  expect(await settlesWithin(exec, 500)).toBe("rejected");
  await expect(exec).rejects.toThrow("cancelled");
  expect(fake.stopped).toEqual([]);
});

test("a cancel that lands while Boat returns the started command's ID still stops it", async () => {
  const controller = new AbortController();
  const fake = fakeClient([[exited(0)]]);
  const startCommand = fake.client.startCommand;
  fake.client.startCommand = async (...args) => {
    const processId = await startCommand(...args);
    // Boat has started the command; the cancel arrives before its ID reaches the executor.
    controller.abort(new Error("cancelled"));
    return processId;
  };
  const { executor } = await executorFor(fake.client);
  await expect(executor.exec(request({ signal: controller.signal }))).rejects.toThrow("cancelled");
  expect(fake.commands).toHaveLength(1);
  expect(fake.stopped).toEqual([42]);
});
