import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { captainCli } from "./cli.ts";
import type { CommandDeps } from "./commands/deps.ts";
import { parseDuration } from "./commands/routine.ts";
import {
  captainHost,
  MAC_HOST,
  newCaptain,
  queuedRow,
  SERVER_HOST,
  type CaptainHost,
} from "./test-host.ts";

const run = (host: CaptainHost, argv: string[], threadId?: string, cwd?: string) =>
  host.harness.behavior.runCli(argv, {
    ...(threadId ? { threadId } : {}),
    ...(cwd ? { cwd } : {}),
  });

const calls = (host: CaptainHost, path: string) => host.harness.inspection.sdk.callsTo(path);
const json = (stdout: string) =>
  JSON.parse(stdout) as {
    ok: boolean;
    results: Record<string, unknown>[];
    blockers: { reason: string; fix: string }[];
  };

describe("bb captain new", () => {
  test("spawns a pinned Claude Code Captain on the server's machine and sets up its Drive", async () => {
    const host = await captainHost({ presets: [{ id: "pr_impl", name: "implement" }] });

    const result = await run(host, ["new", "--name", "Plugins", "--repo", "bb-plugins"]);

    expect(result.exitCode).toBe(0);
    const [threadId, state, name] = result.stdout.trim().split(/\s{2,}/u);
    expect(threadId).toMatch(/^thr_/u);
    expect([state, name]).toEqual(["started", "Plugins"]);
    expect(calls(host, "threads.spawn")).toHaveLength(1);
    expect(calls(host, "threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "proj_captains",
      providerId: "claude-code",
      environment: {
        type: "host",
        hostId: SERVER_HOST,
        workspace: { type: "unmanaged", path: null },
      },
      pinned: true,
      permissionMode: "full",
      pluginMetadata: { captain: { name: "Plugins" } },
      prompt:
        "Start as the Plugins Captain: read CAPTAIN.md and NOTES.md, then ask me what to start.",
    });
    expect(calls(host, "projects.create")[0]?.[0]).toMatchObject({
      name: "Captains",
      source: { type: "local_path", hostId: SERVER_HOST, path: host.captainsDir },
    });
    expect(existsSync(host.captainsDir)).toBe(true);
    for (const file of ["CAPTAIN.md", "CREW.md", "NOTES.md"]) {
      expect(readFileSync(join(host.storageRoot, threadId ?? "", file), "utf8")).toBe("");
    }
    expect(host.pushes).toEqual([
      { method: "threadNotifications.set", input: { threadId, level: "input-only" } },
    ]);
    // An existing preset is matched case-insensitively and left alone.
    const created = host.tasks.calls.filter((call) => call.method === "createPreset");
    expect(created.map((call) => (call.input as { name: string }).name)).toEqual([
      "Plan",
      "Review",
    ]);
    // Crew run unattended like their Captain, so their presets skip auto mode's classifier.
    for (const call of created) {
      expect(call.input).toMatchObject({ permissionMode: "full" });
    }
    expect(host.tasks.projects).toContainEqual(
      expect.objectContaining({ prefix: "BBPLUGINS", linkedBbProjectId: "proj_plugins" }),
    );
  });

  test("a rerun with a live name converges: no second Captain, Drive files kept, new repos added", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    writeFileSync(join(host.storageRoot, captainId, "CAPTAIN.md"), "Ship on Fridays.");

    const result = await run(host, ["new", "--name", "plugins", "--repo", "rampage", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(json(result.stdout).results[0]).toMatchObject({
      id: captainId,
      ok: true,
      state: "exists",
      repos: [
        { bbProjectId: "proj_plugins", tasksProjectKey: "BBPLUGINS" },
        { bbProjectId: "proj_rampage", tasksProjectKey: "RAMPAGE" },
      ],
      presetsCreated: [],
    });
    expect(calls(host, "threads.spawn")).toHaveLength(1);
    expect(readFileSync(join(host.storageRoot, captainId, "CAPTAIN.md"), "utf8")).toBe(
      "Ship on Fridays.",
    );
  });

  test("sends the first message only after the GenUI mark and the registry entry are written", async () => {
    const host = await captainHost({ metadataDelayMs: 20 });
    const captainId = await newCaptain(host);

    expect(calls(host, "threads.spawn")[0]?.[0]).toMatchObject({ sendAt: host.now() + 60_000 });
    expect(host.metadata.get(`${captainId} genui`)).toEqual({ audience: "person" });
    expect(host.released).toEqual([{ threadId: captainId, marked: true, registered: true }]);
    expect(host.queued.get(captainId)).toEqual([]);
  });

  test("a message another plugin holds keeps its wait", async () => {
    const host = await captainHost({ pluginHold: true });

    const result = await run(host, ["new", "--name", "Plugins", "--repo", "bb-plugins"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("warning");
    expect(calls(host, "threads.queuedMessages.send")).toHaveLength(0);
    expect(host.queued.get(result.stdout.trim().split(/\s{2,}/u)[0] ?? "")).toHaveLength(1);
  });

  test("a rerun converges the mark and sends no held message", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.metadata.delete(`${captainId} genui`);
    host.queued.set(captainId, [queuedRow("qm_later", "later", { kind: "time" })]);

    await run(host, ["new", "--name", "Plugins", "--repo", "bb-plugins"]);

    expect(host.metadata.get(`${captainId} genui`)).toEqual({ audience: "person" });
    expect(host.released).toHaveLength(1);
    expect(host.queued.get(captainId)).toHaveLength(1);
  });

  test("a reload marks Captains started before the mark, and skips a deleted Captain quietly", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host, ["--name", "Plugins", "--repo", "bb-plugins"]);
    const goneId = await newCaptain(host, ["--name", "Rampage", "--repo", "rampage"]);
    host.threads.delete(goneId);
    host.metadata.clear();

    await host.reload();

    expect([...host.metadata]).toEqual([[`${captainId} genui`, { audience: "person" }]]);
    expect(host.logs().filter((entry) => entry.message.includes(goneId))).toEqual([]);
  });

  test("a refused GenUI mark is a warning, not a failure, and the first message still goes", async () => {
    const host = await captainHost({ metadataDown: true });

    const result = await run(host, ["new", "--name", "Plugins", "--repo", "bb-plugins"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/warning: thr_\w+ not marked person-facing for GenUI/u);
    expect(calls(host, "threads.queuedMessages.send")).toHaveLength(1);
  });

  test("a first message that cannot be sent now is a warning: it starts when bb sends it", async () => {
    const host = await captainHost({ queueSendDown: true });

    const result = await run(host, ["new", "--name", "Plugins", "--repo", "bb-plugins"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(
      /warning: first message of thr_\w+ not sent now; it starts when bb sends it/u,
    );
  });

  test("refuses with every blocker at once and changes nothing", async () => {
    const host = await captainHost({ tasksDown: true });

    const result = await run(host, ["new", "--name", "Plugins", "--repo", "nope", "--json"]);

    expect(result.exitCode).toBe(1);
    const body = json(result.stdout);
    expect(body.ok).toBe(false);
    expect(body.blockers.map((blocker) => blocker.fix)).toEqual([
      "bb plugin list; enable it with bb plugin enable scott-tasks",
      "bb project list",
    ]);
    expect(calls(host, "threads.spawn")).toHaveLength(0);
    expect(calls(host, "projects.create")).toHaveLength(0);
  });

  test("--prompt-file is read on the invoking machine and becomes the first message", async () => {
    const host = await captainHost();
    host.addThread({ id: "thr_user", environmentId: "env_mac" });
    writeFileSync(join(host.root, "purpose.md"), "Direct the plugins repo.");

    const result = await run(
      host,
      ["new", "--name", "Plugins", "--repo", "bb-plugins", "--prompt-file", "purpose.md"],
      "thr_user",
      host.root,
    );

    expect(result.exitCode).toBe(0);
    expect(calls(host, "files.read")[0]?.[0]).toMatchObject({
      hostId: MAC_HOST,
      path: join(host.root, "purpose.md"),
    });
    expect(calls(host, "threads.spawn")[0]?.[0]).toMatchObject({
      prompt: "Direct the plugins repo.",
    });
  });

  test("a missing push plugin is a warning, not a failure", async () => {
    const host = await captainHost({ pushDown: true });

    const result = await run(host, ["new", "--name", "Plugins", "--repo", "bb-plugins"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/warning: push level of thr_\w+ not set to input-only/u);
  });
});

describe("bb captain repo", () => {
  test("add links an unlinked Tasks project by key, and a rerun reports it exists", async () => {
    const host = await captainHost({
      tasksProjects: [{ id: "tp_ramp", name: "Rampage", prefix: "RAMP", linkedBbProjectId: null }],
    });
    const captainId = await newCaptain(host);

    const added = await run(host, ["repo", "add", "rampage", "--tasks", "ramp"], captainId);
    const again = await run(host, ["repo", "add", "rampage"], captainId);

    expect(added.exitCode).toBe(0);
    expect(added.stdout).toBe("RAMP  added  proj_rampage  rampage\n");
    expect(
      host.tasks.projects.find((project) => project.prefix === "RAMP")?.linkedBbProjectId,
    ).toBe("proj_rampage");
    expect(again.stdout).toBe("RAMP  exists  proj_rampage  rampage\n");
    expect(host.server.store.captain(captainId)?.repos.map((repo) => repo.tasksProjectKey)).toEqual(
      ["BBPLUGINS", "RAMP"],
    );
  });

  test("add creates the Tasks project when none is linked", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);

    const added = await run(host, ["repo", "add", "proj_rampage", "--json"], captainId);

    expect(json(added.stdout).results[0]).toMatchObject({
      id: "RAMPAGE",
      state: "added",
      bbProjectId: "proj_rampage",
    });
    expect(host.tasks.projects).toContainEqual(
      expect.objectContaining({ prefix: "RAMPAGE", linkedBbProjectId: "proj_rampage" }),
    );
  });

  test("add refuses a key linked to another bb project and names the fix", async () => {
    const host = await captainHost({
      tasksProjects: [
        { id: "tp_ramp", name: "Rampage", prefix: "RAMP", linkedBbProjectId: "proj_elsewhere" },
      ],
    });
    const captainId = await newCaptain(host);

    const result = await run(host, ["repo", "add", "rampage", "--tasks", "RAMP"], captainId);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bb tasks project update RAMP --link-bb-project proj_rampage");
    expect(host.server.store.captain(captainId)?.repos).toHaveLength(1);
  });

  test("remove drops a repo by its Tasks key, converges on a rerun, and keeps the last repo", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host, ["--name", "Plugins", "--repo", "bb-plugins,rampage"]);

    const removed = await run(host, ["repo", "remove", "rampage"], captainId);
    const again = await run(host, ["repo", "remove", "RAMPAGE"], captainId);
    const last = await run(host, ["repo", "remove", "bb-plugins"], captainId);

    expect(removed.stdout).toBe("RAMPAGE  removed  proj_rampage\n");
    expect(again).toMatchObject({
      exitCode: 0,
      stdout: "RAMPAGE  absent  not one of this Captain's repos\n",
    });
    expect(last.exitCode).toBe(1);
    expect(last.stderr).toContain("BBPLUGINS is this Captain's only repo");
    expect(host.server.store.captain(captainId)?.repos.map((repo) => repo.tasksProjectKey)).toEqual(
      ["BBPLUGINS"],
    );
  });

  test("refuses a caller that is not a Captain", async () => {
    const host = await captainHost();
    await newCaptain(host);
    host.addThread({ id: "thr_other" });

    const result = await run(host, ["repo", "add", "rampage", "--json"], "thr_other");

    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({
      ok: false,
      blockers: [
        {
          reason: "thr_other is not a Captain",
          fix: "run it in the Captain thread, or pass --captain <thread-id>",
        },
      ],
    });
  });
});

describe("bb captain archive", () => {
  test("releases every live crew thread with notifications off, then archives the Captain", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.addThread({ id: "thr_a", parentThreadId: captainId });
    host.addThread({ id: "thr_b", parentThreadId: captainId });

    const result = await run(host, ["archive"], captainId);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toBe(
      `thr_a  released\nthr_b  released\n${captainId}  archived  Plugins\n`,
    );
    const order = host.harness.inspection.sdk.calls
      .map((call) => call.path)
      .filter((path) => path === "threads.update" || path === "threads.archive");
    expect(order).toEqual(["threads.update", "threads.update", "threads.archive"]);
    expect(calls(host, "threads.update").map((args) => args[0])).toEqual([
      { threadId: "thr_a", parentThreadId: null, parentNotifications: "off" },
      { threadId: "thr_b", parentThreadId: null, parentNotifications: "off" },
    ]);
    expect(host.server.store.captain(captainId)?.archivedAt).toBe(1_000);

    // It is no longer a Captain: its former crew get nothing, and a rerun only confirms.
    const former = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_a", parentThreadId: captainId } }),
    );
    expect(former.instructions).toBeNull();
    const again = await run(host, ["archive", "--captain", captainId]);
    expect(again).toMatchObject({ exitCode: 0, stdout: `${captainId}  archived  Plugins\n` });
    expect(calls(host, "threads.archive")).toHaveLength(1);
  });

  test("keeps the Captain when a crew thread cannot be released", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.addThread({ id: "thr_a", parentThreadId: captainId });
    host.addThread({ id: "thr_b", parentThreadId: captainId });
    host.harness.sdk.stub("threads.update", async (args: { threadId: string }) => {
      if (args.threadId === "thr_b") throw new Error("thread is busy");
      return {};
    });

    const result = await run(host, ["archive"], captainId);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("thr_b  failed  thread is busy");
    expect(calls(host, "threads.archive")).toHaveLength(0);
    expect(host.server.registry.get(captainId)).not.toBeNull();
  });
});

describe("bb captain drive", () => {
  async function withCrew() {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.addThread({ id: "thr_crew", parentThreadId: captainId, environmentId: "env_mac" });
    return { host, captainId };
  }

  test("a crew thread writes and reads a Drive file, inline or from a file on its machine", async () => {
    const { host, captainId } = await withCrew();
    writeFileSync(join(host.root, "report.md"), "# Report\nAll green.\n");

    const inline = await run(
      host,
      ["drive", "write", "notes/plan.md", "--content", "step one"],
      "thr_crew",
    );
    const fromFile = await run(
      host,
      ["drive", "write", "reports/r1.md", "--file", "report.md"],
      "thr_crew",
      host.root,
    );
    const read = await run(host, ["drive", "read", "notes/plan.md"], "thr_crew");
    const readJson = await run(host, ["drive", "read", "reports/r1.md", "--json"], "thr_crew");

    expect(inline).toMatchObject({ exitCode: 0, stdout: "notes/plan.md  written  8 bytes\n" });
    expect(fromFile.exitCode).toBe(0);
    expect(readFileSync(join(host.storageRoot, captainId, "notes/plan.md"), "utf8")).toBe(
      "step one",
    );
    expect(read).toMatchObject({ exitCode: 0, stdout: "step one" });
    expect(json(readJson.stdout).results[0]).toMatchObject({
      id: "reports/r1.md",
      content: "# Report\nAll green.\n",
    });
  });

  test("drive read returns the whole file after a session build read only its head", async () => {
    const { host, captainId } = await withCrew();
    const big = `${"crew rule\n".repeat(20_000)}last line\n`;
    writeFileSync(join(host.storageRoot, captainId, "CREW.md"), big);
    await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_crew", parentThreadId: captainId },
      }),
    );

    const result = await run(host, ["drive", "read", "CREW.md"], "thr_crew");

    expect(result.stdout).toBe(big);
  });

  test("the Captain reads what the plugin wrote for it", async () => {
    const { host, captainId } = await withCrew();

    const result = await run(host, ["drive", "read", "CREW.md"], captainId);

    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
  });

  test("refuses every path that leaves the Drive, and writes nothing outside it", async () => {
    const { host, captainId } = await withCrew();
    const outside = join(host.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(host.storageRoot, captainId, "escape"));

    for (const path of ["../NOTES.md", "/etc/passwd", "a/../../x.md", "escape/x.md", "a\\b.md"]) {
      const result = await run(host, ["drive", "write", path, "--content", "x"], "thr_crew");
      expect(result.exitCode, path).toBe(1);
    }
    expect(existsSync(join(outside, "x.md"))).toBe(false);
    expect((await run(host, ["drive", "read", "../../etc/hostname"], "thr_crew")).exitCode).toBe(1);
  });

  test("refuses a thread that is neither the Captain nor its crew", async () => {
    const { host } = await withCrew();
    host.addThread({ id: "thr_stranger" });

    const result = await run(host, ["drive", "read", "CREW.md"], "thr_stranger");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("thr_stranger is not a Captain or one of its crew");
  });
});

describe("bb captain routine", () => {
  async function routineCli() {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    const prompt = join(host.root, "sweep.md");
    writeFileSync(prompt, "Run bb captain status --all and nudge stalled crew.");
    return { host, captainId, prompt };
  }

  test("add prints the schedule in words and the next run", async () => {
    const { host, captainId, prompt } = await routineCli();
    const args = ["routine", "add", "--name", "Sweep", "--cron", "0 9 * * 1-5"];
    const result = await run(
      host,
      [...args, "--timezone", "UTC", "--prompt-file", prompt],
      captainId,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /^r1 {2}added {2}"Sweep" {2}Every weekday at 9:00 AM \(UTC\) {2}next \w{3}, \w{3} \d+, \d+:\d\d (AM|PM) UTC\n$/u,
    );
    const listed = json((await run(host, ["routine", "list", "--json"], captainId)).stdout);
    expect(listed.results).toMatchObject([
      { id: "r1", state: "active", name: "Sweep", when: "Every weekday at 9:00 AM", enabled: true },
    ]);
  });

  test("add --in makes a one-shot; update, pause, resume, show and remove act by id or name", async () => {
    const { host, captainId, prompt } = await routineCli();
    await run(
      host,
      ["routine", "add", "--name", "Check deploy", "--in", "2h", "--prompt-file", prompt],
      captainId,
    );
    const automation = [...host.automations.rows.values()][0];
    expect(automation?.trigger).toEqual({ triggerType: "once", runAt: host.now() + 2 * 3_600_000 });

    const updated = await run(
      host,
      ["routine", "update", "check deploy", "--cron", "0 10 * * 1", "--timezone", "Europe/Berlin"],
      captainId,
    );
    expect(updated.stdout).toContain(
      'r1  updated  "Check deploy"  Every Monday at 10:00 AM (Europe/Berlin)',
    );
    expect((await run(host, ["routine", "pause", "r1"], captainId)).stdout).toMatch(
      /^r1 {2}paused/u,
    );
    expect(automation?.enabled).toBe(false);
    expect((await run(host, ["routine", "resume", "r1"], captainId)).stdout).toMatch(
      /^r1 {2}active/u,
    );

    const shown = await run(host, ["routine", "show", "r1", "--runs"], captainId);
    expect(shown.stdout).toContain("When to run: Every Monday at 10:00 AM (Europe/Berlin)");
    expect(shown.stdout).toContain("Run bb captain status --all");
    expect(shown.stdout).toContain("Runs:\nnone yet");

    expect((await run(host, ["routine", "remove", "Check deploy"], captainId)).stdout).toMatch(
      /^r1 {2}removed/u,
    );
    expect(host.automations.rows.size).toBe(0);
  });

  test("run wakes the Captain at once and records a test run", async () => {
    const { host, captainId, prompt } = await routineCli();
    await run(
      host,
      ["routine", "add", "--name", "Sweep", "--cron", "0 9 * * *", "--prompt-file", prompt],
      captainId,
    );
    // The stored script: the fired automation calls the hidden command, with no thread.
    host.automations.onRun = async (row, runId) => {
      await run(host, [
        "routine",
        "fire",
        row.execution.env?.["BB_CAPTAIN_ROUTINE_ID"] ?? "",
        "--automation",
        row.id,
        "--run",
        runId,
      ]);
    };
    const result = await run(host, ["routine", "run", "r1"], captainId);
    expect(result.stdout).toMatch(/^r1 {2}running {2}"Sweep" {2}test run arun_\d+ started/u);
    await expect
      .poll(() => host.sent.filter((send) => send.text.startsWith("[captain] routine r1")).length)
      .toBe(1);
    expect(host.server.store.routineRuns("r1")).toMatchObject([
      { trigger: "test", status: "sent" },
    ]);
  });

  test("a one-shot that ran reads done", async () => {
    const { host, captainId, prompt } = await routineCli();
    await run(
      host,
      ["routine", "add", "--name", "Once", "--in", "1m", "--prompt-file", prompt],
      captainId,
    );
    const automation = [...host.automations.rows.values()][0];
    await run(host, ["routine", "fire", "r1", "--automation", automation?.id ?? ""]);
    if (automation !== undefined) automation.enabled = false;
    expect((await run(host, ["routine", "list"], captainId)).stdout).toMatch(
      /^r1 {2}done {2}"Once" {2}Once, .* {2}ran once\n$/u,
    );
  });

  test("a stale --automation is refused by fire", async () => {
    const { host, captainId, prompt } = await routineCli();
    await run(
      host,
      ["routine", "add", "--name", "Sweep", "--cron", "0 9 * * *", "--prompt-file", prompt],
      captainId,
    );
    const result = await run(host, ["routine", "fire", "r1", "--automation", "auto_gone"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("automation auto_gone no longer schedules r1");
  });

  test("a crew thread is refused, with or without --captain, and told which Captain to ask", async () => {
    const { host, captainId } = await routineCli();
    host.addThread({ id: "thr_crew1", parentThreadId: captainId });
    for (const extra of [[], ["--captain", captainId]]) {
      const result = await run(host, ["routine", "list", ...extra], "thr_crew1");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("thr_crew1 is crew of the Plugins Captain");
      expect(result.stderr).toContain(captainId);
    }
    const fired = await run(host, ["routine", "fire", "r1", "--automation", "auto_1"], "thr_crew1");
    expect(fired.stderr).toContain("crew cannot manage routines");
  });

  test("the user's shell reaches a routine with --captain, or by id alone", async () => {
    const { host, captainId, prompt } = await routineCli();
    await run(host, [
      "routine",
      "add",
      "--name",
      "Sweep",
      "--cron",
      "0 9 * * *",
      "--prompt-file",
      prompt,
      "--captain",
      captainId,
    ]);
    expect((await run(host, ["routine", "pause", "r1"])).exitCode).toBe(0);
    expect((await run(host, ["routine", "list", "--captain", "Plugins"])).stdout).toMatch(
      /^r1 {2}paused/u,
    );
  });

  test("bad schedules are refused with the fix", async () => {
    const { host, captainId, prompt } = await routineCli();
    const add = (...extra: string[]) =>
      run(
        host,
        ["routine", "add", "--name", "Sweep", "--prompt-file", prompt, ...extra],
        captainId,
      );
    expect((await add("--cron", "*/5 * * * *")).stderr).toContain("at most every 15 minutes");
    expect((await add("--cron", "0 9 * * *", "--timezone", "Nowhere/Land")).stderr).toContain(
      "unknown time zone",
    );
    expect((await add("--in", "soon")).stderr).toContain("cannot read --in soon");
    expect((await add("--in", "1h", "--cron", "0 9 * * *")).stderr).toContain("pass one of them");
    expect((await add()).stderr).toContain("a routine needs a schedule");
  });

  test("fire is hidden from help", async () => {
    const names = (captainCli({} as CommandDeps).commands ?? []).map((command) => command.name);
    expect(names).toContain("routine-run");
    expect(names.some((name) => name.includes("fire"))).toBe(false);
    const host = await captainHost();
    const help = await run(host, ["routine", "--help"]);
    expect(`${help.stdout ?? ""}${help.stderr ?? ""}`).toContain("routine run");
    expect(`${help.stdout ?? ""}${help.stderr ?? ""}`).not.toContain("fire");
  });
});

describe("parseDuration", () => {
  test.each([
    ["1m", 60_000],
    ["90m", 5_400_000],
    ["1h30m", 5_400_000],
    ["2d", 172_800_000],
    ["", null],
    ["0m", null],
    ["2 hours", null],
  ])("%s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });
});
