import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevError } from "./error.ts";
import { parseLauncherStatus } from "./launcher.ts";
import { parseRevisionSelector, resolveRevision, selectLatestDesktopTag } from "./revision.ts";
import { runCommand } from "./process.ts";

test("revision selectors reject ambiguous bare refs", () => {
  assert.deepEqual(parseRevisionSelector("latest"), { kind: "latest" });
  assert.deepEqual(parseRevisionSelector("local:feature/test"), {
    kind: "local",
    branch: "feature/test",
  });
  assert.throws(
    () => parseRevisionSelector("main"),
    (error) => code(error) === "invalid_revision",
  );
  assert.throws(
    () => parseRevisionSelector("commit:nope"),
    (error) => code(error) === "invalid_revision",
  );
});

test("latest desktop release uses semver order and peeled annotated tags", async () => {
  assert.equal(
    selectLatestDesktopTag([
      "desktop-v1.9.0",
      "desktop-v1.10.0-beta.2",
      "desktop-v1.10.0",
      "other-v9.0.0",
    ]),
    "desktop-v1.10.0",
  );
  const tagObject = "1".repeat(40);
  const peeled = "2".repeat(40);
  const latest = "3".repeat(40);
  const resolverRoot = mkdtempSync(join(tmpdir(), "bb-kit-latest-"));
  const calls: string[][] = [];
  const run = (_command: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "ls-remote") {
      return {
        status: 0,
        stdout: [
          `${tagObject}\trefs/tags/desktop-v1.9.0`,
          `${peeled}\trefs/tags/desktop-v1.9.0^{}`,
          `${latest}\trefs/tags/desktop-v1.10.0`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    if (args.includes("get-url")) return { status: 1, stdout: "", stderr: "" };
    if (args.includes("rev-parse")) return { status: 0, stdout: `${latest}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const resolved = await resolveRevision(
    { kind: "latest" },
    {
      run,
      resolverPath: join(resolverRoot, "resolver"),
      ownerToken: "latest-owner",
    },
  );
  assert.equal(resolved.canonical, "tag:desktop-v1.10.0");
  assert.equal(resolved.commit, latest);
  assert.equal(
    calls.some((args) => args.includes("merge-base") && args.includes("refs/remotes/origin/main")),
    true,
  );

  await assert.rejects(
    resolveRevision(
      { kind: "latest" },
      {
        run: (command, args) => {
          const result = run(command, args);
          return args.includes("merge-base") ? { ...result, status: 1 } : result;
        },
        resolverPath: join(resolverRoot, "rejected"),
        ownerToken: "rejected-owner",
      },
    ),
    (error) => error instanceof DevError && error.code === "release_not_on_main",
  );
});

test("temporary Git repositories resolve local, origin, tags, and commits exactly", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-revision-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const selected = join(root, "selected");
  initRepository(source);
  const mainCommit = commitFile(source, "main.txt", "main", "main");
  git(source, ["tag", "light-v1"]);
  git(source, ["tag", "-a", "annotated-v1", "-m", "annotated"]);
  git(root, ["clone", "--bare", source, remote]);
  git(root, ["clone", remote, selected]);
  git(selected, ["config", "user.email", "test@example.com"]);
  git(selected, ["config", "user.name", "Test"]);

  git(source, ["switch", "-c", "remote-only"]);
  const originCommit = commitFile(source, "remote.txt", "origin", "origin");
  git(source, ["push", remote, "remote-only"]);
  git(source, ["switch", "main"]);

  const local = await resolveRevision(
    { kind: "local", branch: "main" },
    { repositoryOption: selected },
  );
  assert.equal(local.commit, mainCommit);
  const origin = await resolveRevision(
    { kind: "origin", branch: "remote-only" },
    { repositoryOption: selected },
  );
  assert.equal(origin.commit, originCommit);
  const light = await resolveRevision(
    { kind: "tag", tag: "light-v1" },
    { repositoryOption: selected },
  );
  assert.equal(light.commit, mainCommit);
  const annotated = await resolveRevision(
    { kind: "tag", tag: "annotated-v1" },
    { repositoryOption: selected },
  );
  assert.equal(annotated.commit, mainCommit);
  const commit = await resolveRevision(
    { kind: "commit", commit: mainCommit.slice(0, 12) },
    { repositoryOption: selected },
  );
  assert.equal(commit.commit, mainCommit);
});

test("launcher status keeps app, server, and host targets distinct", () => {
  const status = parseLauncherStatus(
    [
      "Repo: /tmp/bb",
      "Instance: fixture",
      "Data dir: /tmp/data",
      "App: http://localhost:11001",
      "Server: http://localhost:19001",
      "Host daemon: http://127.0.0.1:27001",
      "Desktop user data: /tmp/data/desktop",
      "Dev session: running",
      "Desktop session: stopped",
      "Logs: /tmp/log/dev.log, /tmp/log/desktop.log",
      "",
    ].join("\n"),
  );
  assert.equal(status.appPort, 11001);
  assert.equal(status.serverPort, 19001);
  assert.equal(status.hostDaemonPort, 27001);
  assert.notEqual(status.appUrl, status.serverUrl);
  assert.throws(
    () => parseLauncherStatus("Repo: /tmp/bb\n"),
    (error) => code(error) === "malformed_launcher_status",
  );
});

function initRepository(path: string): void {
  mkdirSync(path);
  git(path, ["init", "-b", "main"]);
  git(path, ["config", "user.email", "test@example.com"]);
  git(path, ["config", "user.name", "Test"]);
}

function commitFile(repository: string, file: string, contents: string, message: string): string {
  const path = join(repository, file);
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, 0o755);
  git(repository, ["add", file]);
  git(repository, ["commit", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function git(cwd: string, args: readonly string[]): string {
  const result = runCommand("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function code(error: unknown): string | undefined {
  return error instanceof DevError ? error.code : undefined;
}
