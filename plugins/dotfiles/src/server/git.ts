import type { Context } from "@bb-kit/core/plugin";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import type { TaskResult } from "../shared/domain.ts";
import { dotfilesHostContract, type RepoInspection } from "../shared/host-contract.ts";

/** The host kills a task at 300 s. The extra 10 s carries its output back. */
const taskTimeoutMs = 310_000;

/** The checkout a call acts on: one machine, and the repo path as configured. */
export interface Target {
  readonly hostId: string;
  readonly hostName: string;
  readonly connected: boolean;
  /** As configured. `~` expands on the target machine. */
  readonly repoPath: string;
}

/** A target after the host read it. `repoPath` is now absolute. */
export type Repo = Target & RepoInspection;

export interface DotfilesHosts {
  /** The stored pick, else the bb server's own machine. */
  readonly selectedHostId: string | null;
  readonly hosts: { id: string; name: string; connected: boolean }[];
}

/** Everything the rpc and command handlers consume — the DI seam for tests. */
export interface DotfilesGit {
  hosts(): Promise<DotfilesHosts>;
  selectHost(hostId: string): Promise<void>;
  /** `hostId` when given, else the panel's machine, else the bb server's own. */
  target(hostId: string | undefined): Promise<Target>;
  /** The machine an agent's thread runs on, when the thread has an environment. */
  threadHostId(threadId: string): Promise<string | undefined>;
  inspect(target: Target): Promise<Repo>;
  readFile(repo: Repo, path: string): Promise<{ content: string; sha256: string }>;
  readHeadFile(repo: Repo, path: string): Promise<string | null>;
  writeFile(
    repo: Repo,
    path: string,
    content: string,
    expectedSha256: string | undefined,
  ): Promise<{ outcome: "written"; sha256: string } | { outcome: "conflict" }>;
  run(target: Target, command: string): Promise<TaskResult>;
  removeSkill(repo: Repo, name: string): Promise<TaskResult>;
}

/** The `ctx` every rpc and command handler declares: the host plus `git`. */
export type GitContext = Context<{ git: DotfilesGit }>;

export type DotfilesHostClient = Pick<ExperimentalHostClient<typeof dotfilesHostContract>, "call">;

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertConnected(target: Target): void {
  if (!target.connected) throw new Error(`${target.hostName} is not connected.`);
}

export function createDotfilesGit(
  bb: BbPluginApi,
  host: DotfilesHostClient = bb.hosts.experimental_client({ contract: dotfilesHostContract }),
): DotfilesGit {
  const settings = bb.settings.define({
    repoPath: {
      type: "string",
      label: "Dotfiles repo path",
      description:
        "On the machine picked in the Dotfiles panel. A leading ~ is that machine's home.",
      default: "~/git/dotfiles",
    },
    hostId: {
      type: "string",
      label: "Machine (bb host id)",
      description:
        "The machine the Dotfiles panel acts on. Pick it in the panel. Empty means the bb server's own machine.",
    },
  });

  async function selectedHostId(configured: string | undefined): Promise<string | null> {
    return configured || (await bb.sdk.system.config()).primaryHostId;
  }

  async function run(target: Target, command: string): Promise<TaskResult> {
    assertConnected(target);
    return host.call(
      "run",
      { repoPath: target.repoPath, command },
      { hostId: target.hostId, timeoutMs: taskTimeoutMs },
    );
  }

  return {
    async hosts() {
      const [hosts, { hostId }] = await Promise.all([bb.sdk.hosts.list(), settings.get()]);
      return {
        selectedHostId: await selectedHostId(hostId),
        hosts: hosts.map((item) => ({
          id: item.id,
          name: item.name,
          connected: item.status === "connected",
        })),
      };
    },

    async selectHost(hostId) {
      // A removed machine fails here instead of being stored.
      await bb.sdk.hosts.get({ hostId });
      await settings.experimental_set({ hostId });
    },

    async target(requested) {
      const configured = await settings.get();
      const hostId = requested ?? (await selectedHostId(configured.hostId));
      if (!hostId) throw new Error("No machine is selected. Pick one in the Dotfiles panel.");
      const machine = await bb.sdk.hosts.get({ hostId });
      return {
        hostId,
        hostName: machine.name,
        connected: machine.status === "connected",
        repoPath: configured.repoPath,
      };
    },

    async threadHostId(threadId) {
      const thread = await bb.sdk.threads.get({ threadId, include: "environment" });
      return "environment" in thread ? thread.environment?.hostId : undefined;
    },

    async inspect(target) {
      assertConnected(target);
      const inspection = await host.call(
        "inspect",
        { repoPath: target.repoPath },
        { hostId: target.hostId },
      );
      return { ...target, ...inspection };
    },

    async readFile(repo, path) {
      const file = await bb.sdk.files.read({
        hostId: repo.hostId,
        path: join(repo.repoPath, path),
      });
      if (file.contentEncoding !== "utf8") {
        throw new Error(`not a text file: ${path} (${file.contentEncoding})`);
      }
      return { content: file.content, sha256: file.sha256 };
    },

    async readHeadFile(repo, path) {
      const head = await host.call(
        "readHead",
        { repoPath: repo.repoPath, path },
        { hostId: repo.hostId },
      );
      return head.content;
    },

    async writeFile(repo, path, content, expectedSha256) {
      const result = await bb.sdk.files.write({
        hostId: repo.hostId,
        path: join(repo.repoPath, path),
        rootPath: repo.repoPath,
        content,
        expectedSha256,
      });
      return result.outcome === "written"
        ? { outcome: "written", sha256: result.sha256 }
        : { outcome: "conflict" };
    },

    run,

    removeSkill(repo, name) {
      return run(repo, `npx -y skills remove ${quoteShell(name)} -g -y`);
    },
  };
}
