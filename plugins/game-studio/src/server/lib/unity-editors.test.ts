import { afterEach, expect, test } from "bun:test";
import Database from "better-sqlite3";
import { EditorClaims } from "./unity-editor-store.ts";
import { UnityEditors, type EditorTransport } from "./unity-editors.ts";
import type { EditorInstance } from "../../shared/unity-editor-contract.ts";

const main: EditorInstance = {
  id: "main",
  projectPath: "/game",
  workspacePath: "/game",
  pid: 101,
  port: 7800,
  version: "6000.3.10f1",
  startedAt: "2026-10-11T00:00:00Z",
  clone: false,
};
const client: EditorInstance = {
  ...main,
  id: "client",
  projectPath: "/game/Library/VP/client",
  pid: 102,
  port: 7801,
  clone: true,
};
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function setup(overrides: Partial<EditorTransport> = {}) {
  const db = new Database(":memory:");
  dbs.push(db);
  const claims = new EditorClaims(db);
  const transport: EditorTransport = {
    discover: async () => ({ instances: [main, client], warnings: [] }),
    probe: async (_, instance) => ({ pid: instance.pid }),
    alive: async () => ({ alive: true }),
    quiet: async () => ({ quiet: true }),
    job: async () => ({ jobId: "job-1", state: "completed", result: { playMode: "stopped" } }),
    ...overrides,
  };
  const ownerState = { inactive: false };
  return {
    service: new UnityEditors(claims, transport, async () => ownerState.inactive),
    ownerState,
    claims,
    db,
    transport,
  };
}
test("a second thread cannot claim, inspect or release an occupied Editor", async () => {
  const { service } = setup();
  const claim = await service.claim("host", "main", "alice", "runtime");
  await expect(service.claim("host", "main", "bob", "runtime")).rejects.toThrow(
    "owned by @thread:alice",
  );
  await expect(service.status("host", "main", "bob", claim.claimId)).rejects.toThrow(
    "owned by this BB thread",
  );
  await expect(service.release("host", "main", "bob", claim.claimId)).rejects.toThrow(
    "owned by this BB thread",
  );
  expect((await service.status("host", "main", "alice", claim.claimId)).claim).toEqual(claim);
});

test("ownership status exposes native work before writes without a legacy job", async () => {
  let checks = 0;
  const background = {
    quiet: false,
    blocking: { source: "recompile_status", status: "triggered" },
  };
  const { service, claims } = setup({
    quiet: async () => {
      checks++;
      return background;
    },
    job: async () => {
      throw new Error("A new claim has no legacy job to inspect");
    },
  });
  const claim = await service.claim("host", "main", "alice", "authoring");
  await expect(service.status("host", "main", "bob", claim.claimId)).rejects.toThrow(
    "owned by this BB thread",
  );
  expect(checks).toBe(0);
  expect(await service.status("host", "main", "alice", claim.claimId)).toEqual({
    claim,
    job: null,
    background,
  });
  expect(claims.get("host", "main")?.jobId).toBeNull();
  await expect(service.release("host", "main", "alice", claim.claimId)).rejects.toThrow(
    "background work",
  );
});

test("runtime clients coexist, while shared authoring and clone authoring are refused", async () => {
  const { service, claims } = setup();
  await service.claim("host", "main", "alice", "runtime");
  const guest = await service.claim("host", "client", "bob", "runtime");
  expect(claims.list("host").map((c) => [c.instance.pid, c.ownerThreadId])).toEqual([
    [101, "alice"],
    [102, "bob"],
  ]);
  await expect(service.claim("host", "client", "charlie", "authoring")).rejects.toThrow(
    "owned by @thread:bob",
  );
  claims.release("host", "client", "bob", guest.claimId);
  await expect(service.claim("host", "client", "charlie", "authoring")).rejects.toThrow(
    "cannot author",
  );
});
test("main authoring blocks another client's runtime claim on the same workspace", async () => {
  const { service } = setup();
  await service.claim("host", "main", "alice", "authoring");
  await expect(service.claim("host", "client", "bob", "runtime")).rejects.toThrow(
    "Shared project is owned by @thread:alice",
  );
});
test("separate physical checkouts allow simultaneous authoring and report separate slots", async () => {
  const other = {
    ...main,
    id: "worktree-main",
    projectPath: "/game-worktree",
    workspacePath: "/game-worktree",
    pid: 103,
    port: 7802,
  };
  const { service } = setup({
    discover: async () => ({ instances: [main, client, other], warnings: [] }),
  });
  await Promise.all([
    service.claim("host", "main", "alice", "authoring"),
    service.claim("host", "worktree-main", "bob", "authoring"),
  ]);
  const inventory = await service.list("host", undefined, "alice");
  expect(
    inventory.slots.map((slot) => ({
      workspacePath: slot.workspacePath,
      mainEditors: slot.mainEditors.map((editor) => editor.id),
      mppmEditors: slot.mppmEditors.map((editor) => editor.id),
      owners: slot.claims.map((claim) => [claim.ownerThreadId, claim.mode]),
    })),
  ).toEqual([
    {
      workspacePath: "/game",
      mainEditors: ["main"],
      mppmEditors: ["client"],
      owners: [["alice", "authoring"]],
    },
    {
      workspacePath: "/game-worktree",
      mainEditors: ["worktree-main"],
      mppmEditors: [],
      owners: [["bob", "authoring"]],
    },
  ]);
  expect(inventory.slots[0]?.claims[0]?.claimId).toBe(inventory.claims[0]?.claimId);
  expect(inventory.slots[1]?.claims[0]).not.toHaveProperty("claimId");
  await expect(service.claim("host", "client", "charlie", "runtime")).rejects.toThrow(
    "Shared project is owned by @thread:alice",
  );
});
test("an undiscovered owner's claim keeps its checkout slot occupied without exposing its token", async () => {
  const { service, transport } = setup();
  await service.claim("host", "main", "alice", "authoring");
  transport.discover = async () => ({
    instances: [],
    warnings: ["Editor not currently discovered"],
  });
  const inventory = await service.list("host", undefined, "bob");
  expect(inventory.instances).toEqual([]);
  expect(
    inventory.slots.map((slot) => ({
      workspacePath: slot.workspacePath,
      mainEditors: slot.mainEditors,
      mppmEditors: slot.mppmEditors,
      owners: slot.claims.map((claim) => claim.ownerThreadId),
    })),
  ).toEqual([{ workspacePath: "/game", mainEditors: [], mppmEditors: [], owners: ["alice"] }]);
  expect(inventory.slots[0]?.claims[0]).not.toHaveProperty("claimId");
});
test("repeat claims are idempotent and a reload preserves the owner", async () => {
  const { service, db, transport } = setup();
  const first = await service.claim("host", "main", "alice", "runtime");
  const again = await service.claim("host", "main", "alice", "runtime");
  expect(again.claimId).toBe(first.claimId);
  const reloaded = new UnityEditors(new EditorClaims(db), transport);
  await expect(reloaded.claim("host", "main", "bob", "runtime")).rejects.toThrow(
    "owned by @thread:alice",
  );
  expect((await reloaded.list("host")).claims[0]?.ownerThreadId).toBe("alice");
});
test("failed PID verification removes only the new reservation", async () => {
  const { service, claims } = setup({ probe: async () => ({ pid: 999 }) });
  await expect(service.claim("host", "main", "alice", "runtime")).rejects.toThrow(
    "PID verification failed",
  );
  expect(claims.get("host", "main")).toBeNull();
});
test("a pending pre-upgrade job blocks release and reports lifecycle state without its result", async () => {
  const { service, claims } = setup();
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  expect(() => claims.release("host", "main", "alice", claim.claimId)).toThrow(
    "pending or uncertain",
  );
  const result = await service.status("host", "main", "alice", claim.claimId);
  expect(result.job).toEqual({
    jobId: "job-1",
    state: "completed",
    error: null,
    uncertain: false,
  });
  expect(result.job).not.toHaveProperty("result");
  expect(result.claim.jobId).toBeNull();
  claims.release("host", "main", "alice", claim.claimId);
  claims.release("host", "main", "alice", claim.claimId);
  const next = await service.claim("host", "main", "bob", "runtime");
  expect(next.ownerThreadId).toBe("bob");
  expect(() => claims.release("host", "main", "alice", claim.claimId)).toThrow("matching claim");
});
test("an uncertain pre-upgrade claim retains ownership until reconciliation", async () => {
  const { service, claims } = setup();
  const claim = await service.claim("host", "main", "alice", "runtime");
  claims.job("host", "main", "alice", claim.claimId, "uncertain", null);
  expect((await service.status("host", "main", "alice", claim.claimId)).claim.jobId).toBe(
    "uncertain",
  );
  await expect(service.release("host", "main", "alice", claim.claimId)).rejects.toThrow(
    "pending or uncertain",
  );
  await expect(service.recover("host", "main")).rejects.toThrow("still alive");
});

test("only a proven dead Editor process allows recovery", async () => {
  const { service, claims } = setup({ alive: async () => ({ alive: false }) });
  await service.claim("host", "main", "alice", "runtime");
  expect(await service.recover("host", "main")).toEqual({ recovered: true });
  expect(claims.get("host", "main")).toBeNull();
  expect(await service.recover("host", "main")).toEqual({ recovered: false });
});
test("late legacy job polling cannot clear a newer pending state", async () => {
  let finish!: (value: any) => void;
  const { service, claims } = setup({
    job: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  const pending = service.status("host", "main", "alice", claim.claimId);
  claims.job("host", "main", "alice", claim.claimId, null, "job-1");
  claims.job("host", "main", "alice", claim.claimId, "submitting", null);
  claims.job("host", "main", "alice", claim.claimId, "job-2", "submitting");
  finish({ jobId: "job-1", state: "completed", result: 1 });
  await pending;
  expect(claims.get("host", "main")?.jobId).toBe("job-2");
});

test("only the owner can reconcile finished work after reload, and busy Editors remain locked", async () => {
  const { service, claims, transport } = setup();
  const claim = await service.claim("host", "main", "alice", "authoring");
  claims.job("host", "main", "alice", claim.claimId, "uncertain", null);
  await expect(service.reconcile("host", "main", "bob", claim.claimId, "checked")).rejects.toThrow(
    "owned by this BB thread",
  );
  transport.quiet = async () => ({ quiet: false });
  await expect(
    service.reconcile("host", "main", "alice", claim.claimId, "checked"),
  ).rejects.toThrow("Editor is busy");
  transport.quiet = async () => ({ quiet: true });
  const result = await service.reconcile(
    "host",
    "main",
    "alice",
    claim.claimId,
    "Compilation finished and owned recorder stopped",
  );
  expect(result.evidence).toBe("Compilation finished and owned recorder stopped");
  expect(claims.get("host", "main")?.jobId).toBeNull();
  claims.release("host", "main", "alice", claim.claimId);
});
test("successful string results and data mentioning timeout do not poison ownership", async () => {
  const { service, claims, transport } = setup({
    job: async () => ({ jobId: "job-1", state: "completed", result: "finished" }),
  });
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  expect((await service.status("host", "main", "alice", claim.claimId)).claim.jobId).toBeNull();
  transport.job = async () => ({
    jobId: "job-1",
    state: "completed",
    result: { timeout_ms: 10000 },
  });
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  await service.status("host", "main", "alice", claim.claimId);
  expect(claims.get("host", "main")?.jobId).toBeNull();
});
test("an idle progress endpoint cannot reconcile a queued native job", async () => {
  const { service, claims } = setup({ job: async () => ({ jobId: "job-1", state: "queued" }) });
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  await expect(
    service.reconcile("host", "main", "alice", claim.claimId, "checked"),
  ).rejects.toThrow("native job is still pending");
  expect(claims.get("host", "main")?.jobId).toBe("job-1");
});

test("reloads discard only unverified read-only probes and retain uncertain submissions", async () => {
  const { claims, db, transport } = setup();
  claims.claim("host", main, "alice", "runtime");
  const reloaded = new EditorClaims(db);
  expect(reloaded.get("host", "main")).toBeNull();
  const next = new UnityEditors(reloaded, transport);
  const owner = await next.claim("host", "main", "alice", "authoring");
  reloaded.job("host", "main", "alice", owner.claimId, "submitting", null);
  const restarted = new UnityEditors(new EditorClaims(db), transport);
  expect(restarted.claims.get("host", "main")?.jobId).toBe("uncertain");
  await restarted.reconcile("host", "main", "alice", owner.claimId, "No owned work remains");
  expect(await restarted.release("host", "main", "alice", owner.claimId)).toEqual({
    released: true,
  });
});
test("parallel same-owner claims probe only once and cannot roll back each other", async () => {
  let probes = 0,
    finish!: () => void;
  const { service, claims } = setup({
    probe: async () => {
      probes++;
      await new Promise<void>((r) => {
        finish = r;
      });
      return { pid: 101 };
    },
  });
  const first = service.claim("host", "main", "alice", "runtime");
  await new Promise((r) => setTimeout(r, 0));
  const second = await service.claim("host", "main", "alice", "runtime");
  expect(second.jobId).toBe("verifying");
  finish();
  const verified = await first;
  expect(probes).toBe(1);
  expect(claims.get("host", "main")?.claimId).toBe(verified.claimId);
  expect(claims.get("host", "main")?.jobId).toBeNull();
});
test("background work retains ownership after the native job finishes", async () => {
  const { service, transport } = setup();
  const claim = await service.claim("host", "main", "alice", "authoring");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  transport.quiet = async () => ({
    quiet: false,
    blocking: { source: "recompile_status", status: "triggered" },
  });
  const status = await service.status("host", "main", "alice", claim.claimId);
  expect(status.job?.state).toBe("completed");
  expect(status.background).toEqual({
    quiet: false,
    blocking: { source: "recompile_status", status: "triggered" },
  });
  expect(status.claim.jobId).toBe("job-1");
  await expect(service.release("host", "main", "alice", claim.claimId)).rejects.toThrow("pending");
  transport.quiet = async () => ({ quiet: true });
  await service.status("host", "main", "alice", claim.claimId);
  expect(await service.release("host", "main", "alice", claim.claimId)).toEqual({ released: true });
});
test("orphan recovery requires an absent owner, explicit evidence and no native background work", async () => {
  const { service, claims, transport, ownerState } = setup();
  await service.claim("host", "main", "alice", "runtime");
  await expect(service.recover("host", "main", { note: "checked" })).rejects.toThrow("still alive");
  ownerState.inactive = true;
  claims.markOrphan("alice");
  await expect(service.recover("host", "main")).rejects.toThrow("explicit confirmation");
  transport.quiet = async () => ({ quiet: false });
  await expect(service.recover("host", "main", { note: "checked" })).rejects.toThrow(
    "background work",
  );
  transport.quiet = async () => ({ quiet: true });
  expect(
    await service.recover("host", "main", {
      note: "Recorder/input stopped and native work complete",
    }),
  ).toEqual({ recovered: true, evidence: "Recorder/input stopped and native work complete" });
});
test("list hides another owner's claim capability", async () => {
  const { service } = setup();
  const claim = await service.claim("host", "main", "alice", "runtime");
  expect((await service.list("host", undefined, "alice")).claims[0]).toHaveProperty(
    "claimId",
    claim.claimId,
  );
  expect((await service.list("host", undefined, "bob")).claims[0]).not.toHaveProperty("claimId");
});
test("validation errors mentioning timeout parameters do not poison ownership", async () => {
  const { service } = setup({
    job: async () => ({
      jobId: "job-1",
      state: "failed",
      error: "'timeout_ms' must be between 1 and 10000",
    }),
  });
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  expect((await service.status("host", "main", "alice", claim.claimId)).claim.jobId).toBeNull();
});

test("restoring an archived owner fences an in-progress orphan recovery", async () => {
  let resume!: () => void;
  const { service, claims, transport, ownerState } = setup();
  await service.claim("host", "main", "alice", "runtime");
  ownerState.inactive = true;
  claims.markOrphan("alice");
  transport.quiet = async () => {
    await new Promise<void>((r) => {
      resume = r;
    });
    return { quiet: true };
  };
  const recovery = service.recover("host", "main", { note: "checked" });
  await new Promise((r) => setTimeout(r, 0));
  claims.markOrphan("alice", false);
  resume();
  await expect(recovery).rejects.toThrow("Claim changed during recovery");
  expect(claims.get("host", "main")?.ownerThreadId).toBe("alice");
});

test("concurrent reconciliation cannot claim success while a newer job remains pending", async () => {
  let resume!: () => void;
  const { service, claims, transport } = setup();
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  transport.quiet = async () => {
    await new Promise<void>((r) => {
      resume = r;
    });
    return { quiet: true };
  };
  const result = service.reconcile("host", "main", "alice", claim.claimId, "checked");
  await new Promise((r) => setTimeout(r, 0));
  claims.job("host", "main", "alice", claim.claimId, "job-2", "job-1");
  resume();
  await expect(result).rejects.toThrow("Claim changed during reconciliation");
  expect(claims.get("host", "main")?.jobId).toBe("job-2");
});

test("missed restore events cannot authorize recovery of a live owner's Editor", async () => {
  const { service, claims, ownerState } = setup();
  await service.claim("host", "main", "alice", "runtime");
  claims.markOrphan("alice");
  ownerState.inactive = false;
  await expect(service.recover("host", "main", { note: "checked" })).rejects.toThrow("still alive");
  expect(claims.get("host", "main")?.orphaned).toBe(false);
});
test("a missed restore during native checks is rechecked before releasing an orphan", async () => {
  let resume!: () => void;
  const { service, claims, transport, ownerState } = setup();
  await service.claim("host", "main", "alice", "runtime");
  ownerState.inactive = true;
  transport.quiet = async () => {
    await new Promise<void>((r) => {
      resume = r;
    });
    return { quiet: true };
  };
  const recovery = service.recover("host", "main", { note: "checked" });
  await new Promise((r) => setTimeout(r, 0));
  ownerState.inactive = false;
  resume();
  await expect(recovery).rejects.toThrow("Owner became active");
  expect(claims.get("host", "main")?.ownerThreadId).toBe("alice");
});
test("serialized nested timeout errors remain uncertain when details are null", async () => {
  const { service } = setup({
    job: async () => ({
      jobId: "job-1",
      state: "completed",
      result: JSON.stringify({ success: false, error: "Timeout", errorDetails: null }),
    }),
  });
  const claim = await service.claim("host", "main", "alice", "runtime");
  service.claims.job("host", "main", "alice", claim.claimId, "job-1", null);
  expect((await service.status("host", "main", "alice", claim.claimId)).claim.jobId).toBe(
    "uncertain",
  );
});

test("startup ownership is authoring only and retains its exact instance", async () => {
  const startup = { ...main, port: null };
  const { service, claims } = setup({
    discover: async () => ({ instances: [startup], warnings: [] }),
    quiet: async () => {
      throw new Error("A startup claim has no Pipeline idle status");
    },
  });
  await expect(service.claim("host", "main", "alice", "runtime")).rejects.toThrow("startup");
  const claim = await service.claim("host", "main", "alice", "authoring");
  expect(
    (await service.status("host", "main", "alice", claim.claimId)).claim.instance.port,
  ).toBeNull();
  expect((await service.status("host", "main", "alice", claim.claimId)).background).toBeNull();
  expect(claims.get("host", "main")?.jobId).toBeNull();
  await expect(service.claim("host", "main", "bob", "authoring")).rejects.toThrow("owned");
});

test("a startup claim promotes the same process only after its Pipeline PID probe", async () => {
  let ready = false;
  const probed: Array<number | null> = [];
  const { service } = setup({
    discover: async () => ({ instances: [{ ...main, port: ready ? 7800 : null }], warnings: [] }),
    probe: async (_, instance) => {
      probed.push(instance.port);
      return { pid: instance.pid };
    },
  });
  const startup = await service.claim("host", "main", "alice", "authoring");
  ready = true;
  const promoted = await service.claim("host", "main", "alice", "authoring");
  expect(promoted.claimId).toBe(startup.claimId);
  expect(promoted.instance.port).toBe(7800);
  expect(probed).toEqual([null, 7800]);
  expect(
    (await service.status("host", "main", "alice", promoted.claimId)).claim.instance.port,
  ).toBe(7800);
});

test("failed Pipeline promotion retains startup ownership", async () => {
  let ready = false;
  const { service, claims } = setup({
    discover: async () => ({ instances: [{ ...main, port: ready ? 7800 : null }], warnings: [] }),
    probe: async (_, instance) => ({ pid: instance.port === null ? instance.pid : 999 }),
  });
  const startup = await service.claim("host", "main", "alice", "authoring");
  ready = true;
  await expect(service.claim("host", "main", "alice", "authoring")).rejects.toThrow("PID");
  expect(claims.get("host", "main")?.claimId).toBe(startup.claimId);
  expect(claims.get("host", "main")?.instance.port).toBeNull();
  expect(claims.get("host", "main")?.jobId).toBeNull();
  expect(
    (await service.status("host", "main", "alice", startup.claimId)).claim.instance.port,
  ).toBeNull();
});
const worktree: EditorInstance = {
  ...main,
  id: "worktree-main",
  projectPath: "/game-worktree",
  workspacePath: "/game-worktree",
  pid: 103,
  port: 7802,
};
test("an owner's turn end releases its claims and reservations unless held", async () => {
  const { service, claims } = setup({
    discover: async () => ({ instances: [main, client, worktree], warnings: [] }),
  });
  await service.claim("host", "main", "alice", "authoring", undefined, { hold: true });
  await service.claim("host", "worktree-main", "bob", "authoring");
  await service.reserve("host", "/game-wt2", "bob", "authoring");
  await service.reserve("host", "/game-wt3", "bob", "runtime", true);
  await service.ownerIdle("bob");
  await service.ownerIdle("alice");
  expect(claims.get("host", "main")?.hold).toBe(true);
  expect(claims.get("host", "worktree-main")).toBeNull();
  expect(claims.reservations("host").map((r) => r.workspacePath)).toEqual(["/game-wt3"]);
  // Re-claiming without hold turns the held claim back into a turn-scoped one.
  const again = await service.claim("host", "main", "alice", "authoring", undefined, {
    hold: false,
  });
  expect(again.hold).toBeUndefined();
  await service.ownerIdle("alice");
  expect(claims.get("host", "main")).toBeNull();
  service.dispose();
});
test("turn-end release waits for a quiet Editor and yields to a resumed owner", async () => {
  const native = { quiet: false, blocking: { source: "progress", status: "active" } } as {
    quiet: boolean;
    blocking?: { source: string; status: string };
  };
  const owner = { status: "idle" };
  const { db, transport } = setup();
  const service = new UnityEditors(
    new EditorClaims(db),
    { ...transport, quiet: async () => native },
    async () => false,
    { ownerStatus: async () => ({ status: owner.status, updatedAt: Date.now() }) },
  );
  const claim = await service.claim("host", "main", "alice", "runtime");
  await service.ownerIdle("alice");
  expect(service.claims.get("host", "main")?.autoRelease).toBe("pending");
  expect((await service.list("host")).claims[0]?.autoRelease).toBe("pending");
  service.ownerActive("alice");
  expect(service.claims.get("host", "main")?.autoRelease).toBeUndefined();
  await service.ownerIdle("alice");
  native.quiet = true;
  delete native.blocking;
  owner.status = "active";
  await service.sweepAutoReleases();
  expect(service.claims.get("host", "main")?.claimId).toBe(claim.claimId);
  expect(service.claims.get("host", "main")?.autoRelease).toBeUndefined();
  owner.status = "idle";
  await service.ownerIdle("alice");
  expect(service.claims.get("host", "main")).toBeNull();
  service.dispose();
});
test("wait claims the Editor as soon as its owner releases, and times out with advice", async () => {
  const { service } = setup();
  const alice = await service.claim("host", "main", "alice", "runtime");
  const waiting = service.wait("host", "main", "bob", "authoring", 5_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.release("host", "main", "alice", alice.claimId);
  const claim = await waiting;
  expect([claim.ownerThreadId, claim.mode]).toEqual(["bob", "authoring"]);
  await expect(service.wait("host", "main", "charlie", "runtime", 30)).rejects.toThrow(
    /Timed out after 30 ms waiting\. Editor is owned by @thread:bob\..*Options: action "wait"/s,
  );
  const aborted = new AbortController();
  const pending = service.wait("host", "main", "charlie", "runtime", 5_000, aborted.signal);
  aborted.abort(new Error("turn cancelled"));
  await expect(pending).rejects.toThrow("turn cancelled");
  service.dispose();
});
test("a reservation protects a launching Editor until its owner claims it", async () => {
  const { service } = setup({
    discover: async () => ({ instances: [main, client, worktree], warnings: [] }),
    resolveWorkspace: async (_, path) => ({ workspacePath: path.replace(/\/+$/, "") }),
  });
  const reservation = await service.reserve("host", "/game-worktree/", "alice", "authoring");
  expect(reservation.workspacePath).toBe("/game-worktree");
  await expect(service.claim("host", "worktree-main", "bob", "runtime")).rejects.toThrow(
    "reserved by @thread:alice",
  );
  await expect(service.reserve("host", "/game-worktree", "bob", "runtime")).rejects.toThrow(
    "reserved by @thread:alice",
  );
  const inventory = await service.list("host", undefined, "bob");
  expect(inventory.reservations.map((r) => [r.workspacePath, r.ownerThreadId])).toEqual([
    ["/game-worktree", "alice"],
  ]);
  expect(
    inventory.slots.find((slot) => slot.workspacePath === "/game-worktree")?.reservations,
  ).toHaveLength(1);
  const claim = await service.claim("host", "worktree-main", "alice", "authoring");
  expect(claim.ownerThreadId).toBe("alice");
  expect((await service.list("host")).reservations).toEqual([]);
  // One reservation per checkout: it stands for the single main Editor being opened there.
  await service.reserve("host", "/elsewhere", "carol", "runtime");
  await expect(service.reserve("host", "/elsewhere", "dave", "runtime")).rejects.toThrow(
    "reserved by @thread:carol",
  );
  await expect(service.releaseReservation("host", "/elsewhere", "dave")).rejects.toThrow(
    "reserved by @thread:carol",
  );
  expect((await service.releaseReservation("host", "/elsewhere", "carol")).released).toBe(true);
  expect((await service.releaseReservation("host", "/elsewhere", "carol")).released).toBe(false);
  service.dispose();
});
test("handoff requests reach the blocking owner once a minute and conflicts explain its state", async () => {
  const sent: [string, string][] = [];
  const { db, transport } = setup();
  const service = new UnityEditors(new EditorClaims(db), transport, async () => false, {
    ownerStatus: async () => ({ status: "idle", updatedAt: Date.now() - 120_000 }),
    send: async (owner, text) => {
      sent.push([owner, text]);
    },
  });
  const alice = await service.claim("host", "main", "alice", "authoring");
  await expect(
    service.request("host", { instanceId: "main" }, "alice", "authoring", "mine"),
  ).rejects.toThrow("Nothing blocks");
  // Alice's main authoring claim also blocks a runtime claim on the clone, so the request goes to her.
  const result = await service.request(
    "host",
    { instanceId: "client" },
    "bob",
    "runtime",
    "bake lighting",
  );
  expect([result.owner, result.ownerStatus?.status, result.requested]).toEqual([
    "alice",
    "idle",
    true,
  ]);
  expect(result.holder).not.toHaveProperty("claimId");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.[0]).toBe("alice");
  for (const part of [
    "@thread:bob",
    alice.claimId,
    "/game/Library/VP/client",
    "bake lighting",
    "bb thread tell bob",
  ])
    expect(sent[0]?.[1]).toContain(part);
  // One request per owner per minute, whoever asks.
  await expect(
    service.request("host", { instanceId: "main" }, "carol", "authoring", "again"),
  ).rejects.toThrow("went to @thread:alice");
  await expect(service.claim("host", "main", "bob", "runtime")).rejects.toThrow(
    /^Editor is owned by @thread:alice\. The owner thread has been idle for 2 min; the claim is about to release\. Options: action "wait"/,
  );
  // A reservation's holder is asked by workspace path.
  await service.reserve("host", "/game-wt9", "dave", "authoring");
  await expect(service.reserve("host", "/game-wt9", "erin", "runtime")).rejects.toThrow(
    /reserved by @thread:dave.*the reservation is about to release\. Options: action "request" with this workspacePath/s,
  );
  const byPath = await service.request(
    "host",
    { workspacePath: "/game-wt9" },
    "erin",
    "runtime",
    "need the worktree",
  );
  expect([byPath.owner, sent.length]).toEqual(["dave", 2]);
  expect(sent[1]?.[1]).toContain("release --workspace /game-wt9");
  expect(service.instanceFor("host", alice.claimId, "alice")).toBe("main");
  expect(() => service.instanceFor("host", alice.claimId, "bob")).toThrow(
    "owned by this BB thread",
  );
  service.dispose();
});
test("turn-end release never hands over a playing Editor or unsaved scenes", async () => {
  const native = { quiet: true, playing: true } as {
    quiet: boolean;
    playing?: boolean;
    dirty?: boolean;
  };
  const { db, transport } = setup();
  const service = new UnityEditors(
    new EditorClaims(db),
    { ...transport, quiet: async () => native },
    async () => false,
    { ownerStatus: async () => ({ status: "idle", updatedAt: Date.now() }) },
  );
  const claim = await service.claim("host", "main", "alice", "authoring");
  await service.ownerIdle("alice");
  let kept = service.claims.get("host", "main");
  expect([kept?.autoRelease, kept?.autoReleaseBlock]).toEqual(["pending", "playing"]);
  await expect(service.claim("host", "main", "bob", "authoring")).rejects.toThrow(
    "blocked by playing",
  );
  native.playing = false;
  native.dirty = true;
  await service.sweepAutoReleases();
  kept = service.claims.get("host", "main");
  expect([kept?.claimId, kept?.autoReleaseBlock]).toEqual([claim.claimId, "unsaved scenes"]);
  native.dirty = false;
  await service.sweepAutoReleases();
  expect(service.claims.get("host", "main")).toBeNull();
  service.dispose();
});
test("a resumed or unreachable owner keeps its claim through an in-flight release", async () => {
  const gate = { resolve: () => {} };
  const owner = { status: "idle" as string, fail: false };
  const { db, transport } = setup();
  const service = new UnityEditors(
    new EditorClaims(db),
    {
      ...transport,
      quiet: () =>
        new Promise((resolve) => {
          gate.resolve = () => resolve({ quiet: true });
        }),
    },
    async () => false,
    {
      ownerStatus: async () => {
        if (owner.fail) throw new Error("bb unreachable");
        return { status: owner.status, updatedAt: Date.now() };
      },
    },
  );
  const claim = await service.claim("host", "main", "alice", "runtime");
  // The owner starts a turn while the quiet probe is still running.
  const releasing = service.ownerIdle("alice");
  await new Promise((resolve) => setTimeout(resolve, 10));
  service.ownerActive("alice");
  gate.resolve();
  await releasing;
  expect(service.claims.get("host", "main")?.claimId).toBe(claim.claimId);
  // BB cannot be reached: ownership is retained and the attempt stays pending.
  owner.fail = true;
  const retry = service.ownerIdle("alice");
  await new Promise((resolve) => setTimeout(resolve, 10));
  gate.resolve();
  await retry;
  const kept = service.claims.get("host", "main");
  expect([kept?.claimId, kept?.autoRelease, kept?.autoReleaseBlock]).toEqual([
    claim.claimId,
    "pending",
    "owner thread status unknown",
  ]);
  service.dispose();
});
test("gone owners lose every reservation, and orphaned reservations are recoverable", async () => {
  const orphans = new Set<string>();
  const { db, transport } = setup({
    discover: async () => ({ instances: [main, client, worktree], warnings: [] }),
  });
  const service = new UnityEditors(new EditorClaims(db), transport, async (owner) =>
    orphans.has(owner),
  );
  await service.reserve("host", "/game-worktree", "alice", "authoring", true);
  await service.reserve("host", "/game-wt2", "bob", "runtime", true);
  await expect(service.recoverReservation("host", "/game-wt2", "carol")).rejects.toThrow(
    "Ask @thread:bob",
  );
  orphans.add("bob");
  expect((await service.recoverReservation("host", "/game-wt2", "carol")).recovered).toBe(true);
  await service.ownerGone("alice");
  expect((await service.list("host")).reservations).toEqual([]);
  // A runtime reservation still protects the main Editor; only MPPM clients may share it.
  await service.reserve("host", "/game", "dave", "runtime");
  await expect(service.claim("host", "main", "erin", "runtime")).rejects.toThrow(
    "reserved by @thread:dave",
  );
  const guest = await service.claim("host", "client", "erin", "runtime");
  expect(guest.ownerThreadId).toBe("erin");
  service.dispose();
});
test("peek reports any Editor's idle state without a claim, and a reload sweeps idle owners", async () => {
  const statuses = new Map([
    ["alice", "idle"],
    ["bob", "active"],
  ]);
  const { db, transport } = setup();
  const hooks = {
    ownerStatus: async (owner: string) => ({
      status: statuses.get(owner) ?? "gone",
      updatedAt: Date.now(),
    }),
  };
  const service = new UnityEditors(new EditorClaims(db), transport, async () => false, hooks);
  const alice = await service.claim("host", "main", "alice", "runtime");
  const peeked = await service.peek("host", "main");
  expect([peeked.background, peeked.claim?.ownerThreadId]).toEqual([{ quiet: true }, "alice"]);
  expect(peeked.claim).not.toHaveProperty("claimId");
  await service.claim("host", "client", "bob", "runtime");
  await service.reserve("host", "/game-wt5", "alice", "runtime");
  // Simulate the plugin reloading after both turns ended without an idle event.
  const reloaded = new UnityEditors(new EditorClaims(db), transport, async () => false, hooks);
  await reloaded.sweepAutoReleases();
  expect(reloaded.claims.get("host", "main")).toBeNull();
  expect(reloaded.claims.get("host", "client")?.ownerThreadId).toBe("bob");
  expect(reloaded.claims.reservations("host")).toEqual([]);
  expect(alice.claimId).toBeTruthy();
  reloaded.dispose();
  service.dispose();
});
