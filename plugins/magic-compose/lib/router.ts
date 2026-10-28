import { instructionFiles } from "@bb-plugins/instructions";
const files = instructionFiles(import.meta.url);
// The routing decision: turn a prompt plus candidate projects, models, and
// machines into Jev questions. Pure logic; server.ts supplies the data and the
// Jev client.
//
// Jev answers many questions about one state in a single request, as fast as
// it answers one. So this follows TypeSafe's speculative fan-out pattern: every
// question that might matter goes out together, including ones that depend on
// an answer not known yet ("which effort, if it runs on Fable?", "which machine,
// if it lands in a project these five machines hold?"), and code keeps the
// answers that turned out to apply. One round trip instead of three.
//
// Jev is weak at arithmetic and numeric comparison. So everything here is
// phrased in words ("CPU load is low") with the numbers alongside, and code
// does the filtering that needs exact facts (which machines hold the project,
// which run the model, which environments a machine can create).
import type { ChoiceAnswer, ChoiceQuestion, JevState } from "./jev";
import type { ReasoningLevel } from "./reasoning";

export { REASONING_LEVELS, type ReasoningLevel } from "./reasoning";

export interface ProjectCandidate {
  id: string;
  name: string;
  /** BB's "no project" personal project. */
  isPersonal: boolean;
  gitRemoteUrl: string | null;
  sources: { hostId: string; path: string }[];
  recentThreadTitles: string[];
}

export interface MachineStats {
  platform: string;
  arch: string;
  osRelease: string;
  cpuCount: number;
  /** Null where the OS has no load average (Windows). */
  loadAverage1m: number | null;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
}

export interface MachineCandidate {
  id: string;
  name: string;
  isServer: boolean;
  /** Null when the machine did not answer the stats probe in time. */
  stats: MachineStats | null;
  runningThreads: number;
  /** Where the chosen project lives on this machine, when it does. */
  projectPath: string | null;
  /** The offered environments this machine can create for the chosen project. */
  environmentIds: string[];
}

export interface EnvironmentCandidate {
  /** Environment provider id, such as `git-worktree`. */
  id: string;
  name: string;
  /** The provider's own description, when it has one. */
  description: string;
}

export interface RotationEntry {
  providerId: string;
  model: string;
  /** The user's "when to use this" note. */
  note: string;
  /** Used when the model has no reasoning levels to choose between. */
  reasoningLevel: ReasoningLevel;
}

export interface ModelCandidate extends RotationEntry {
  providerName: string;
  displayName: string;
  /** The provider catalog's own description of the model. */
  description: string;
}

export interface ReasoningCandidate {
  level: ReasoningLevel;
  description: string;
}

export interface Instructions {
  general: string;
  projects: string;
  machines: string;
  models: string;
  environments: string;
}

export type RouteDimension = "project" | "model" | "machine" | "reasoning" | "environment";

/** One request to Jev: a shared state, and every question to answer about it. */
export interface JevBatch {
  state: JevState;
  /** Keyed by an id that starts with the question's dimension, such as `machine:0`. */
  questions: Record<string, ChoiceQuestion>;
}

export interface Pick<T> {
  value: T;
  /** The option name Jev saw. */
  label: string;
  /**
   * `only-option` means no Jev call was needed. `fallback` means none of the
   * user's preferred options could be used, so a backup was taken instead.
   */
  source: "jev" | "only-option" | "fallback";
  probability: number | null;
  confidence: number | null;
  /** Runner-up options, best first. */
  alternatives: { label: string; probability: number }[];
  latencyMs: number;
  inputTokens: number | null;
}

export interface RouteDecision {
  project: Pick<ProjectCandidate>;
  model: Pick<ModelCandidate>;
  machine: Pick<MachineCandidate>;
  reasoning: Pick<ReasoningLevel>;
  environment: Pick<EnvironmentCandidate>;
  latencyMs: number;
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/** Where a project could run with a model: facts worked out by code, not by Jev. */
export interface Targets {
  /** Machines that hold the project and can run the model. */
  machines: MachineCandidate[];
  /** The environments those machines can create, in the user's order of preference. */
  environments: EnvironmentCandidate[];
}

export interface RouteArgs {
  task: string;
  instructions: Instructions;
  projects: ProjectCandidate[];
  models: ModelCandidate[];
  /** Machine id → name, for describing where each project lives. */
  hostNames: ReadonlyMap<string, string>;
  /** Answer every question in the batch. Called once, and again only for stragglers. */
  ask(batch: JevBatch): Promise<Record<string, ChoiceAnswer>>;
  /**
   * Synchronous, because it is consulted for every project and model before
   * Jev has chosen either.
   */
  targetsFor(project: ProjectCandidate, model: ModelCandidate): Targets;
  reasoningFor(model: ModelCandidate): ReasoningCandidate[];
  /** The effort levels the user lets Magic Compose pick. Nothing outside it is ever used. */
  reasoningLevels: readonly ReasoningLevel[];
}

/** Beyond this many speculative questions, the rarer ones wait for a follow-up request. */
const MAX_SPECULATIVE_QUESTIONS = 48;

const MAX_TASK_HEAD_CHARS = 9_000;
const MAX_TASK_TAIL_CHARS = 3_000;
const MAX_OPTION_NAME_CHARS = 80;

const GIB = 1024 ** 3;

/** Keep the start and end of a very long prompt; the middle is usually pasted material. */
export function clipTask(task: string): string {
  const text = task.trim();
  if (text.length <= MAX_TASK_HEAD_CHARS + MAX_TASK_TAIL_CHARS) return text;
  return `${text.slice(0, MAX_TASK_HEAD_CHARS)}\n\n[… middle of the prompt omitted …]\n\n${text.slice(-MAX_TASK_TAIL_CHARS)}`;
}

/** Give every item a distinct, readable option name. */
export function uniqueOptionNames<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
): Map<string, T> {
  const named = new Map<string, T>();
  for (const item of items) {
    const base =
      nameOf(item).replace(/\s+/gu, " ").trim().slice(0, MAX_OPTION_NAME_CHARS) || "unnamed";
    let name = base;
    for (let suffix = 2; named.has(name); suffix++) name = `${base} (${suffix})`;
    named.set(name, item);
  }
  return named;
}

function shortRemote(url: string): string {
  return url
    .replace(/^[a-z+]+:\/\//u, "")
    .replace(/^git@/u, "")
    .replace(/\.git$/u, "")
    .replace(":", "/");
}

export function describeProject(
  project: ProjectCandidate,
  hostNames: ReadonlyMap<string, string>,
): string {
  if (project.isPersonal) {
    return "No repository. For general questions, research, writing, or tasks that do not belong to any listed project.";
  }
  const parts: string[] = [];
  if (project.gitRemoteUrl !== null) {
    parts.push(`Repository ${shortRemote(project.gitRemoteUrl)}.`);
  }
  const folders = project.sources
    .slice(0, 3)
    .map((source) => `${source.path} on ${hostNames.get(source.hostId) ?? "an offline machine"}`);
  if (folders.length > 0) parts.push(`Folder ${folders.join("; ")}.`);
  if (project.recentThreadTitles.length > 0) {
    const titles = project.recentThreadTitles.map((title) => `"${title}"`).join(", ");
    parts.push(`Recent work here: ${titles}.`);
  }
  return parts.join(" ") || "A project with no further details.";
}

export function osLabel(stats: MachineStats): string {
  const arch = stats.arch === "arm64" ? "ARM64" : stats.arch === "x64" ? "x86-64" : stats.arch;
  switch (stats.platform) {
    case "darwin":
      return `macOS (${stats.arch === "arm64" ? "Apple Silicon" : "Intel"}) — a Mac, able to build iOS and macOS apps with Xcode`;
    case "linux":
      return /microsoft|wsl/iu.test(stats.osRelease)
        ? `Linux under Windows WSL (${arch})`
        : `Linux (${arch})`;
    case "win32":
      return `Windows (${arch})`;
    default:
      return `${stats.platform} (${arch})`;
  }
}

function describeCpu(stats: MachineStats): string {
  if (stats.loadAverage1m === null || stats.cpuCount <= 0) {
    return `${stats.cpuCount} CPU cores, load unknown`;
  }
  const ratio = stats.loadAverage1m / stats.cpuCount;
  const level = ratio < 0.35 ? "low" : ratio < 0.8 ? "moderate" : "high";
  return `CPU load is ${level} (${Math.round(ratio * 100)}% of ${stats.cpuCount} cores)`;
}

function describeMemory(stats: MachineStats): string {
  if (stats.memoryTotalBytes <= 0) return "memory unknown";
  const used = 1 - stats.memoryFreeBytes / stats.memoryTotalBytes;
  const level = used < 0.6 ? "mostly free" : used < 0.85 ? "moderately used" : "nearly full";
  return `memory is ${level} (${Math.round(used * 100)}% of ${Math.round(stats.memoryTotalBytes / GIB)} GB used)`;
}

function describeDisk(stats: MachineStats): string {
  if (stats.diskFreeBytes === null || stats.diskTotalBytes === null || stats.diskTotalBytes <= 0) {
    return "disk space unknown";
  }
  const freeGb = stats.diskFreeBytes / GIB;
  const freeRatio = stats.diskFreeBytes / stats.diskTotalBytes;
  const level =
    freeGb < 10 || freeRatio < 0.05
      ? "nearly full"
      : freeRatio < 0.15
        ? "getting low"
        : "has plenty of space";
  return `disk ${level === "has plenty of space" ? level : `is ${level}`} (${Math.round(freeGb)} GB free)`;
}

function describeThreads(count: number): string {
  if (count === 0) return "idle, no agent threads running";
  const level = count <= 2 ? "lightly busy" : count <= 5 ? "busy" : "very busy";
  return `${level}, ${count} agent thread${count === 1 ? "" : "s"} running now`;
}

/**
 * `environments` names the environments on offer, so the description can say
 * which of them this machine is able to create. Leave it out when there is no
 * choice of environment to make.
 */
export function describeMachine(
  machine: MachineCandidate,
  environments: readonly EnvironmentCandidate[] = [],
): string {
  const parts: string[] = [];
  if (machine.stats === null) {
    parts.push("Operating system and load unknown (the machine did not report in time)");
  } else {
    parts.push(
      osLabel(machine.stats),
      describeCpu(machine.stats),
      describeMemory(machine.stats),
      describeDisk(machine.stats),
    );
  }
  parts.push(describeThreads(machine.runningThreads));
  if (machine.isServer) parts.push("this is the main BB server machine");
  if (machine.projectPath !== null) parts.push(`the project is at ${machine.projectPath}`);
  const creatable = environments
    .filter((environment) => machine.environmentIds.includes(environment.id))
    .map((environment) => environment.name);
  if (environments.length > 1 && creatable.length > 0) {
    parts.push(`the environments available here are ${creatable.join(", ")}`);
  }
  return `${parts.join(". ")}.`;
}

// What the first-party environments mean for the work, which their own
// one-line descriptions leave out.
const ENVIRONMENT_HINTS: Record<string, string> = {
  "git-worktree":
    "A fresh, isolated copy of the repository on its own branch. Best for code changes, so they cannot disturb other work in progress.",
  "project-checkout":
    "The project's main folder, shared with every other thread working there. Best for questions, reading code, and running things; risky for larger changes.",
};

export function describeEnvironment(environment: EnvironmentCandidate): string {
  const hint = ENVIRONMENT_HINTS[environment.id];
  const description = environment.description.trim();
  if (hint !== undefined) return hint;
  return description || `The ${environment.name} environment.`;
}

export function describeModel(model: ModelCandidate): string {
  const note = model.note.trim();
  const description = model.description.trim();
  if (note !== "" && description !== "") return `${note} (${description})`;
  return note || description || `A ${model.providerName} model.`;
}

/** A question's instructions: what to decide, what is already known, and the user's rules for it. */
function instructionsFor(ask: string, known: string[], rules: string): string {
  const trimmed = rules.trim();
  return [ask, ...known, trimmed === "" ? "" : `Routing rules from the user:\n${trimmed}`]
    .filter((part) => part !== "")
    .join("\n\n");
}

function reasoningPick(level: ReasoningLevel): Pick<ReasoningLevel> {
  return {
    value: level,
    label: level,
    source: "only-option",
    probability: null,
    confidence: null,
    alternatives: [],
    latencyMs: 0,
    inputTokens: null,
  };
}

interface Planned<T> {
  key: string;
  dimension: RouteDimension;
  named: Map<string, T>;
  question: ChoiceQuestion;
}

function planned<T>(
  key: string,
  dimension: RouteDimension,
  named: Map<string, T>,
  describe: (item: T) => string,
  instructions: string,
): Planned<T> {
  const options: Record<string, string> = {};
  for (const [name, item] of named) options[name] = describe(item);
  return { key, dimension, named, question: { instructions, options } };
}

/** Collects questions, sends them in as few requests as possible, and remembers the answers. */
class Fanout {
  private readonly pending = new Map<string, ChoiceQuestion>();
  private readonly answers = new Map<string, ChoiceAnswer>();

  constructor(
    private readonly state: JevState,
    private readonly ask: RouteArgs["ask"],
  ) {}

  get size(): number {
    return this.pending.size;
  }

  /** Queue a question, unless it is already answered or there is nothing to choose between. */
  add(plan: Planned<unknown>): void {
    if (plan.named.size < 2 || this.answers.has(plan.key)) return;
    this.pending.set(plan.key, plan.question);
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const questions = Object.fromEntries(this.pending);
    this.pending.clear();
    const answers = await this.ask({ state: this.state, questions });
    for (const [key, answer] of Object.entries(answers)) this.answers.set(key, answer);
  }

  /** The pick for a planned question, asking for it now if it was not part of the fan-out. */
  async resolve<T>(plan: Planned<T>): Promise<Pick<T>> {
    const [only] = plan.named.size === 1 ? [...plan.named.entries()] : [];
    if (only !== undefined) {
      return {
        value: only[1],
        label: only[0],
        source: "only-option",
        probability: null,
        confidence: null,
        alternatives: [],
        latencyMs: 0,
        inputTokens: null,
      };
    }
    if (!this.answers.has(plan.key)) {
      this.add(plan);
      await this.flush();
    }
    const answer = this.answers.get(plan.key);
    const value = answer === undefined ? undefined : plan.named.get(answer.choice);
    if (answer === undefined || value === undefined) {
      throw new RouteError(`Jev did not pick a ${plan.dimension}.`);
    }
    return {
      value,
      label: answer.choice,
      source: "jev",
      probability: answer.probabilities[answer.choice] ?? null,
      confidence: answer.confidence,
      alternatives: Object.entries(answer.probabilities)
        .filter(([label]) => label !== answer.choice)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([label, probability]) => ({ label, probability })),
      latencyMs: answer.latencyMs,
      inputTokens: answer.inputTokens,
    };
  }
}

/** Decide where a prompt should run, in one request to Jev whenever possible. */
export async function route(args: RouteArgs): Promise<RouteDecision> {
  const startedAt = Date.now();
  if (args.task.trim() === "") throw new RouteError("There is no prompt to route.");
  if (args.projects.length === 0) throw new RouteError("There are no projects to choose from.");
  if (args.models.length === 0) {
    throw new RouteError("Add at least one model to the rotation in Magic Compose settings.");
  }

  const general = args.instructions.general.trim();
  const fanout = new Fanout(
    {
      task: clipTask(args.task),
      ...(general === "" ? {} : { routing_rules_from_the_user: general }),
    },
    args.ask,
  );
  const allowedLevels = new Set(args.reasoningLevels);

  const projectPlan = planned(
    "project",
    "project",
    uniqueOptionNames(args.projects, (candidate) =>
      candidate.isPersonal ? "No project" : candidate.name,
    ),
    (candidate) => describeProject(candidate, args.hostNames),
    instructionsFor(files.read("choose-project"), [], args.instructions.projects),
  );

  const modelNames = uniqueOptionNames(
    args.models,
    (candidate) => `${candidate.displayName} (${candidate.providerName})`,
  );
  const modelLabels = new Map([...modelNames].map(([label, candidate]) => [candidate, label]));
  const modelPlan = planned(
    "model",
    "model",
    modelNames,
    describeModel,
    instructionsFor(files.read("choose-model"), [], args.instructions.models),
  );

  // Asked once per model: the levels on offer and the right default both depend on it.
  const reasoningPlan = (model: ModelCandidate) => {
    const offered = args.reasoningFor(model).filter((level) => allowedLevels.has(level.level));
    return planned(
      `reasoning:${args.models.indexOf(model)}`,
      "reasoning",
      new Map(offered.map((level) => [level.level as string, level])),
      (level) => level.description,
      instructionsFor(
        files.read("choose-effort"),
        [`The task will run on the model ${modelLabels.get(model) ?? model.displayName}.`],
        args.instructions.models,
      ),
    );
  };

  // Many projects share the same machines and environments, so they share one
  // machine question. The key is what Jev would see: who is on offer, and what
  // each can create.
  const targetsCache = new Map<string, Targets>();
  const targetsOf = (project: ProjectCandidate, model: ModelCandidate) => {
    const cacheKey = `${project.id}\u0000${model.providerId}`;
    let targets = targetsCache.get(cacheKey);
    if (targets === undefined) {
      targets = args.targetsFor(project, model);
      targetsCache.set(cacheKey, targets);
    }
    return targets;
  };
  const groupIds = new Map<string, number>();
  const groupId = (signature: string) => {
    let id = groupIds.get(signature);
    if (id === undefined) {
      id = groupIds.size;
      groupIds.set(signature, id);
    }
    return id;
  };
  const environmentIdsOf = (targets: Targets) => targets.environments.map((entry) => entry.id);

  const machinePlan = (targets: Targets) => {
    const signature = `m|${environmentIdsOf(targets).join(",")}|${targets.machines
      .map((machine) => `${machine.id}:${machine.environmentIds.join(",")}`)
      .join("|")}`;
    return planned(
      `machine:${groupId(signature)}`,
      "machine",
      uniqueOptionNames(targets.machines, (candidate) => candidate.name),
      // The folder differs between the projects sharing this question.
      (candidate) => describeMachine({ ...candidate, projectPath: null }, targets.environments),
      instructionsFor(files.read("choose-machine"), [], args.instructions.machines),
    );
  };

  // Only some environments exist on some machines, so the question names the
  // machine and offers only what that machine can create.
  const environmentPlan = (machine: MachineCandidate, targets: Targets) => {
    const creatable = targets.environments.filter((candidate) =>
      machine.environmentIds.includes(candidate.id),
    );
    const signature = `e|${machine.id}|${creatable.map((entry) => entry.id).join(",")}`;
    return planned(
      `environment:${groupId(signature)}`,
      "environment",
      uniqueOptionNames(creatable, (candidate) => candidate.name),
      describeEnvironment,
      instructionsFor(
        files.read("choose-environment"),
        [
          `The task will run on the machine ${machine.name}: ${describeMachine({ ...machine, projectPath: null })}`,
        ],
        args.instructions.environments,
      ),
    );
  };

  // Fan out: everything that could matter, the widely shared questions first.
  fanout.add(projectPlan);
  fanout.add(modelPlan);
  for (const model of args.models) fanout.add(reasoningPlan(model));
  const speculative = new Map<string, { plan: Planned<unknown>; uses: number }>();
  for (const project of args.projects) {
    for (const model of args.models) {
      const targets = targetsOf(project, model);
      const plans: Planned<unknown>[] = [
        machinePlan(targets),
        ...targets.machines.map((machine) => environmentPlan(machine, targets)),
      ];
      for (const plan of plans) {
        const entry = speculative.get(plan.key);
        if (entry === undefined) speculative.set(plan.key, { plan, uses: 1 });
        else entry.uses += 1;
      }
    }
  }
  for (const { plan } of [...speculative.values()].sort((a, b) => b.uses - a.uses)) {
    if (fanout.size >= MAX_SPECULATIVE_QUESTIONS) break;
    fanout.add(plan);
  }
  await fanout.flush();

  // Keep the answers that apply.
  const project = await fanout.resolve(projectPlan);
  const model = await fanout.resolve(modelPlan);

  const levels = reasoningPlan(model.value);
  let reasoning: Pick<ReasoningLevel>;
  if (levels.named.size === 0) {
    // Nothing to choose between: the rotation row's own level, unless the user
    // has ruled that out too.
    const fallback = model.value.reasoningLevel;
    reasoning = reasoningPick(
      allowedLevels.has(fallback)
        ? fallback
        : allowedLevels.has("medium")
          ? "medium"
          : (args.reasoningLevels[0] ?? fallback),
    );
  } else {
    const picked = await fanout.resolve(levels);
    reasoning = { ...picked, value: picked.value.level };
  }

  const targets = targetsOf(project.value, model.value);
  if (targets.machines.length === 0 || targets.environments.length === 0) {
    throw new RouteError(`No connected machine can run ${model.label} in ${project.label}.`);
  }
  const machine = await fanout.resolve(machinePlan(targets));
  const environments = environmentPlan(machine.value, targets);
  if (environments.named.size === 0) {
    throw new RouteError(`${machine.label} cannot create a workspace for ${project.label}.`);
  }
  const environment = await fanout.resolve(environments);

  return { project, model, machine, reasoning, environment, latencyMs: Date.now() - startedAt };
}
