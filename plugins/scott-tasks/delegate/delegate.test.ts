import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "../api";
import type { Comment, Project, Task } from "../db";
import { displayWidth } from "../shared/text-measure";
import { delegationRpcContract } from "./contract";
import { buildSeedPrompt, registerDelegation } from ".";

interface TestSource {
  hostId: string;
  isDefault: boolean;
}

function bbProject(
  name: string,
  sources: TestSource[],
  kind: "standard" | "personal" = "standard",
) {
  return {
    id: "proj_bb",
    kind,
    name,
    gitRemoteUrl: null,
    createdAt: 0,
    updatedAt: 0,
    sources: sources.map((source) => ({
      id: `src_${source.hostId}`,
      projectId: "proj_bb",
      path: `/src/${name}`,
      type: "local_path" as const,
      createdAt: 0,
      updatedAt: 0,
      ...source,
    })),
  };
}

function hostList(hosts: Record<string, "connected" | "disconnected">) {
  return Object.entries(hosts).map(([id, status]) => ({
    id,
    name: id === "host_mac" ? "Local Mac" : id,
    status,
  }));
}

/** A linked bb project whose default source is on the server's primary host. */
const PRIMARY_HOST_PROJECT_SDK = {
  projects: {
    get: async () => bbProject("Tasks plugin", [{ hostId: "host_primary", isDefault: true }]),
  },
  hosts: { list: async () => hostList({ host_primary: "connected" }) },
  system: { config: async () => ({ primaryHostId: "host_primary" }) },
};

function createTestPreset(
  store: ReturnType<typeof createStore>,
  overrides: Partial<{
    environmentKind: "project-default" | "new-worktree";
    baseBranch: string | null;
    machineId: string | null;
  }> = {},
) {
  return store.tasks.createPreset({
    name: "Test worker",
    providerId: "claude-code",
    modelId: "claude-sonnet-5",
    reasoningLevel: "high",
    serviceTier: "fast",
    permissionMode: "full",
    environmentKind: overrides.environmentKind ?? "project-default",
    baseBranch: overrides.baseBranch ?? null,
    machineId: overrides.machineId ?? null,
    instructions: "",
    builtin: false,
  });
}

describe("task delegation", () => {
  it("spawns from a preset, attaches the thread, advances status, comments, and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        ...PRIMARY_HOST_PROJECT_SDK,
        threads: {
          spawn: async () => ({ id: "thr_delegated" }),
          get: async () => makeThreadResponse({ id: "thr_delegated", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Tasks plugin",
      prefix: "TASK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Implement delegation",
      description: "Build the core agent loop.",
      status: "todo",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    const result = delegationRpcContract.delegate.output.parse(
      await harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: "Run the focused tests before reporting back.",
      }),
    );

    expect(result).toEqual({ threadId: "thr_delegated" });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_bb",
          environment: { type: "project-default" },
          providerId: "claude-code",
          model: "claude-sonnet-5",
          reasoningLevel: "high",
          serviceTier: "fast",
          permissionMode: "full",
          title: "TASK-1 · Implement delegation",
          prompt: expect.stringContaining("Run the focused tests before reporting back."),
          origin: "plugin",
          originPluginId: "tasks",
        }),
      ],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        threadId: "thr_delegated",
        presetName: "Test worker",
        title: "TASK-1 · Implement delegation",
        liveStatus: "starting",
      }),
    ]);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
    expect(store.tasks.listComments(task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Status changed to In Progress · dispatched to Test worker",
        }),
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Dispatched to Test worker",
        }),
      ]),
    );
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
      { channel: "comments:changed", payload: { taskId: task.id } },
    ]);

    await harness.dispose();
  });

  it("corrects the attached row when a delegated thread becomes active immediately", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        ...PRIMARY_HOST_PROJECT_SDK,
        threads: {
          spawn: async () => ({ id: "thr_fast" }),
          get: async () => makeThreadResponse({ id: "thr_fast", status: "active" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Fast delegation",
      prefix: "FAST",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Transition during spawn",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.get")).toEqual([[{ threadId: "thr_fast" }]]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_fast",
        liveStatus: "working",
      }),
    ]);

    await harness.dispose();
  });

  it("bounds delegated thread titles by display width", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        ...PRIMARY_HOST_PROJECT_SDK,
        threads: {
          spawn: async () => ({ id: "thr_wide_title" }),
          get: async () => makeThreadResponse({ id: "thr_wide_title", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Tasks plugin",
      prefix: "TASK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "调".repeat(100),
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    const title = `TASK-1 · ${"调".repeat(55)}`;
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([[expect.objectContaining({ title })]]);
    expect(displayWidth(title)).toBeLessThanOrEqual(120);

    await harness.dispose();
  });

  it("spawns a new worktree from the configured branch on the configured machine", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_worktree" }),
          get: async () => makeThreadResponse({ id: "thr_worktree", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Worktree delegation",
      prefix: "WT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use a fresh checkout",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "release/next",
      machineId: "host_remote",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_remote",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "release/next" },
            },
          },
        }),
      ],
    ]);
    expect(harness.sdk.callsTo("system.config")).toEqual([]);

    await harness.dispose();
  });

  it("maps a rejected worktree target to a friendly typed delegation error", async () => {
    const spawnError = Object.assign(new Error("HTTP 404: Host not found"), {
      code: "host_not_found",
      status: 404,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        hosts: {
          get: async () => {
            throw spawnError;
          },
        },
        threads: {
          spawn: async () => {
            throw spawnError;
          },
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Invalid target",
      prefix: "BAD",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Reject bad machine",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "missing-branch",
      machineId: "host_missing",
    });

    await expect(
      harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: "Could not create a worktree on host_missing from missing-branch: Host not found",
    });

    await harness.dispose();
  });

  it("fails before spawning when the task project is not linked to bb", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { spawn: async () => ({ id: "thr_never" }) } },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Unlinked",
      prefix: "UNL",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Cannot delegate yet",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await expect(
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: 'Task project "Unlinked" is not linked to a bb project',
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);

    await harness.dispose();
  });

  it("self-attaches an existing thread through taskThreadsAttach", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_existing",
            title: "𠮷".repeat(100),
            titleFallback: null,
            status: "active",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach current worker",
    });
    registerDelegation(bb, store);

    await expect(
      harness.callRpc("taskThreadsAttach", {
        taskId: task.id,
        threadId: "thr_existing",
      }),
    ).resolves.toEqual({ threadId: "thr_existing" });
    expect(harness.sdk.callsTo("threads.get")).toEqual([[{ threadId: "thr_existing" }]]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_existing",
        presetName: "Attached",
        title: "𠮷".repeat(60),
        liveStatus: "working",
      }),
    ]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await harness.dispose();
  });
});

describe("delegation to a preset without a pinned machine", () => {
  const MAC_ONLY = [{ hostId: "host_mac", isDefault: true }];

  const ALL_CONNECTED = { host_primary: "connected", host_mac: "connected" } as const;

  function setUp(
    project: ReturnType<typeof bbProject>,
    preset: Parameters<typeof createTestPreset>[1],
    {
      spawn = async () => ({ id: "thr_routed" }),
      hosts = ALL_CONNECTED,
      defaultWorktreeBaseBranch = "main",
    }: {
      spawn?: () => Promise<{ id: string }>;
      hosts?: Record<string, "connected" | "disconnected">;
      defaultWorktreeBaseBranch?: string | null;
    } = {},
  ) {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        projects: {
          get: async () => project,
          branches: async () => ({ defaultWorktreeBaseBranch }),
        },
        system: { config: async () => ({ primaryHostId: "host_primary" }) },
        hosts: {
          list: async () => hostList(hosts),
          get: async ({ hostId }: { hostId: string }) =>
            hostList(hosts).find((host) => host.id === hostId),
        },
        threads: {
          spawn,
          get: async () => makeThreadResponse({ id: "thr_routed", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const tracker = store.tasks.createProject({
      name: "Routing",
      prefix: "RTE",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({ projectId: tracker.id, title: "Route me" });
    registerDelegation(bb, store);
    const presetId = createTestPreset(store, preset).id;
    return {
      harness,
      delegate: () => harness.callRpc("delegate", { taskId: task.id, presetId }),
      spawnedEnvironments: () =>
        harness.sdk
          .callsTo("threads.spawn")
          .map(([args]) => (args as { environment: unknown }).environment),
    };
  }

  it.each([
    {
      name: "a worktree preset for a project that only lives on a Mac",
      project: bbProject("world-engine", MAC_ONLY),
      preset: { environmentKind: "new-worktree" as const },
      environment: {
        type: "host",
        hostId: "host_mac",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
    },
    {
      name: "a worktree preset with a base branch",
      project: bbProject("world-engine", MAC_ONLY),
      preset: { environmentKind: "new-worktree" as const, baseBranch: "release/next" },
      environment: {
        type: "host",
        hostId: "host_mac",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "release/next" },
        },
      },
    },
    {
      name: "a project-default preset for a project that only lives on a Mac",
      project: bbProject("world-engine", MAC_ONLY),
      preset: { environmentKind: "project-default" as const },
      environment: {
        type: "host",
        hostId: "host_mac",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
      },
    },
    {
      name: "a project-default preset for a Mac-only folder that is not a git checkout",
      project: bbProject("git", MAC_ONLY),
      preset: { environmentKind: "project-default" as const },
      sdk: { defaultWorktreeBaseBranch: null },
      environment: {
        type: "host",
        hostId: "host_mac",
        workspace: { type: "unmanaged", path: null },
      },
    },
    {
      name: "a worktree preset whose project defaults to the Mac but also lives on the server",
      project: bbProject("dotfiles", [
        { hostId: "host_primary", isDefault: false },
        { hostId: "host_mac", isDefault: true },
      ]),
      preset: { environmentKind: "new-worktree" as const },
      environment: {
        type: "host",
        hostId: "host_mac",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
    },
    {
      name: "a worktree preset whose default machine is offline but which also lives on the server",
      project: bbProject("dotfiles", [
        { hostId: "host_primary", isDefault: false },
        { hostId: "host_mac", isDefault: true },
      ]),
      preset: { environmentKind: "new-worktree" as const },
      sdk: { hosts: { host_primary: "connected", host_mac: "disconnected" } as const },
      environment: {
        type: "host",
        hostId: "host_primary",
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      },
    },
    {
      name: "a project-default preset whose project defaults to the server's machine",
      project: bbProject("bb-plugins", [
        { hostId: "host_mac", isDefault: false },
        { hostId: "host_primary", isDefault: true },
      ]),
      preset: { environmentKind: "project-default" as const },
      environment: { type: "project-default" },
    },
    {
      name: "a project-default preset for the personal project",
      project: bbProject("Personal", [], "personal"),
      preset: { environmentKind: "project-default" as const },
      environment: { type: "project-default" },
    },
  ])("spawns $name where the project lives", async ({ project, preset, sdk, environment }) => {
    const { harness, delegate, spawnedEnvironments } = setUp(project, preset, sdk);

    await expect(delegate()).resolves.toEqual({ threadId: "thr_routed" });
    expect(harness.sdk.callsTo("projects.get")).toEqual([[{ projectId: "proj_bb" }]]);
    expect(spawnedEnvironments()).toEqual([environment]);

    await harness.dispose();
  });

  it("names the project instead of spawning when it has no source on any machine", async () => {
    const { harness, delegate, spawnedEnvironments } = setUp(bbProject("world-engine", []), {
      environmentKind: "new-worktree",
    });

    await expect(delegate()).rejects.toMatchObject({
      code: "handler_error",
      message: 'bb project "world-engine" has no source folder on any machine',
    });
    expect(spawnedEnvironments()).toEqual([]);

    await harness.dispose();
  });

  it("names the project and its offline machines when no source is on a connected machine", async () => {
    const { harness, delegate, spawnedEnvironments } = setUp(
      bbProject("world-engine", MAC_ONLY),
      { environmentKind: "new-worktree" },
      { hosts: { host_primary: "connected", host_mac: "disconnected" } },
    );

    await expect(delegate()).rejects.toMatchObject({
      code: "handler_error",
      message:
        'bb project "world-engine" has no source folder on a connected machine; it lives on Local Mac',
    });
    expect(spawnedEnvironments()).toEqual([]);

    await harness.dispose();
  });

  it("names the resolved machine when it rejects the worktree", async () => {
    const { harness, delegate } = setUp(
      bbProject("world-engine", MAC_ONLY),
      { environmentKind: "project-default" },
      {
        spawn: async () => {
          throw Object.assign(new Error("HTTP 409: Host is not connected"), {
            code: "host_unavailable",
            status: 409,
          });
        },
      },
    );

    await expect(delegate()).rejects.toMatchObject({
      code: "handler_error",
      message: "Could not create a worktree on Local Mac from main: Host is not connected",
    });
    expect(harness.sdk.callsTo("projects.branches")).toEqual([
      [{ projectId: "proj_bb", hostId: "host_mac", limit: "1" }],
    ]);

    await harness.dispose();
  });

  it("names the machine when it rejects the project folder of a non-git project", async () => {
    const { harness, delegate } = setUp(
      bbProject("git", MAC_ONLY),
      { environmentKind: "project-default" },
      {
        defaultWorktreeBaseBranch: null,
        spawn: async () => {
          throw Object.assign(
            new Error(
              "HTTP 409: Workspace path is already attached to an environment in provisioning state",
            ),
            { code: "invalid_request", status: 409 },
          );
        },
      },
    );

    await expect(delegate()).rejects.toMatchObject({
      code: "handler_error",
      message:
        "Could not open the project folder on Local Mac: Workspace path is already attached to an environment in provisioning state",
    });

    await harness.dispose();
  });

  it("passes a rejected model through without blaming the machine", async () => {
    const message =
      'HTTP 400: Model "claude-sonnet-5" is not available in this thread\'s claude-code model catalog.';
    const { harness, delegate } = setUp(
      bbProject("world-engine", MAC_ONLY),
      { environmentKind: "new-worktree" },
      {
        spawn: async () => {
          throw Object.assign(new Error(message), { code: "invalid_request", status: 400 });
        },
      },
    );

    await expect(delegate()).rejects.toMatchObject({ code: "handler_error", message });

    await harness.dispose();
  });
});

describe("task thread detach", () => {
  it("detaches an attached thread through taskThreadsDetach and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: threadId === "thr_dead" ? "error" : "idle",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Respawned work",
    });
    const otherTask = store.tasks.createTask({
      projectId: project.id,
      title: "Other work",
    });
    registerDelegation(bb, store);

    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_dead",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_live",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: otherTask.id,
      threadId: "thr_dead",
    });
    harness.realtimeSignals.length = 0;

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).resolves.toEqual({ threadId: "thr_dead" });

    expect(store.tasks.listTaskThreads(task.id).map((thread) => thread.threadId)).toEqual([
      "thr_live",
    ]);
    expect(store.tasks.listTaskThreads(otherTask.id).map((thread) => thread.threadId)).toEqual([
      "thr_dead",
    ]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).rejects.toThrow(`Thread thr_dead is not attached to ${task.key}`);

    await harness.dispose();
  });
});

describe("delegation seed prompt", () => {
  it("captures task context and the complete report-back contract", () => {
    const project: Project = {
      id: "01J00000000000000000000001",
      name: "Tasks plugin",
      prefix: "TASK",
      nextTaskNumber: 4,
      color: "blue",
      folderId: null,
      linkedBbProjectId: "proj_tasks",
      createdAt: "2026-07-15T17:00:00.000Z",
    };
    const task: Task = {
      id: "01J00000000000000000000002",
      projectId: project.id,
      number: 1,
      key: "TASK-1",
      title: "Delegate work",
      description: "Implement **preset-driven** delegation.\n\nKeep the prompt useful.",
      status: "todo",
      priority: "high",
      dueDate: null,
      parentTaskId: null,
      position: 1_024,
      createdAt: "2026-07-15T17:01:00.000Z",
      updatedAt: "2026-07-15T17:01:00.000Z",
    };
    const subtask: Task = {
      ...task,
      id: "01J00000000000000000000003",
      number: 2,
      key: "TASK-2",
      title: "Add focused tests",
      status: "in_progress",
      parentTaskId: task.id,
    };
    const comments: Comment[] = [
      {
        id: "01J00000000000000000000004",
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        presetName: null,
        threadId: null,
        body: "Preserve the existing domain path.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:02:00.000Z",
      },
      {
        id: "01J00000000000000000000005",
        taskId: task.id,
        kind: "agent",
        authorName: "Worker",
        presetName: "Sonnet · high",
        threadId: "thr_prior",
        body: "The schema study is complete.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:03:00.000Z",
      },
    ];

    expect(
      buildSeedPrompt({
        task,
        project,
        subtasks: [subtask],
        attachments: [
          {
            id: "01J00000000000000000000006",
            fileName: "delegation-notes.md",
          },
        ],
        recentComments: comments,
        presetInstructions: "Prefer focused changes.",
        extraInstructions: "Run the backend gates.",
      }),
    ).toMatchInlineSnapshot(`
      "# TASK-1 · Delegate work

      ## Description

      Implement **preset-driven** delegation.

      Keep the prompt useful.

      ## Project context

      - Name: Tasks plugin
      - Linked bb project: proj_tasks

      ## Sub-tasks

      - TASK-2 · Add focused tests (in_progress)

      ## Attachments

      - delegation-notes.md · 01J00000000000000000000006
        Fetch with: bb tasks attachment get 01J00000000000000000000006 --out <path>

      ## Recent comments

      ### Sawyer · user · 2026-07-15T17:02:00.000Z

      Preserve the existing domain path.

      ### Worker · agent · 2026-07-15T17:03:00.000Z

      The schema study is complete.

      ## Report-back contract

      You are working on task TASK-1. Use the bb tasks CLI: comment substantive updates (bb tasks comment TASK-1 --body ...), attach result artifacts, set status when done (bb tasks update TASK-1 --status in_review) or explain blockage in a comment. Your thread is already attached to the task.

      ## Preset instructions

      Prefer focused changes.

      ## Additional instructions

      Run the backend gates.
      "
    `);
  });
});
