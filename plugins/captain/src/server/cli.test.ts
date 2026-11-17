import { makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { captainHost, MAC_HOST, newCaptain, SERVER_HOST, type CaptainHost } from "./test-host.ts";

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
    expect(result.stderr).toContain("warning: push level not set to input-only");
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
