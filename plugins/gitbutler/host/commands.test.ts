import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createFixedButCommands, type ExecFileLike } from "./commands.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../test/fixtures/but-0.22.3/${name}`, import.meta.url), "utf8");

describe("fixed GitButler commands", () => {
  test("uses exact argv, cwd, UTF-8, limits, cancellation, and no shell", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Parameters<ExecFileLike>[2];
    }> = [];
    const outputs = new Map<string, string>([
      ["--version", "but 0.22.3\n"],
      ["status -f --json", fixture("status-multiple-stacks.json")],
      ["diff --json", fixture("diff-text-hunks.json")],
      ["branch list --all --empty --no-check --no-ahead --json", fixture("branch-list.json")],
      ["commit -b scott/alpha -m message selector-a", ""],
    ]);
    const exec: ExecFileLike = (file, args, options, callback) => {
      calls.push({ file, args, options });
      queueMicrotask(() => callback(null, outputs.get(args.join(" ")) ?? "", ""));
    };
    const commands = createFixedButCommands(exec);
    const signal = new AbortController().signal;

    await commands.version("/repo", signal);
    await commands.status("/repo", signal);
    await commands.worktreeDiff("/repo", signal);
    await commands.branchNames("/repo", signal);
    await commands.commit(
      "/repo",
      { message: "message", branchName: "scott/alpha", hunks: ["selector-a" as never] },
      signal,
    );

    expect(calls.map((call) => [call.file, call.args])).toEqual([
      ["but", ["--version"]],
      ["but", ["status", "-f", "--json"]],
      ["but", ["diff", "--json"]],
      ["but", ["branch", "list", "--all", "--empty", "--no-check", "--no-ahead", "--json"]],
      ["but", ["commit", "-b", "scott/alpha", "-m", "message", "selector-a"]],
    ]);
    for (const call of calls) {
      expect(call.options.cwd).toBe("/repo");
      expect(call.options.encoding).toBe("utf8");
      expect(call.options.shell).toBe(false);
      expect(call.options.signal).toBe(signal);
      expect(typeof call.options.timeout).toBe("number");
      expect(typeof call.options.maxBuffer).toBe("number");
    }
    expect(calls[0]?.options.maxBuffer).toBe(64 * 1024);
    expect(calls[1]?.options.maxBuffer).toBe(4 * 1024 * 1024);
    expect(calls[4]?.options.timeout).toBe(30_000);
  });

  test("never treats wt as a worktree keyword", async () => {
    const seen: string[][] = [];
    const exec: ExecFileLike = (_file, args, _options, callback) => {
      seen.push([...args]);
      queueMicrotask(() => callback(null, fixture("diff-text-hunks.json"), ""));
    };
    await createFixedButCommands(exec).worktreeDiff("/repo", new AbortController().signal);
    expect(seen).toEqual([["diff", "--json"]]);
  });
});
