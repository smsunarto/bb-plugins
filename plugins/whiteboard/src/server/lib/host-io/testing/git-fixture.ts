import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A real git repository in a temp dir: `base` and `head` commits plus helpers. */
export type GitFixture = {
  root: string;
  base: string;
  head: string;
  git(...args: string[]): string;
  write(file: string, text: string | Uint8Array): void;
  commit(message: string): string;
  remove(): void;
};

/**
 * `base` adds `src/a.ts` and `src/b.ts`. `head` edits `a.ts`, renames `b.ts`
 * to `src/c.ts` and adds `docs/readme.md`. The worktree is clean.
 */
export function gitFixture(prefix = "whiteboard-host-io-"): GitFixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Whiteboard Test",
        GIT_AUTHOR_EMAIL: "whiteboard@example.invalid",
        GIT_COMMITTER_NAME: "Whiteboard Test",
        GIT_COMMITTER_EMAIL: "whiteboard@example.invalid",
        GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
        GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
      },
    });
  const write = (file: string, text: string | Uint8Array) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("-c", "commit.gpgsign=false", "commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q", "-b", "main");
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 2;\nexport const bb = 22;\n");
  const base = commit("Base");
  write("src/a.ts", "export const a = 10;\nexport const a2 = 20;\n");
  git("mv", "src/b.ts", "src/c.ts");
  write("docs/readme.md", "# Readme\n");
  const head = commit("Head");
  return {
    root,
    base,
    head,
    git,
    write,
    commit,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
