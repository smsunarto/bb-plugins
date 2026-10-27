import { describe, expect, it } from "vitest";
import type { ChoiceAnswer } from "./jev";
import { DEFAULT_REASONING_LEVELS, type ReasoningLevel } from "./reasoning";
import {
  clipTask,
  describeEnvironment,
  describeMachine,
  describeModel,
  describeProject,
  route,
  uniqueOptionNames,
  type EnvironmentCandidate,
  type JevBatch,
  type Targets,
  type MachineCandidate,
  type MachineStats,
  type ModelCandidate,
  type ProjectCandidate,
} from "./router";

const GIB = 1024 ** 3;

function stats(overrides: Partial<MachineStats> = {}): MachineStats {
  return {
    platform: "linux",
    arch: "x64",
    osRelease: "6.8.0",
    cpuCount: 16,
    loadAverage1m: 1.6,
    memoryTotalBytes: 64 * GIB,
    memoryFreeBytes: 48 * GIB,
    diskTotalBytes: 1000 * GIB,
    diskFreeBytes: 600 * GIB,
    ...overrides,
  };
}

function machine(overrides: Partial<MachineCandidate> = {}): MachineCandidate {
  return {
    id: "host_devbox",
    name: "devbox",
    isServer: false,
    stats: stats(),
    runningThreads: 0,
    projectPath: null,
    environmentIds: ["git-worktree"],
    ...overrides,
  };
}

const worktree: EnvironmentCandidate = {
  id: "git-worktree",
  name: "Worktree",
  description: "Create an isolated Git worktree for your changes.",
};
const checkout: EnvironmentCandidate = {
  id: "project-checkout",
  name: "Project checkout",
  description: "Work in a project checkout on this machine.",
};
const cow: EnvironmentCandidate = { id: "btrfs-cow", name: "Btrfs Cow", description: "" };

function project(overrides: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    id: "proj_bb",
    name: "bb",
    isPersonal: false,
    gitRemoteUrl: null,
    sources: [],
    recentThreadTitles: [],
    ...overrides,
  };
}

function model(overrides: Partial<ModelCandidate> = {}): ModelCandidate {
  return {
    providerId: "claude-code",
    providerName: "Claude Code",
    model: "claude-opus-5",
    displayName: "Opus 5",
    description: "Most capable.",
    note: "",
    reasoningLevel: "medium",
    ...overrides,
  };
}

function answer(choice: string, probabilities: Record<string, number> = {}): ChoiceAnswer {
  return { choice, probabilities, confidence: 0.8, inputTokens: 100, latencyMs: 5 };
}

describe("describeMachine", () => {
  it("puts load into words Jev can compare, with the numbers alongside", () => {
    expect(describeMachine(machine({ isServer: true, projectPath: "/home/me/bb" }))).toBe(
      "Linux (x86-64). CPU load is low (10% of 16 cores). memory is mostly free (25% of 64 GB used). disk has plenty of space (600 GB free). idle, no agent threads running. this is the main BB server machine. the project is at /home/me/bb.",
    );
  });

  it("flags a loaded machine", () => {
    const text = describeMachine(
      machine({
        stats: stats({
          loadAverage1m: 15,
          memoryFreeBytes: 4 * GIB,
          diskFreeBytes: 8 * GIB,
        }),
        runningThreads: 7,
      }),
    );
    expect(text).toContain("CPU load is high");
    expect(text).toContain("memory is nearly full");
    expect(text).toContain("disk is nearly full");
    expect(text).toContain("very busy, 7 agent threads running now");
  });

  it("says a Mac can build iOS apps", () => {
    const text = describeMachine(machine({ stats: stats({ platform: "darwin", arch: "arm64" }) }));
    expect(text).toContain("macOS (Apple Silicon)");
    expect(text).toContain("iOS");
  });

  it("recognizes WSL and machines that did not report", () => {
    expect(
      describeMachine(machine({ stats: stats({ osRelease: "5.15.167-microsoft-standard-WSL2" }) })),
    ).toContain("Linux under Windows WSL");
    expect(describeMachine(machine({ stats: null, runningThreads: 1 }))).toBe(
      "Operating system and load unknown (the machine did not report in time). lightly busy, 1 agent thread running now.",
    );
  });

  it("does not invent a load for Windows", () => {
    expect(
      describeMachine(machine({ stats: stats({ platform: "win32", loadAverage1m: null }) })),
    ).toContain("16 CPU cores, load unknown");
  });
});

describe("describeProject", () => {
  it("combines the remote, folders, and recent work", () => {
    const text = describeProject(
      project({
        gitRemoteUrl: "git@github.com:get-bb/bb.git",
        sources: [{ hostId: "host_devbox", path: "/home/me/bb" }],
        recentThreadTitles: ["Fix sidebar flicker"],
      }),
      new Map([["host_devbox", "devbox"]]),
    );
    expect(text).toBe(
      'Repository github.com/get-bb/bb. Folder /home/me/bb on devbox. Recent work here: "Fix sidebar flicker".',
    );
  });

  it("describes the projectless choice", () => {
    expect(describeProject(project({ isPersonal: true }), new Map())).toContain("No repository");
  });
});

describe("describeModel", () => {
  it("leads with the user's note", () => {
    expect(describeModel(model({ note: "UI design and planning" }))).toBe(
      "UI design and planning (Most capable.)",
    );
    expect(describeModel(model({ description: "" }))).toBe("A Claude Code model.");
  });
});

describe("describeEnvironment", () => {
  it("explains the first-party environments by what they mean for the work", () => {
    expect(describeEnvironment(worktree)).toContain("isolated copy");
    expect(describeEnvironment(checkout)).toContain("shared with every other thread");
  });

  it("uses a third-party provider's own description, or its name", () => {
    expect(describeEnvironment({ id: "x", name: "Sandbox", description: "A cloud sandbox." })).toBe(
      "A cloud sandbox.",
    );
    expect(describeEnvironment({ id: "btrfs-cow", name: "Btrfs Cow", description: "" })).toBe(
      "The Btrfs Cow environment.",
    );
  });
});

describe("uniqueOptionNames", () => {
  it("keeps duplicate names apart", () => {
    const named = uniqueOptionNames(["bb", "bb", " "], (name) => name);
    expect([...named.keys()]).toEqual(["bb", "bb (2)", "unnamed"]);
  });
});

describe("clipTask", () => {
  it("keeps the head and tail of a huge prompt", () => {
    const clipped = clipTask(`START${"x".repeat(40_000)}END`);
    expect(clipped.length).toBeLessThan(13_000);
    expect(clipped.startsWith("START")).toBe(true);
    expect(clipped.endsWith("END")).toBe(true);
  });
});

describe("route", () => {
  const ios = project({ id: "proj_ios", name: "ios-app" });
  const bb = project();
  const opus = model();
  const sonnet = model({ model: "claude-sonnet-5", displayName: "Sonnet 5", note: "Simple tasks" });
  const mac = machine({
    id: "host_mac",
    name: "MacBook",
    stats: stats({ platform: "darwin", arch: "arm64" }),
  });
  const devbox = machine();
  const instructions = {
    general: "I am a solo developer.",
    projects: "iOS work goes to ios-app.",
    machines: "iOS needs the Mac.",
    models: "Sonnet for simple tasks.",
    environments: "Worktrees for code changes.",
  };
  const noInstructions = { general: "", projects: "", machines: "", models: "", environments: "" };
  const levels = [
    { level: "low" as const, description: "Fast" },
    { level: "high" as const, description: "Thorough" },
  ];

  /** A fake Jev: records each request and answers every question with `pick`. */
  function jev(
    pick: (key: string, options: string[]) => string | [string, Record<string, number>],
  ) {
    const batches: JevBatch[] = [];
    const ask = async (batch: JevBatch) => {
      batches.push(batch);
      return Object.fromEntries(
        Object.entries(batch.questions).map(([key, question]) => {
          const picked = pick(key, Object.keys(question.options));
          return [key, Array.isArray(picked) ? answer(picked[0], picked[1]) : answer(picked)];
        }),
      );
    };
    const questions = (dimension: string) =>
      batches.flatMap((batch) =>
        Object.entries(batch.questions)
          .filter(([key]) => key.startsWith(dimension))
          .map(([, question]) => question),
      );
    return { ask, batches, questions };
  }

  const everywhere = (): Targets => ({ machines: [devbox, mac], environments: [worktree] });

  it("asks everything in one request, speculatively, and keeps the answers that apply", async () => {
    const fake = jev((key, options) => {
      if (key === "project") return ["ios-app", { "ios-app": 0.9, bb: 0.1 }];
      if (key === "model") return "Opus 5 (Claude Code)";
      if (key.startsWith("machine")) return "MacBook";
      // Effort is asked once per model before the model is known.
      return key === "reasoning:0" ? "high" : "low";
    });
    const decision = await route({
      task: "Fix the deep link crash in the iOS app",
      instructions,
      projects: [bb, ios],
      models: [opus, sonnet],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: everywhere,
      reasoningFor: () => levels,
    });

    expect(fake.batches).toHaveLength(1);
    expect(Object.keys(fake.batches[0]?.questions ?? {}).sort()).toEqual([
      "machine:0", // both projects can run on the same machines, so they share one question
      "model",
      "project",
      "reasoning:0",
      "reasoning:1",
    ]);
    expect(decision.project.value.id).toBe("proj_ios");
    expect(decision.project.alternatives).toEqual([{ label: "bb", probability: 0.1 }]);
    expect(decision.model.value.model).toBe("claude-opus-5");
    expect(decision.reasoning.value).toBe("high"); // Opus's answer, not Sonnet's
    expect(decision.machine.value.id).toBe("host_mac");
    expect(decision.environment).toMatchObject({ label: "Worktree", source: "only-option" });

    // General rules ride in the shared state; each question carries its own.
    expect(fake.batches[0]?.state).toEqual({
      task: "Fix the deep link crash in the iOS app",
      routing_rules_from_the_user: "I am a solo developer.",
    });
    expect(fake.questions("project")[0]?.instructions).toContain("iOS work goes to ios-app.");
    expect(fake.questions("machine")[0]?.instructions).toContain("iOS needs the Mac.");
    expect(fake.questions("reasoning")[0]?.instructions).toContain(
      "The task will run on the model Opus 5 (Claude Code).",
    );
    expect(fake.questions("reasoning")[1]?.instructions).toContain("Sonnet 5 (Claude Code)");
    expect(fake.questions("model")[0]?.instructions).not.toContain("iOS needs the Mac.");
  });

  it("asks a separate machine question for projects that live on different machines", async () => {
    const fake = jev((key, options) =>
      key === "project"
        ? "ios-app"
        : key.startsWith("machine")
          ? (options.at(-1) ?? "")
          : (options[0] ?? ""),
    );
    const third = machine({ id: "host_air", name: "MacBook Air" });
    const decision = await route({
      task: "Fix the deep link crash",
      instructions: noInstructions,
      projects: [bb, ios],
      models: [opus],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: (candidate) =>
        candidate.id === "proj_ios"
          ? { machines: [mac, third], environments: [worktree] }
          : { machines: [devbox, mac], environments: [worktree] },
      reasoningFor: () => [],
    });
    expect(fake.batches).toHaveLength(1);
    expect(fake.questions("machine").map((question) => Object.keys(question.options))).toEqual([
      ["devbox", "MacBook"],
      ["MacBook", "MacBook Air"],
    ]);
    // The answer kept is the one for the machines that hold the chosen project.
    expect(decision.machine.value.id).toBe("host_air");
  });

  it("skips Jev where there is nothing to choose", async () => {
    const fake = jev(() => "unused");
    const decision = await route({
      task: "hello",
      instructions: noInstructions,
      projects: [bb],
      models: [opus],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: () => ({ machines: [devbox], environments: [worktree] }),
      reasoningFor: () => [],
    });
    expect(fake.batches).toEqual([]);
    expect(decision.project.source).toBe("only-option");
    expect(decision.machine.value.id).toBe("host_devbox");
    // A model with no reasoning choice keeps the rotation's fallback level.
    expect(decision.reasoning.value).toBe("medium");
  });

  it("omits the rules block when the user wrote none", async () => {
    const fake = jev(() => "bb");
    await route({
      task: "hello",
      instructions: { ...noInstructions, general: " " },
      projects: [bb, ios],
      models: [opus],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: () => ({ machines: [devbox], environments: [worktree] }),
      reasoningFor: () => [],
    });
    expect(fake.batches[0]?.state).toEqual({ task: "hello" });
    expect(fake.questions("project")[0]?.instructions).not.toContain("Routing rules");
  });

  it("offers each machine only the environments it can create, and names the machine", async () => {
    const fake = jev((key, options) => {
      if (key.startsWith("machine")) return "omarchy";
      return options.includes("Btrfs Cow")
        ? ["Btrfs Cow", { "Btrfs Cow": 0.7, Worktree: 0.3 }]
        : (options[0] ?? "");
    });
    const omarchy = machine({
      id: "host_omarchy",
      name: "omarchy",
      environmentIds: ["git-worktree", "btrfs-cow"],
    });
    const decision = await route({
      task: "Refactor the router",
      instructions,
      projects: [bb],
      models: [opus],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: () => ({
        machines: [machine({ environmentIds: ["git-worktree", "project-checkout"] }), omarchy],
        environments: [worktree, checkout, cow],
      }),
      reasoningFor: () => [],
    });

    expect(fake.batches).toHaveLength(1);
    // The machine question says what each machine can create.
    const machines = fake.questions("machine")[0]?.options ?? {};
    expect(machines.devbox).toContain(
      "the environments available here are Worktree, Project checkout",
    );
    expect(machines.omarchy).toContain("the environments available here are Worktree, Btrfs Cow");
    // One environment question per machine, speculatively, each limited to that machine.
    expect(fake.questions("environment").map((question) => Object.keys(question.options))).toEqual([
      ["Worktree", "Project checkout"],
      ["Worktree", "Btrfs Cow"],
    ]);
    const forOmarchy = fake.questions("environment")[1];
    expect(forOmarchy?.instructions).toContain("The task will run on the machine omarchy:");
    expect(forOmarchy?.instructions).toContain("Worktrees for code changes.");
    expect(decision.machine.value.id).toBe("host_omarchy");
    expect(decision.environment).toMatchObject({
      label: "Btrfs Cow",
      source: "jev",
      probability: 0.7,
    });
  });

  it("skips the environment question when the chosen machine can create only one", async () => {
    const fake = jev((key, options) =>
      key.startsWith("machine") ? "MacBook" : (options[0] ?? ""),
    );
    const decision = await route({
      task: "Refactor the router",
      instructions: noInstructions,
      projects: [bb],
      models: [opus],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: () => ({
        machines: [
          machine({ environmentIds: ["git-worktree", "project-checkout"] }),
          machine({ id: "host_mac", name: "MacBook", environmentIds: ["project-checkout"] }),
        ],
        environments: [worktree, checkout],
      }),
      reasoningFor: () => [],
    });
    expect(decision.environment).toMatchObject({
      label: "Project checkout",
      source: "only-option",
    });
  });

  it("asks the rarest questions in a follow-up when there are too many to send at once", async () => {
    const fake = jev((key, options) => (key === "project" ? "p59" : (options.at(-1) ?? "")));
    // Sixty projects, each on its own pair of machines: sixty distinct machine questions.
    const projects = Array.from({ length: 60 }, (_, index) =>
      project({ id: `p${index}`, name: `p${index}` }),
    );
    const decision = await route({
      task: "hello",
      instructions: noInstructions,
      projects,
      models: [opus],
      hostNames: new Map(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: fake.ask,
      targetsFor: (candidate) => ({
        machines: [
          machine({ id: `${candidate.id}-a`, name: `${candidate.id}-a` }),
          machine({ id: `${candidate.id}-b`, name: `${candidate.id}-b` }),
        ],
        environments: [worktree],
      }),
      reasoningFor: () => [],
    });
    expect(fake.batches).toHaveLength(2);
    expect(Object.keys(fake.batches[0]?.questions ?? {}).length).toBeLessThanOrEqual(48);
    expect(Object.keys(fake.batches[1]?.questions ?? {})).toHaveLength(1);
    expect(decision.machine.value.id).toBe("p59-b");
  });

  it("only ever uses the effort levels the user allows", async () => {
    const supported = [
      { level: "high" as const, description: "" },
      { level: "max" as const, description: "" },
      { level: "ultracode" as const, description: "" },
    ];
    const run = async (reasoningLevels: readonly ReasoningLevel[], offered: typeof supported) => {
      const fake = jev((_key, options) => options.at(-1) ?? "");
      const decision = await route({
        task: "Rework the whole app",
        instructions: noInstructions,
        projects: [bb],
        models: [model({ reasoningLevel: "ultracode" })],
        hostNames: new Map(),
        reasoningLevels,
        ask: fake.ask,
        targetsFor: () => ({ machines: [devbox], environments: [worktree] }),
        reasoningFor: () => offered,
      });
      return {
        options: Object.keys(fake.questions("reasoning")[0]?.options ?? {}),
        picked: decision.reasoning.value,
      };
    };

    // By default the special run modes are not offered, even to a row set to one.
    expect(await run(DEFAULT_REASONING_LEVELS, supported)).toEqual({
      options: ["high", "max"],
      picked: "max",
    });
    // A user who never wants max or ultracode gets neither, whatever the model supports.
    expect(await run(["low", "medium", "high"], supported)).toEqual({
      options: [],
      picked: "high",
    });
    expect((await run(["low", "medium", "high"], supported.slice(1))).picked).toBe("medium");
    // Opting in makes it available.
    expect((await run(["high", "ultracode"], supported)).options).toEqual(["high", "ultracode"]);
  });

  it("fails clearly when no machine qualifies or the rotation is empty", async () => {
    const base = {
      task: "hello",
      instructions: noInstructions,
      projects: [bb],
      hostNames: new Map<string, string>(),
      reasoningLevels: DEFAULT_REASONING_LEVELS,
      ask: jev(() => "unused").ask,
      targetsFor: () => ({ machines: [], environments: [] }),
      reasoningFor: () => [],
    };
    await expect(route({ ...base, models: [opus] })).rejects.toThrow(
      "No connected machine can run Opus 5 (Claude Code) in bb.",
    );
    await expect(route({ ...base, models: [] })).rejects.toThrow("Add at least one model");
  });
});
