import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { gitButlerHostContract, parseGitButlerBranchSummary } from "./lib/gitbutler.ts";
import { parseGithubRemote } from "./lib/github-repo.ts";

const execFileAsync = promisify(execFile);

export default experimental_defineHostEntry({
  contract: gitButlerHostContract,
  handlers: {
    async branchSummary({ cwd }, context) {
      try {
        const { stdout } = await execFileAsync("but", ["status", "--json"], {
          cwd,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          signal: context.signal,
          timeout: 5_000,
        });
        return { label: parseGitButlerBranchSummary(stdout)?.label ?? null };
      } catch {
        // A regular repository, a host without `but`, and a stopped GitButler
        // project all keep bb's own branch label. This probe is an enhancement.
        return { label: null };
      }
    },
    async githubRepoContext({ cwd }, context) {
      try {
        const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
          cwd,
          encoding: "utf8",
          maxBuffer: 64 * 1024,
          signal: context.signal,
          timeout: 5_000,
        });
        const parsed = parseGithubRemote(stdout.trim());
        return { owner: parsed?.owner ?? null, repo: parsed?.repo ?? null };
      } catch {
        return { owner: null, repo: null };
      }
    },
  },
});
