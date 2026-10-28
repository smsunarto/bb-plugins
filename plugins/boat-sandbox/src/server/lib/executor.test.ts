import { expect, test, vi } from "vitest";
import { BoatApiError, type BoatAttachFrame, type BoatClient } from "./boat-api.ts";
import { createBoatExecutor, shellCommand, shellQuote } from "./executor.ts";

type CommandStatus = Awaited<ReturnType<BoatClient["commandStatus"]>>;

function fakeClient(
  streams: BoatAttachFrame[][],
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
    async *attach(_id: string, _pid: number, offsets: { stdout: number; stderr: number }) {
      const frames = streams[attachCount] ?? [];
      attachCount += 1;
      void offsets;
      for (const frame of frames) yield frame;
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

const deps = { randomId: () => "r1", sleep: async () => {} };

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
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  fake.client.attach = async function* () {
    controller.abort(new Error("cancelled"));
    throw controller.signal.reason;
  };
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  fake.client.attach = async function* () {
    throw new Error("socket hang up");
  };
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  fake.client.attach = async function* (_id, _pid, _offsets, signal) {
    await new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
  const executor = createBoatExecutor(fake.client, "bx_1", deps);
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
