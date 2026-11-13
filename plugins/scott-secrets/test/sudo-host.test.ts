import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PasswordCache } from "../src/host/cache.ts";
import { createSudoHandlers } from "../src/host/handlers.ts";
import { createSudoRunner } from "../src/host/sudo.ts";

/**
 * A stand-in for /usr/bin/sudo: checks the password line on stdin against a
 * file, logs every invocation, and runs the command after `--` itself.
 */
const STUB = `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$*" >> "$dir/calls.log"
IFS= read -r line || line=""
if [ "$line" != "$(cat "$dir/password")" ]; then
  echo "Sorry, try again." >&2
  exit 1
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    -v) exit 0 ;;
    --) shift; exec "$@" ;;
    *) shift ;;
  esac
done
exit 2
`;

let dir: string;
let lease: { retained: number; released: number };

function setup(password: string) {
  writeFileSync(join(dir, "password"), password);
  const binary = join(dir, "sudo");
  writeFileSync(binary, STUB);
  chmodSync(binary, 0o755);
  return binary;
}

function context() {
  return {
    signal: new AbortController().signal,
    retain: () => {
      lease.retained += 1;
      return {
        dispose: async () => {
          lease.released += 1;
        },
      };
    },
  };
}

function calls(): string[] {
  try {
    return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const base = { threadId: "t1", cwd: "/", cacheMs: 60_000, timeoutMs: 10_000 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scott-secrets-"));
  lease = { retained: 0, released: 0 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sudo host handlers", () => {
  test("first run needs a password; a typed one is validated, cached, and reused", async () => {
    const sudo = createSudoHandlers(
      createSudoRunner({ binary: setup("hunter2"), timeoutBinary: null }),
    );
    expect(await sudo.run({ ...base, argv: ["echo", "hi"] }, context())).toEqual({
      outcome: "needs_password",
    });

    const first = await sudo.run({ ...base, argv: ["echo", "hi"], password: "hunter2" }, context());
    expect(first).toMatchObject({ outcome: "ran", exitCode: 0, stdout: "hi\n" });
    expect(sudo.cache.status("t1").cached).toBe(true);
    expect(lease.retained).toBe(1);

    const second = await sudo.run({ ...base, argv: ["echo", "again"] }, context());
    expect(second).toMatchObject({ outcome: "ran", exitCode: 0, stdout: "again\n" });
    // -S -k -p '' on every call, -v before each command, and the password never in argv.
    expect(calls()).toEqual([
      "-S -k -p  -v",
      "-S -k -p  -- echo hi",
      "-S -k -p  -v",
      "-S -k -p  -- echo again",
    ]);
    expect(calls().join("\n")).not.toContain("hunter2");
  });

  test("a wrong typed password is rejected once and not cached", async () => {
    const sudo = createSudoHandlers(
      createSudoRunner({ binary: setup("hunter2"), timeoutBinary: null }),
    );
    const result = await sudo.run({ ...base, argv: ["true"], password: "nope" }, context());
    expect(result).toEqual({ outcome: "auth_failed", detail: "Sorry, try again." });
    expect(sudo.cache.status("t1").cached).toBe(false);
    expect(calls()).toEqual(["-S -k -p  -v"]);
    expect(lease.retained).toBe(0);
  });

  test("a cached password sudo no longer accepts is evicted without running the command", async () => {
    const sudo = createSudoHandlers(
      createSudoRunner({ binary: setup("hunter2"), timeoutBinary: null }),
    );
    await sudo.run({ ...base, argv: ["true"], password: "hunter2" }, context());
    writeFileSync(join(dir, "password"), "changed");

    const result = await sudo.run({ ...base, argv: ["touch", join(dir, "ran")] }, context());
    expect(result.outcome).toBe("auth_failed");
    expect(sudo.cache.status("t1").cached).toBe(false);
    expect(lease.released).toBe(1);
    expect(calls().at(-1)).toBe("-S -k -p  -v");
    expect(await sudo.run({ ...base, argv: ["true"] }, context())).toEqual({
      outcome: "needs_password",
    });
  });

  test("argv reaches the command verbatim, with no shell", async () => {
    const sudo = createSudoHandlers(createSudoRunner({ binary: setup("pw"), timeoutBinary: null }));
    const tricky = ["a b", "$(id)", "'q'", "--", "-v", ""];
    const result = await sudo.run(
      {
        ...base,
        argv: ["node", "-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...tricky],
        password: "pw",
      },
      context(),
    );
    expect(result.outcome).toBe("ran");
    if (result.outcome !== "ran") return;
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  test("the command's exit code and stderr pass through, and it gets no stdin", async () => {
    const sudo = createSudoHandlers(createSudoRunner({ binary: setup("pw"), timeoutBinary: null }));
    const result = await sudo.run(
      { ...base, argv: ["sh", "-c", "cat; echo oops >&2; exit 7"], password: "pw" },
      context(),
    );
    expect(result).toMatchObject({
      outcome: "ran",
      exitCode: 7,
      stdout: "",
      stderr: "oops\n",
      timedOut: false,
    });
  });

  test("a command past its timeout is terminated", async () => {
    const sudo = createSudoHandlers(createSudoRunner({ binary: setup("pw"), timeoutBinary: null }));
    const result = await sudo.run(
      { ...base, timeoutMs: 300, argv: ["sleep", "5"], password: "pw" },
      context(),
    );
    expect(result).toMatchObject({ outcome: "ran", timedOut: true });
  });

  test("the deadline is enforced as root by coreutils timeout", async () => {
    const sudo = createSudoHandlers(
      createSudoRunner({ binary: setup("pw"), timeoutBinary: "/usr/bin/timeout" }),
    );
    const result = await sudo.run(
      { ...base, timeoutMs: 1_000, argv: ["sleep", "5"], password: "pw" },
      context(),
    );
    expect(result).toMatchObject({ outcome: "ran", exitCode: 124, timedOut: true });
    expect(calls().at(-1)).toBe("-S -k -p  -- /usr/bin/timeout -k 5s 1s sleep 5");
  });

  test("forgetting mid-run does not corrupt the password in use", async () => {
    const sudo = createSudoHandlers(createSudoRunner({ binary: setup("pw"), timeoutBinary: null }));
    await sudo.run({ ...base, argv: ["true"], password: "pw" }, context());
    const run = sudo.run({ ...base, argv: ["echo", "ok"] }, context());
    sudo.forget("t1");
    expect(await run).toMatchObject({ outcome: "ran", exitCode: 0, stdout: "ok\n" });
  });

  test("forget overwrites and drops the cached password", async () => {
    const cache = new PasswordCache();
    const sudo = createSudoHandlers(
      createSudoRunner({ binary: setup("pw"), timeoutBinary: null }),
      cache,
    );
    await sudo.run({ ...base, argv: ["true"], password: "pw" }, context());
    const held = cache.get("t1");
    expect(held?.toString()).toBe("pw");
    expect(sudo.forget("t1")).toEqual({ forgotten: true });
    expect(held?.every((byte) => byte === 0)).toBe(true);
    expect(sudo.forget("t1")).toEqual({ forgotten: false });
    expect(lease.released).toBe(1);
  });
});

describe("PasswordCache", () => {
  const noLease = () => ({ dispose: async () => {} });

  test("expires a fixed time after the password was typed; use does not extend it", () => {
    let now = 1_000;
    const cache = new PasswordCache(() => now);
    cache.set("t1", Buffer.from("pw"), 100, noLease);
    now = 1_099;
    expect(cache.get("t1")).not.toBeNull();
    now = 1_100;
    expect(cache.get("t1")).toBeNull();
    expect(cache.status("t1")).toEqual({ cached: false, expiresAt: null });
  });

  test("keeps one password per thread and releases the worker when the last goes", () => {
    let released = 0;
    let retained = 0;
    const retain = () => {
      retained += 1;
      return {
        dispose: async () => {
          released += 1;
        },
      };
    };
    const cache = new PasswordCache();
    cache.set("t1", Buffer.from("a"), 60_000, retain);
    cache.set("t2", Buffer.from("b"), 60_000, retain);
    expect(cache.get("t1")?.toString()).toBe("a");
    expect(cache.get("t3")).toBeNull();
    expect(retained).toBe(1);
    cache.clear("t1");
    expect(released).toBe(0);
    expect(cache.clearAll()).toBe(1);
    expect(released).toBe(1);
  });
});

describe("sudo per-thread cache", () => {
  test("another thread's password does not approve this thread's command", async () => {
    const sudo = createSudoHandlers(createSudoRunner({ binary: setup("pw"), timeoutBinary: null }));
    await sudo.run({ ...base, argv: ["true"], password: "pw" }, context());
    expect(await sudo.run({ ...base, threadId: "t2", argv: ["true"] }, context())).toEqual({
      outcome: "needs_password",
    });
    expect(sudo.cache.status("t1").cached).toBe(true);
  });
});
