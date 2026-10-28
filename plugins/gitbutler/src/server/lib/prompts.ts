import { instructionFiles } from "@bb-plugins/instructions";
import type { CheckoutIdentity, NativeAgentPrompts } from "../../shared/schema.ts";

/*
 * What the subthreads the panel starts are told. The words live in
 * `instructions/`, and this fills in the commands.
 *
 * Git allows `;`, `$`, and backticks in branch names, and a path can hold
 * anything. Values in commands are shell-quoted; checkout metadata is JSON.
 * Both use fences longer than any backtick run in their values.
 */

const files = instructionFiles(import.meta.url);

/** The panel quotes these into its parent thread; no second agent is started. */
export function nativeAgentPrompts(checkout: CheckoutIdentity, hostId: string): NativeAgentPrompts {
  return {
    guidance: files.read("ask-agent-git", {
      checkout: fenced(
        JSON.stringify(
          {
            machine: hostId,
            path: checkout.path,
            branch: checkout.branch,
            head: checkout.head,
            origin: checkout.origin,
            commonDir: checkout.commonDir,
          },
          null,
          2,
        ),
        "json",
      ),
      status: fenced(`cd ${quote(checkout.path)}\ngit status --short --branch`),
    }),
    reword: files.read("reword-git"),
    squash: files.read("squash-git"),
    move: files.read("move-git"),
    uncommit: files.read("uncommit-git"),
    commit: files.read("commit-git"),
  };
}

/**
 * What the PR subthread is told. The agent reads the branch, writes the
 * title and description, and publishes with the checkout's driver. Native
 * Git resolves its configured publication target before any write.
 */
export function reviewPrompt(
  branch: string,
  repositoryPath: string,
  kind?: "git" | "gitbutler",
): string {
  const name = quote(branch);
  if (kind === "git") {
    return files.read("create-pr-git", {
      show: fenced(`cd ${quote(repositoryPath)}
git status --short --branch
git log --oneline --decorate -20 ${name}
git diff HEAD`),
      configuration: fenced(`git config --get ${quote(`branch.${branch}.pushRemote`)}
git config --get 'remote.pushDefault'
git config --get 'gitbutler.project.pushremote'
git config --get ${quote(`branch.${branch}.remote`)}
git config --get ${quote(`branch.${branch}.merge`)}
git config --get 'gitbutler.project.targetref'
git for-each-ref --format='%(refname) %(upstream)' ${quote(`refs/heads/${branch}`)}
git remote`),
    });
  }
  return files.read("create-pr", {
    show: fenced(`cd ${quote(repositoryPath)}\nbut show ${name}`),
    prNew: fenced(`but pr new ${name} -F <file>`),
  });
}

/**
 * What the conflict subthread is told. The agent resolves every conflict in
 * the workspace, commits and uncommitted files alike, so one subthread owns
 * the whole job: resolving a lower commit rebases the ones above it, and two
 * agents doing that side by side would rewrite each other's commits.
 *
 * It resolves with `but resolve apply`, not resolution mode, because the
 * subthread shares the parent thread's working tree and resolution mode would
 * swap it out from under that thread. GitButler 0.22.3 leaves some conflicts
 * to resolution mode only (deletions, renames, binary or oversized files), so
 * those go back to the user. The step order, the commit ids, and the warnings
 * about `apply` come from running this prompt against real conflicts in a
 * stack.
 */
export function conflictPrompt(repositoryPath: string, kind?: "git" | "gitbutler"): string {
  if (kind === "git") {
    return files.read("resolve-conflicts-git", {
      status: fenced(`cd ${quote(repositoryPath)}
git status
git ls-files -u`),
    });
  }
  return files.read("resolve-conflicts", {
    status: fenced(`cd ${quote(repositoryPath)}\nbut status`),
  });
}

/** POSIX single quotes: nothing inside is expanded, and `'` is closed, escaped, and reopened. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A fence longer than any backtick run inside, so the content cannot close it. */
function fenced(code: string, language = "sh"): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}
