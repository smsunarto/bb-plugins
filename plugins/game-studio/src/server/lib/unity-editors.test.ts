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
