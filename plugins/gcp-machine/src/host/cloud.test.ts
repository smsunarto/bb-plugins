import assert from "node:assert/strict";
import { test } from "node:test";
import { GoogleCompute } from "../shared/node/cloud.ts";
import { run, shellQuote, type Run } from "../shared/node/process.ts";
import type { VmStatus } from "../shared/schema.ts";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.ts";

const target = {
  project: "test-project",
  zone: "us-west1-a",
  instance: "test-vm",
  instanceId: "1234",
};
const access = { gcloudPath: "gcloud", account: "test@example.com", sshUser: "test" };
const signal = new AbortController().signal;
const requestId = "a5d08fa4-cd76-4294-a061-22d4732435d1";
const instance = (status: VmStatus) => ({
  id: "1234",
  name: "test-vm",
  status,
  disks: [{ type: "PERSISTENT" }],
});
const auth: Run = async () => ({ exitCode: 0, stdout: "secret-token\n", stderr: "" });
function cloud(responses: unknown[]) {
  const calls: { url: string; method: string }[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-token");
    if (!responses.length) throw new Error("unexpected request");
    return new Response(JSON.stringify(responses.shift()));
  };
  return { client: new GoogleCompute(auth, request, async () => {}), calls };
}

test("stop pins the instance ID, deduplicates submission and waits for completion", async () => {
  const f = cloud([
    instance("RUNNING"),
    { name: "op-1", status: "PENDING", targetId: "1234" },
    { name: "op-1", status: "DONE", targetId: "1234" },
    instance("TERMINATED"),
  ]);
  const result = await f.client.power(target, access, "stop", requestId, signal);
  assert.equal(result.outcome, "completed");
  assert.deepEqual(
    f.calls.filter((call) => call.method === "POST").map((call) => call.url),
    [
      `https://compute.googleapis.com/compute/v1/projects/test-project/zones/us-west1-a/instances/1234/stop?requestId=${requestId}`,
    ],
  );
});

test("replacing the VM or attaching Local SSD prevents any power request", async () => {
  for (const value of [
    { ...instance("RUNNING"), id: "5678" },
    { ...instance("RUNNING"), disks: [{ type: "SCRATCH" }] },
  ]) {
    const f = cloud([value]);
    assert.equal(
      (await f.client.power(target, access, "stop", requestId, signal)).outcome,
      "not-submitted",
    );
    assert.equal(f.calls.length, 1);
  }
});

test("a status this plugin does not model is refused before any write", async () => {
  const f = cloud([{ ...instance("RUNNING"), status: "NOT_FOUND" }]);
  const result = await f.client.power(target, access, "stop", requestId, signal);
  assert.equal(result.outcome, "not-submitted");
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0);
});

test("start waits for an existing stop and never submits repeated starts while booting", async () => {
  const f = cloud([
    instance("STOPPING"),
    instance("TERMINATED"),
    { name: "op-1", status: "DONE" },
    instance("RUNNING"),
  ]);
  await f.client.power(target, access, "start", requestId, signal);
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  const booting = cloud([instance("STAGING"), instance("RUNNING")]);
  await booting.client.power(target, access, "start", requestId, signal);
  assert.equal(booting.calls.filter((call) => call.method === "POST").length, 0);
});

test("terminal cloud failures are distinct from uncertain transport failures", async () => {
  const f = cloud([
    instance("TERMINATED"),
    {
      name: "op-1",
      status: "DONE",
      error: { errors: [{ code: "CAPACITY", message: "sensitive details" }] },
    },
  ]);
  const result = await f.client.power(target, access, "start", requestId, signal);
  assert.deepEqual(result, { outcome: "failed", error: "Google start failed: CAPACITY" });
  assert.ok(!JSON.stringify(result).includes("sensitive"));
});

test("authentication errors never expose stderr or tokens", async () => {
  const client = new GoogleCompute(async () => ({
    exitCode: 1,
    stdout: "secret",
    stderr: "secret",
  }));
  await assert.rejects(
    client.inspect(target, access, signal),
    (error: Error) => !error.message.includes("secret"),
  );
});

test("a rejected POST is not submitted, while a server failure stays uncertain", async () => {
  for (const status of [403, 503]) {
    const client = new GoogleCompute(auth, async (_url, init) =>
      init?.method === "POST"
        ? new Response("unavailable", { status })
        : new Response(JSON.stringify(instance("RUNNING"))),
    );
    if (status === 403) {
      assert.equal(
        (await client.power(target, access, "stop", requestId, signal)).outcome,
        "not-submitted",
      );
    } else {
      await assert.rejects(client.power(target, access, "stop", requestId, signal), /HTTP 503/);
    }
  }
});

test("only a 404 for the pinned instance settles a deleted VM without a power write", async () => {
  for (const status of [404, 403, 503]) {
    const calls: { url: string; method: string }[] = [];
    const client = new GoogleCompute(auth, async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response("unavailable", { status });
    });
    if (status === 404) {
      assert.deepEqual(await client.power(target, access, "stop", requestId, signal), {
        outcome: "gone",
      });
    } else {
      await assert.rejects(client.inspect(target, access, signal), new RegExp(`HTTP ${status}`));
    }
    assert.deepEqual(calls, [
      {
        url: "https://compute.googleapis.com/compute/v1/projects/test-project/zones/us-west1-a/instances/1234",
        method: "GET",
      },
    ]);
  }
});

test("a missing numeric identity cannot bootstrap a replacement with the same name", async () => {
  const calls: Parameters<Run>[] = [];
  const execute: Run = async (...args) => {
    calls.push(args);
    return { exitCode: 0, stdout: "token", stderr: "" };
  };
  const client = new GoogleCompute(execute, async () => new Response("gone", { status: 404 }));
  await assert.rejects(
    client.bootstrap(target, access, ["sh", "-s"], "bootstrap", 5000, signal),
    /pinned VM must be running/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]![1].slice(0, 2), ["auth", "print-access-token"]);
});

test("remote arguments are shell quoted and bootstrap input is sent on stdin", async () => {
  const calls: Parameters<Run>[] = [];
  const exec: Run = async (...args) => {
    calls.push(args);
    return { exitCode: 0, stdout: calls.length === 1 ? "token" : "ok", stderr: "" };
  };
  const client = new GoogleCompute(
    exec,
    async () => new Response(JSON.stringify(instance("RUNNING"))),
  );
  const argument = "don't $(touch /tmp/bad); `id`";
  await client.bootstrap(target, access, ["sh", "-c", argument], "bootstrap-secret", 5000, signal);
  assert.equal(
    calls[1]![1].find((arg) => arg.startsWith("--command=")),
    `--command='sh' '-c' ${shellQuote(argument)}`,
  );
  assert.equal(calls[1]![2].stdin, "bootstrap-secret");
  assert.ok(!calls[1]![1].join(" ").includes("bootstrap-secret"));
});

test("process cancellation terminates commands promptly", async () => {
  const abort = new AbortController();
  const task = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    signal: abort.signal,
    timeoutMs: 5000,
  });
  abort.abort();
  await assert.rejects(task, /cancelled/);
});

test("bootstrap retries pre-session connection failures while the guest boots", async () => {
  let attempts = 0;
  let waits = 0;
  const execute: Run = async (_file, args) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: "token", stderr: "" };
    attempts++;
    return attempts < 3
      ? {
          exitCode: 1,
          stdout: "",
          stderr: "Error while connecting [4003: 'failed to connect to backend']",
        }
      : { exitCode: 0, stdout: "started", stderr: "" };
  };
  const client = new GoogleCompute(
    execute,
    async () => new Response(JSON.stringify(instance("RUNNING"))),
    async () => {
      waits++;
    },
  );
  const result = await client.bootstrap(target, access, ["sh", "-s"], "bootstrap", 5000, signal);
  assert.equal(result.exitCode, 0);
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});

test("bootstrap recovers from the live boot-time SSH banner timeout with backoff", async () => {
  let attempts = 0;
  const waits: (number | undefined)[] = [];
  const execute: Run = async (_file, args) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: "token", stderr: "" };
    attempts++;
    return attempts < 4
      ? {
          exitCode: 255,
          stdout: "",
          stderr:
            "Connection timed out during banner exchange\nConnection to UNKNOWN port 65535 timed out\n",
        }
      : { exitCode: 0, stdout: "daemon started", stderr: "" };
  };
  const client = new GoogleCompute(
    execute,
    async () => new Response(JSON.stringify(instance("RUNNING"))),
    async (_signal, delayMs) => {
      waits.push(delayMs);
    },
  );
  assert.equal((await client.bootstrap(target, access, ["sh"], "", 5000, signal)).exitCode, 0);
  assert.deepEqual(waits, [2000, 4000, 8000]);
});

test("bootstrap never retries a connection-looking error after remote output", async () => {
  let attempts = 0;
  const execute: Run = async (_file, args) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: "token", stderr: "" };
    attempts++;
    return {
      exitCode: 255,
      stdout: "installer already started\n",
      stderr: "Connection timed out during banner exchange\n",
    };
  };
  const client = new GoogleCompute(
    execute,
    async () => new Response(JSON.stringify(instance("RUNNING"))),
    async () => {
      assert.fail("must not replay after command output");
    },
  );
  assert.equal((await client.bootstrap(target, access, ["sh"], "", 5000, signal)).exitCode, 255);
  assert.equal(attempts, 1);
});

test("bootstrap stops retrying at the connection deadline even after fast IAP failures", async (t) => {
  let attempts = 0;
  let elapsed = 0;
  t.mock.method(Date, "now", () => elapsed);
  const execute: Run = async (_file, args) => {
    if (args[0] === "auth") return { exitCode: 0, stdout: "token", stderr: "" };
    attempts++;
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error while connecting [4003: 'failed to connect to backend']",
    };
  };
  const client = new GoogleCompute(
    execute,
    async () => new Response(JSON.stringify(instance("RUNNING"))),
    async (_signal, delayMs = 0) => {
      elapsed += delayMs;
    },
  );
  assert.equal((await client.bootstrap(target, access, ["sh"], "", 180000, signal)).exitCode, 1);
  assert.equal(elapsed, 120000);
  assert.equal(attempts, 11);
});

test("bootstrap does not replay a failed command or an uncertain dropped session", async () => {
  for (const stderr of ["installer failed", "Connection to test-vm closed by remote host."]) {
    let attempts = 0;
    const execute: Run = async (_file, args) => {
      if (args[0] === "auth") return { exitCode: 0, stdout: "token", stderr: "" };
      attempts++;
      return { exitCode: 255, stdout: "", stderr };
    };
    const client = new GoogleCompute(
      execute,
      async () => new Response(JSON.stringify(instance("RUNNING"))),
      async () => {
        assert.fail("must not retry an uncertain command");
      },
    );
    assert.equal((await client.bootstrap(target, access, ["sh"], "", 5000, signal)).exitCode, 255);
    assert.equal(attempts, 1);
  }
});

test("bootstrap connection retries are bounded and respect cancellation", async () => {
  for (const cancel of [false, true]) {
    let attempts = 0;
    const controller = new AbortController();
    const execute: Run = async (_file, args) => {
      if (args[0] === "auth") return { exitCode: 0, stdout: "token", stderr: "" };
      attempts++;
      return {
        exitCode: 255,
        stdout: "",
        stderr: "ssh: connect to host localhost port 22: Connection refused",
      };
    };
    const client = new GoogleCompute(
      execute,
      async () => new Response(JSON.stringify(instance("RUNNING"))),
      async () => {
        if (cancel) controller.abort();
      },
    );
    const task = client.bootstrap(target, access, ["sh"], "", 5000, controller.signal);
    if (cancel) await assert.rejects(task, { name: "AbortError" });
    else assert.equal((await task).exitCode, 255);
    assert.equal(attempts, cancel ? 1 : 12);
  }
});

test("host contract rejects unvalidated targets before executing commands", async () => {
  const h = experimental_createHostEntryHarness(hostEntry);
  try {
    await assert.rejects(
      h.experimental_call("inspect", { target: { ...target, project: "../../evil" }, access }),
    );
  } finally {
    await h.experimental_dispose();
  }
});
