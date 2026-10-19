import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  realpath,
  stat,
  utimes,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { integrationSchema, preparationSchema, type Integration } from "../shared/arena.ts";
import type { hostContract } from "../shared/host-contract.ts";
const preparedRecord = preparationSchema.extend({ root: z.string(), synthesisPath: z.string() });
const journalSchema = z.object({
  phase: z.literal("applying"),
  prepared: preparedRecord,
  checks: integrationSchema.shape.checks,
});
const gates = new Map<string, Promise<unknown>>();
type Identity = { runId: string; round: number };

export async function command(
  cwd: string,
  argv: string[],
  signal: AbortSignal,
  options: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    acceptFailure?: boolean;
    timeout?: number;
  } = {},
) {
  const [program, ...args] = argv;
  if (!program) throw new Error("Missing command");
  const child = spawn(program, args, {
    cwd,
    env: { ...process.env, ...options.env },
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let oversized = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const abort = () => {
    kill("SIGTERM");
    killTimer ??= setTimeout(() => kill("SIGKILL"), 2000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.timeout ?? 600000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (data: Buffer) => {
    const chunk = data.toString();
    output = (output + chunk).slice(-65536);
    stdoutBytes += data.length;
    if (stdoutBytes > 8 * 1024 * 1024) {
      oversized = true;
      abort();
    } else stdout.push(data);
  });
  child.stderr.on("data", (data: Buffer) => {
    output = (output + data.toString()).slice(-65536);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  try {
    const exitCode = await new Promise<number>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => done(code ?? -1));
    });
    signal.throwIfAborted();
    if (timedOut) throw new Error(`Command timed out: ${program}`);
    if (oversized) throw new Error(`Command output exceeds 8 MiB: ${program}`);
    if (exitCode !== 0 && !options.acceptFailure)
      throw new Error(`${program} failed (${exitCode}): ${output.slice(-8000)}`);
    return { exitCode, output: output.trim(), stdout: Buffer.concat(stdout).toString("utf8") };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal.removeEventListener("abort", abort);
  }
}

export class ArenaGit {
  private readonly dataDir: string;
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }
  private path(input: Identity, suffix = ".json") {
    return join(this.dataDir, `${input.runId}-${input.round}${suffix}`);
  }
  private async exclusive<T>(input: Identity, work: () => Promise<T>): Promise<T> {
    const key = this.path(input);
    const prior = gates.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    gates.set(key, next);
    void next
      .finally(() => {
        if (gates.get(key) === next) gates.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private async read(path: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async git(path: string, args: string[], signal: AbortSignal, input?: string) {
    const result = await command(path, ["git", ...args], signal, { input });
    return args.includes("--binary") ? result.stdout : result.stdout.trim();
  }

  private async save(path: string, data: unknown) {
    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, path);
  }

  private async tree(path: string, signal: AbortSignal) {
    await mkdir(this.dataDir, { recursive: true });
    const index = join(this.dataDir, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      const sourceIndex = await this.git(
        path,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        signal,
      );
      const indexStat = await stat(sourceIndex);
      await copyFile(sourceIndex, index);
      // Preserve Git's racy-clean detection when reusing the index's cached file stats.
      await utimes(index, indexStat.atime, indexStat.mtime);
      await command(path, ["git", "add", "--all", "--", "."], signal, { env });
      return (await command(path, ["git", "write-tree"], signal, { env })).stdout.trim();
    } finally {
      await rm(index, { force: true });
    }
  }

  private async pin(path: string, tree: string, parent: string, ref: string, signal: AbortSignal) {
    const sha = await this.git(
      path,
      [
        "-c",
        "user.name=Arena",
        "-c",
        "user.email=arena@localhost",
        "commit-tree",
        tree,
        "-p",
        parent,
      ],
      signal,
      "Arena workspace snapshot\n",
    );
    await this.git(path, ["update-ref", ref, sha], signal);
    return sha;
  }

  async snapshot(input: { runId: string; path: string }, signal: AbortSignal) {
    const root = await realpath(
      await this.git(input.path, ["rev-parse", "--show-toplevel"], signal),
    );
    const ref = `refs/arena/${input.runId}/base`;
    const prior = await command(root, ["git", "rev-parse", "--verify", ref], signal, {
      acceptFailure: true,
    });
    if (prior.exitCode === 0) return { root, base: prior.stdout.trim() };
    const base = await this.pin(root, await this.tree(root, signal), "HEAD", ref, signal);
    return { root, base };
  }

  async prepare(input: z.input<typeof hostContract.prepare.input>, signal: AbortSignal) {
    return this.exclusive(input, async () => {
      const path = this.path(input, ".prepared.json");
      const prior = await this.read(path);
      if (prior !== null) {
        const prepared = preparedRecord.parse(prior);
        await this.git(
          prepared.synthesisPath,
          ["read-tree", "--reset", "-u", prepared.combinedTree],
          signal,
        );
        return preparationSchema.parse(prepared);
      }
      const root = await realpath(input.root);
      const synthesis = await realpath(input.synthesisPath);
      if (root === synthesis) throw new Error("Synthesis must use an isolated checkout");
      const common = await this.git(
        root,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      );
      const other = await this.git(
        synthesis,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        signal,
      );
      if (resolve(common) !== resolve(other))
        throw new Error("Synthesis is not a worktree of the source repository");
      const proposal = await this.snapshot({ runId: input.snapshotId, path: synthesis }, signal);
      const sourceTree = await this.tree(root, signal);
      const current = await this.pin(
        root,
        sourceTree,
        input.base,
        `refs/arena/${input.runId}/integration-${input.round}`,
        signal,
      );
      const merged = await command(
        root,
        ["git", "merge-tree", "--write-tree", "--merge-base", input.base, current, proposal.base],
        signal,
        { acceptFailure: true },
      );
      if (merged.exitCode !== 0)
        return {
          status: "conflict" as const,
          summary:
            "The combined result conflicts with newer work in your checkout. Your files were left unchanged.",
          checks: [
            {
              command: "git merge-tree",
              exitCode: merged.exitCode,
              output: merged.output.slice(-12000),
            },
          ],
        };
      const combinedTree = merged.stdout.split("\n")[0];
      if (!combinedTree || !/^[a-f0-9]{40,64}$/.test(combinedTree))
        throw new Error("Git returned no merged tree");
      const prepared = preparedRecord.parse({
        status: "prepared",
        proposalCommit: proposal.base,
        sourceTree,
        combinedTree,
        root,
        synthesisPath: synthesis,
      });
      await this.save(path, prepared);
      await this.git(synthesis, ["read-tree", "--reset", "-u", combinedTree], signal);
      return preparationSchema.parse(prepared);
    });
  }

  async receipt(input: Identity, signal: AbortSignal) {
    return this.exclusive(input, () => this.readReceipt(input, signal));
  }

  private async readReceipt(input: Identity, signal: AbortSignal): Promise<Integration | null> {
    const saved = await this.read(this.path(input));
    if (saved === null) return null;
    const completed = integrationSchema.safeParse(saved);
    if (completed.success) return completed.data;
    const journal = journalSchema.parse(saved);
    const current = await this.tree(journal.prepared.root, signal);
    const receipt: Integration =
      current === journal.prepared.combinedTree
        ? {
            status: "integrated",
            summary: "Checks passed. Arena finished applying the changes after a restart.",
            checks: journal.checks,
          }
        : {
            status: "interrupted",
            summary:
              "Applying the changes stopped partway. Review your working checkout before starting another Arena.",
            checks: journal.checks,
          };
    await this.save(this.path(input), receipt);
    return receipt;
  }

  async integrate(
    input: z.input<typeof hostContract.integrate.input>,
    signal: AbortSignal,
  ): Promise<Integration> {
    return this.exclusive(input, async () => {
      const prior = await this.readReceipt(input, signal);
      if (prior) return prior;
      const prepared = preparedRecord.parse(await this.read(this.path(input, ".prepared.json")));
      const checks = input.checks.map((check) => ({
        ...check,
        output: check.output.slice(-12000),
      }));
      if (checks.some((check) => check.exitCode !== 0))
        return {
          status: "verification-failed",
          summary: "Checks failed, so no changes were applied.",
          checks,
        };
      if ((await this.tree(prepared.synthesisPath, signal)) !== prepared.combinedTree)
        return {
          status: "verification-failed",
          summary: "The checks changed source files, so the result needs another round.",
          checks,
        };
      if ((await this.tree(prepared.root, signal)) !== prepared.sourceTree)
        return {
          status: "changed",
          summary:
            "Your checkout changed while checks ran. The next round starts from your latest files.",
          checks,
        };
      const patch = this.path(input, `.${randomUUID()}.patch`);
      try {
        await this.git(
          prepared.root,
          [
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            `--output=${patch}`,
            prepared.sourceTree,
            prepared.combinedTree,
            "--",
          ],
          signal,
        );
        if ((await stat(patch)).size > 0)
          await this.git(prepared.root, ["apply", "--check", "--whitespace=nowarn", patch], signal);
        signal.throwIfAborted();
        // Applying and recording its receipt form one non-cancellable commit point.
        await this.save(this.path(input), { phase: "applying", prepared, checks });
        const commitSignal = new AbortController().signal;
        if ((await stat(patch)).size > 0)
          await this.git(prepared.root, ["apply", "--whitespace=nowarn", patch], commitSignal);
        const receipt: Integration = {
          status: "integrated",
          summary: "Checks passed. The changes are in your working checkout, uncommitted.",
          checks,
        };
        await this.save(this.path(input), receipt);
        return receipt;
      } finally {
        await rm(patch, { force: true });
      }
    });
  }
}
