import { expect, test } from "vitest";
import { applyMentions, branchMentions } from "./branch-mentions.ts";

const branchOf = (...commands: string[]) =>
  applyMentions(
    null,
    commands.flatMap((command) => branchMentions(command)),
  );

test("a commit onto a named branch names it", () => {
  expect(branchOf('but commit -b scott/pr-status -m "feat: x" a1 b2')).toBe("scott/pr-status");
  expect(branchOf("but commit --branch=scott/pr-status -m x")).toBe("scott/pr-status");
  expect(branchOf("but commit -A scott/base -b scott/top -m x")).toBe("scott/top");
});

test("creating, pushing, opening a PR for, and landing a branch name it", () => {
  expect(branchOf("but branch new scott/one")).toBe("scott/one");
  expect(branchOf("but branch new -A scott/base scott/two")).toBe("scott/two");
  expect(branchOf('but pr new scott/three -m "Title"')).toBe("scott/three");
  expect(branchOf("but push scott/four")).toBe("scott/four");
  expect(branchOf("LEFTHOOK=0 but land scott/five --yes")).toBe("scott/five");
});

test("the last branch a thread named wins, and a rename follows it", () => {
  expect(branchOf("but commit -b scott/a -m x", "but push scott/b")).toBe("scott/b");
  expect(branchOf("but commit -b scott/a -m x", "but reword scott/a -m scott/renamed")).toBe(
    "scott/renamed",
  );
  expect(branchOf("but commit -b scott/a -m x", "but reword scott/other -m scott/z")).toBe(
    "scott/a",
  );
});

test("commands chained, wrapped in a shell, or after cd are read", () => {
  expect(branchOf("cd /repo && but commit -b scott/chain -m x && but status")).toBe("scott/chain");
  expect(branchOf("/bin/zsh -lc 'cd /repo && but push scott/wrapped'")).toBe("scott/wrapped");
  expect(branchOf('bash -c "but -C /repo commit -b scott/global -m \\"msg\\""')).toBe(
    "scott/global",
  );
});

test("CLI ids, hashes, text that only mentions but, and heredoc bodies name nothing", () => {
  expect(branchOf("but push sc")).toBeNull();
  expect(branchOf("but commit -A 1a2b3c4d -m x")).toBeNull();
  // Above a branch without a name, the commit goes on a new, generated branch.
  expect(branchOf("but commit -A scott/base -m x")).toBeNull();
  expect(branchOf('grep -n "but commit -b scott/nope" notes.md')).toBeNull();
  expect(branchOf("echo but push scott/nope")).toBeNull();
  expect(branchOf("cat > a.sh <<'EOF'\nbut push scott/nope\nEOF\nchmod +x a.sh")).toBeNull();
  expect(branchOf("but commit -m x")).toBeNull();
  expect(branchOf("but status --json")).toBeNull();
});

test("a but command run in another checkout names nothing", () => {
  const here = "/home/me/git/app";
  const mentions = (command: string, cwd?: string) =>
    applyMentions(null, branchMentions(command, here, cwd));
  expect(mentions("cd /home/me/git/other && but commit -b scott/x -m y")).toBeNull();
  expect(mentions("but -C /home/me/git/other push scott/x")).toBeNull();
  expect(mentions("cd ~/git/other && but push scott/x")).toBeNull();
  expect(mentions("but push scott/x", "/home/me/git/other")).toBeNull();
  // The checkout itself, by any spelling, and its subdirectories still count.
  expect(mentions("cd /home/me/git/app/plugins && but push scott/a")).toBe("scott/a");
  expect(mentions("cd ~/git/app && but push scott/b")).toBe("scott/b");
  expect(mentions("cd ~/git/app/plugins/x && but push scott/e")).toBe("scott/e");
  expect(mentions("cd ~/git && but push scott/x")).toBeNull();
  expect(mentions("but -C /home/me/git/app push scott/c")).toBe("scott/c");
  expect(mentions("cd /tmp && ls; cd /home/me/git/app && but push scott/d")).toBe("scott/d");
  expect(mentions("/bin/zsh -lc 'cd /home/me/git/other && but push scott/x'")).toBeNull();
});
