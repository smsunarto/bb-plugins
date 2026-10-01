import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { detectLocalVcs, type LocalVcs } from "../../shared/node/vendor/local-vcs/src/index.ts";
import * as source from "../../shared/node/vendor/review/src/review-api/worktree-source.ts";
import { gitFixture, type GitFixture } from "../../server/lib/host-io/testing/git-fixture.ts";
import { inspectRetainedWorktree, retainedWorktreeTree } from "./worktree-snapshots.ts";

let repo: GitFixture;
let vcs: LocalVcs;
let repositoryId: string;

beforeEach(async () => {
  repo = gitFixture("whiteboard-retained-");
  vcs = (await detectLocalVcs(repo.root))!;
  repositoryId = randomUUID();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  repo.remove();
});

test("a write between tree capture and validation retries to one coherent source generation", async () => {
  repo.write("src/a.ts", "export const before = 1;\n");
  const indexPath = repo.git("rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  const index = readFileSync(indexPath);
  const original = source.inspectWorktree;
  let inspections = 0;
  vi.spyOn(source, "inspectWorktree").mockImplementation(async (...args) => {
    if (++inspections === 2) repo.write("src/a.ts", "export const after = 2;\n");
    return original(...args);
  });
  const captured = await inspectRetainedWorktree(repositoryId, vcs);
  const tree = await retainedWorktreeTree(repositoryId, captured.revision, vcs);
  expect(repo.git("show", `${tree}:src/a.ts`)).toBe("export const after = 2;\n");
  expect(inspections).toBe(4);
  expect(readFileSync(indexPath)).toEqual(index);
  expect(repo.git("rev-parse", "HEAD").trim()).toBe(repo.head);
});

test("a submodule HEAD changes the source generation and cannot overwrite a legacy retained alias", async () => {
  const child = gitFixture("whiteboard-submodule-");
  try {
    repo.git("-c", "protocol.file.allow=always", "submodule", "add", child.root, "module");
    repo.commit("Add submodule");
    const metadata = await source.inspectWorktree(repositoryId, vcs);
    const before = await inspectRetainedWorktree(repositoryId, vcs);
    const original = await retainedWorktreeTree(repositoryId, before.revision, vcs);
    const alias = await retainedWorktreeTree(repositoryId, metadata.revision, vcs);
    repo.write("module/src/a.ts", "export const child = 3;\n");
    repo.git("-C", `${repo.root}/module`, "add", "src/a.ts");
    repo.git(
      "-C",
      `${repo.root}/module`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Change child",
    );
    expect((await source.inspectWorktree(repositoryId, vcs)).revision).toBe(metadata.revision);
    const after = await inspectRetainedWorktree(repositoryId, vcs);
    const updated = await retainedWorktreeTree(repositoryId, after.revision, vcs);
    expect(after.revision).not.toBe(before.revision);
    expect(repo.git("ls-tree", original, "module")).not.toBe(
      repo.git("ls-tree", updated, "module"),
    );
    expect(await retainedWorktreeTree(repositoryId, metadata.revision, vcs)).toBe(alias);
  } finally {
    child.remove();
  }
});

test("Git-clean CRLF and clean-filtered source stays clean while retained bytes stay exact", async () => {
  repo.git("config", "filter.upper.clean", "tr '[:lower:]' '[:upper:]'");
  repo.write(".gitattributes", "src/a.ts text=auto filter=upper\n");
  repo.git("add", "--renormalize", ".");
  repo.head = repo.commit("Canonical filtered baseline");
  expect(repo.git("show", "HEAD:src/a.ts")).toBe("EXPORT CONST A = 10;\nEXPORT CONST A2 = 20;\n");
  const raw = "export const a = 10;\r\nexport const a2 = 20;\r\n";
  repo.write("src/a.ts", raw);
  expect(repo.git("diff", "--name-only")).toBe("");
  const indexPath = repo.git("rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  const index = readFileSync(indexPath);
  const saved = await inspectRetainedWorktree(repositoryId, vcs);
  const rawTree = await retainedWorktreeTree(repositoryId, saved.revision, vcs);
  const canonical = await retainedWorktreeTree(repositoryId, saved.revision, vcs, true);
  expect(repo.git("show", `${rawTree}:src/a.ts`)).toBe(raw);
  expect(repo.git("diff", "--name-only", repo.head, canonical)).toBe("");
  expect(readFileSync(indexPath)).toEqual(index);
});

test("external attributes and symlink target changes invalidate canonical source caching", async () => {
  const attributes = `${repo.root}/.git/external-attributes`;
  repo.write(".git/external-attributes", "");
  symlinkSync(attributes, `${repo.root}/.git/attributes-link`);
  repo.git("config", "core.attributesFile", `${repo.root}/.git/attributes-link`);
  repo.git("config", "filter.upper.clean", "tr '[:lower:]' '[:upper:]'");
  const before = await inspectRetainedWorktree(repositoryId, vcs);
  repo.write(".git/external-attributes", "src/a.ts filter=upper\n");
  const after = await inspectRetainedWorktree(repositoryId, vcs);
  const tree = await retainedWorktreeTree(repositoryId, after.revision, vcs, true);
  expect(after.revision).not.toBe(before.revision);
  expect(repo.git("show", `${tree}:src/a.ts`)).toBe(
    "EXPORT CONST A = 10;\nEXPORT CONST A2 = 20;\n",
  );
  expect(repo.git("diff", "--name-only", repo.head, tree)).toBe("src/a.ts\n");
  expect(repo.git("hash-object", "src/a.ts")).toBe(repo.git("rev-parse", `${tree}:src/a.ts`));
  repo.write(".git/info/attributes", "src/a.ts -filter\n");
  const override = await inspectRetainedWorktree(repositoryId, vcs);
  expect(
    repo.git(
      "diff",
      "--name-only",
      repo.head,
      await retainedWorktreeTree(repositoryId, override.revision, vcs, true),
    ),
  ).toBe("");
});

test("sparse omitted files retain indexed bytes including lowercase flags and tab names", async () => {
  repo.write("excluded/tab\tname.ts", "export const omitted = 1;\n");
  repo.head = repo.commit("Sparse baseline");
  repo.git("sparse-checkout", "init", "--cone");
  repo.git("sparse-checkout", "set", "src");
  repo.git("update-index", "--assume-unchanged", "excluded/tab\tname.ts");
  expect(repo.git("status", "--porcelain=v1")).toBe("");
  const saved = await inspectRetainedWorktree(repositoryId, vcs);
  const tree = await retainedWorktreeTree(repositoryId, saved.revision, vcs, true);
  expect(repo.git("diff", "--name-only", repo.head, tree)).toBe("");
  expect(repo.git("show", `${tree}:excluded/tab\tname.ts`)).toBe("export const omitted = 1;\n");
});

test.each(["skip-worktree", "deleted"])(
  "canonical filtering uses indexed attributes for %s working attributes",
  async (kind) => {
    repo.git("config", "filter.upper.clean", "tr '[:lower:]' '[:upper:]'");
    repo.write(".gitattributes", "src/a.ts filter=upper\n");
    repo.git("add", "--renormalize", ".");
    repo.head = repo.commit("Indexed attribute baseline");
    if (kind === "skip-worktree") repo.git("update-index", "--skip-worktree", ".gitattributes");
    rmSync(`${repo.root}/.gitattributes`);
    const saved = await inspectRetainedWorktree(repositoryId, vcs);
    const canonical = await retainedWorktreeTree(repositoryId, saved.revision, vcs, true);
    expect(repo.git("show", `${canonical}:src/a.ts`)).toBe(
      "EXPORT CONST A = 10;\nEXPORT CONST A2 = 20;\n",
    );
    expect(repo.git("diff", "--name-only", repo.head, canonical)).toBe(
      kind === "deleted" ? ".gitattributes\n" : "",
    );
  },
);

test("deinitialized submodules keep the indexed gitlink and empty nested repositories are skipped", async () => {
  const child = gitFixture("whiteboard-submodule-empty-");
  try {
    repo.git("-c", "protocol.file.allow=always", "submodule", "add", child.root, "module");
    repo.head = repo.commit("Submodule baseline");
    repo.git("submodule", "deinit", "-f", "module");
    repo.git("init", "-q", "nested");
    expect(repo.git("diff", "--name-only")).toBe("");
    const saved = await inspectRetainedWorktree(repositoryId, vcs);
    const tree = await retainedWorktreeTree(repositoryId, saved.revision, vcs, true);
    expect(repo.git("diff", "--name-only", repo.head, tree)).toBe("");
    expect(repo.git("ls-tree", tree, "module")).toBe(`160000 commit ${child.head}\tmodule\n`);
    expect(repo.git("ls-tree", tree, "nested")).toBe("");
  } finally {
    child.remove();
  }
});

test("Git config changes invalidate mode comparisons and symlink checkout representations stay clean", async () => {
  symlinkSync("src/a.ts", `${repo.root}/link`);
  repo.head = repo.commit("Symlink baseline");
  repo.git("config", "core.fileMode", "true");
  chmodSync(`${repo.root}/src/a.ts`, 0o755);
  const executable = await inspectRetainedWorktree(repositoryId, vcs);
  expect(
    repo.git(
      "diff",
      "--name-only",
      repo.head,
      await retainedWorktreeTree(repositoryId, executable.revision, vcs, true),
    ),
  ).toBe("src/a.ts\n");
  repo.git("config", "core.fileMode", "false");
  repo.git("config", "core.symlinks", "false");
  rmSync(`${repo.root}/link`);
  repo.write("link", "src/a.ts");
  expect(repo.git("diff", "--name-only")).toBe("");
  const clean = await inspectRetainedWorktree(repositoryId, vcs);
  expect(clean.revision).not.toBe(executable.revision);
  expect(
    repo.git(
      "diff",
      "--name-only",
      repo.head,
      await retainedWorktreeTree(repositoryId, clean.revision, vcs, true),
    ),
  ).toBe("");
});

test("deletion during capture retries instead of publishing a partial generation", async () => {
  repo.write("transient.ts", "export const transient = 1;\n");
  const original = source.localSourcePath;
  let deleted = false;
  vi.spyOn(source, "localSourcePath").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!deleted && args[1] === "transient.ts") {
      deleted = true;
      rmSync(result);
    }
    return result;
  });
  const saved = await inspectRetainedWorktree(repositoryId, vcs);
  const tree = await retainedWorktreeTree(repositoryId, saved.revision, vcs);
  expect(deleted).toBe(true);
  expect(repo.git("ls-tree", tree, "transient.ts")).toBe("");
  expect(
    repo.git(
      "diff",
      "--name-only",
      repo.head,
      await retainedWorktreeTree(repositoryId, saved.revision, vcs, true),
    ),
  ).toBe("");
});

test("saved generations with one tree keep their comparison after upgrading retention", async () => {
  const saved = await inspectRetainedWorktree(repositoryId, vcs);
  const sourceTree = await retainedWorktreeTree(repositoryId, saved.revision, vcs);
  const savedRef = repo
    .git("for-each-ref", "--format=%(refname)", "refs/bb-whiteboard/worktrees")
    .split("\n")
    .find((name) => name.endsWith(`${saved.revision}-diff`))!;
  repo.git("update-ref", "-d", savedRef);
  expect(await retainedWorktreeTree(repositoryId, saved.revision, vcs, true)).toBe(sourceTree);
});

test.each([false, true])("text=auto preserves indexed CRLF with modified=%s", async (modified) => {
  repo.git("config", "core.autocrlf", "false");
  repo.write("crlf.txt", "before\r\nunchanged\r\n");
  repo.commit("Original CRLF blob");
  repo.write(".gitattributes", "* text=auto\n");
  repo.head = repo.commit("Attributes without renormalization");
  expect(repo.git("show", "HEAD:crlf.txt")).toBe("before\r\nunchanged\r\n");
  const raw = `${modified ? "after" : "before"}\r\nunchanged\r\n`;
  if (modified) repo.write("crlf.txt", raw);
  expect(repo.git("diff", "--numstat")).toBe(modified ? "1\t1\tcrlf.txt\n" : "");
  const indexPath = repo.git("rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  const index = readFileSync(indexPath);
  const saved = await inspectRetainedWorktree(repositoryId, vcs);
  const canonical = await retainedWorktreeTree(repositoryId, saved.revision, vcs, true);
  expect(repo.git("show", `${canonical}:crlf.txt`)).toBe(raw);
  expect(repo.git("diff", "--numstat", repo.head, canonical)).toBe(
    modified ? "1\t1\tcrlf.txt\n" : "",
  );
  expect(readFileSync(indexPath)).toEqual(index);
});

test("default XDG Git attributes invalidate the retained comparison", async () => {
  vi.stubEnv("XDG_CONFIG_HOME", `${repo.root}/.git/xdg`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", `${repo.root}/.git/test-global-config`);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  repo.write(".git/test-global-config", "");
  repo.git("config", "filter.upper.clean", "tr '[:lower:]' '[:upper:]'");
  repo.write(".git/xdg/git/attributes", "");
  const before = await inspectRetainedWorktree(repositoryId, vcs);
  repo.write(".git/xdg/git/attributes", "src/a.ts filter=upper\n");
  const after = await inspectRetainedWorktree(repositoryId, vcs);
  expect(after.revision).not.toBe(before.revision);
  const canonical = await retainedWorktreeTree(repositoryId, after.revision, vcs, true);
  expect(repo.git("show", `${canonical}:src/a.ts`)).toBe(
    "EXPORT CONST A = 10;\nEXPORT CONST A2 = 20;\n",
  );
});
