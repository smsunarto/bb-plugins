#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REF_RE = /^[A-Za-z0-9._/-]+$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const AMBIGUOUS_RE = /ambiguous|matches more than one/iu;
const NON_FF_RE = /non-fast-forward|fetch first/iu;

const BARE_FLAGS = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null"];
const CHECKS_FLAGS = [...BARE_FLAGS, "-c", "core.fsmonitor=false"];

/** Build the clone/push URL strictly from `--repo`, never from any checkout's git config. */
export function buildRepoUrl(repo, { ssh = false, baseUrl } = {}) {
  assertRepo(repo);
  if (baseUrl !== undefined) {
    return `${baseUrl.replace(/\/+$/u, "")}/${repo}.git`;
  }
  return ssh ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function assertRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    fail(`invalid --repo ${JSON.stringify(repo)}: expected <owner>/<repo>`);
  }
}

function assertRef(name, flag) {
  if (
    typeof name !== "string" ||
    !REF_RE.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.includes("..")
  ) {
    fail(`invalid ${flag} ${JSON.stringify(name)}: must match ^[A-Za-z0-9._/-]+$`);
  }
}

function assertSha(sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    fail(`invalid --sha ${JSON.stringify(sha)}: expected lowercase 40-hex commit SHA`);
  }
}

function assertDir(dir) {
  if (typeof dir !== "string" || dir.trim() === "") {
    fail("missing required --dir <workdir>");
  }
  return resolve(dir);
}

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") || key === "GIT_CONFIG_GLOBAL" || key === "GIT_CONFIG_NOSYSTEM") {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

function spawnGitSync(args, cwd) {
  const res = spawnSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) {
    fail(`failed to execute git: ${res.error.message}`);
  }
  return {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

/** Run git while capturing stderr even on exit 0 so warnings (`ambiguous`) stop the ship. */
function runGitChecked(flags, args, { cwd, allowExit1 = false } = {}) {
  const fullArgs = [...flags, ...args];
  const result = spawnGitSync(fullArgs, cwd);
  if (AMBIGUOUS_RE.test(result.stderr)) {
    fail(`stop: git warned about ambiguous ref on ${args.join(" ")}: ${result.stderr}`);
  }
  if (result.status === 0 || (allowExit1 && result.status === 1)) {
    return result;
  }
  fail(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
}

/** Require both fetch and push `get-url --all` to print exactly one line equal to `expectedUrl`. */
function verifyOriginUrls(repoDir, expectedUrl, flags) {
  for (const args of [
    ["-C", repoDir, "remote", "get-url", "--all", "origin"],
    ["-C", repoDir, "remote", "get-url", "--push", "--all", "origin"],
  ]) {
    const { stdout } = runGitChecked(flags, args);
    const lines = stdout === "" ? [] : stdout.split("\n");
    if (lines.length !== 1 || lines[0] !== expectedUrl) {
      fail(
        `stop: ${args.slice(2).join(" ")} in ${repoDir} returned ${JSON.stringify(lines)}, expected [${JSON.stringify(expectedUrl)}]`,
      );
    }
  }
}

/** Filter `git ls-remote origin <ref>` by exact second field and require 0 or 1 match. */
function exactLsRemote(bareDir, ref) {
  const { stdout } = runGitChecked(BARE_FLAGS, ["-C", bareDir, "ls-remote", "origin", ref]);
  const lines = stdout === "" ? [] : stdout.split("\n");
  const matched = lines
    .map((line) => line.split(/\s+/u))
    .filter((parts) => parts[1] === ref)
    .map((parts) => parts[0] ?? "");
  if (matched.length > 1) {
    fail(`stop: ls-remote matched multiple entries for exact ref ${ref}`);
  }
  return matched[0] ?? null;
}

function cmdClone(opts) {
  const dir = assertDir(opts.dir);
  const url = buildRepoUrl(opts.repo, { ssh: opts.ssh, baseUrl: opts["base-url"] });
  const bareDir = join(dir, "bare.git");
  const checksDir = join(dir, "checks");
  if (existsSync(bareDir) || existsSync(checksDir)) {
    fail(`stop: ${dir} already contains bare.git or checks; run cleanup or use a new empty dir`);
  }
  mkdirSync(dir, { recursive: true });
  runGitChecked(BARE_FLAGS, ["clone", "--bare", "--filter=blob:none", url, bareDir]);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);
  process.stdout.write(`status: cloned\nurl: ${url}\nbare: ${bareDir}\n`);
}

function cmdVerify(opts) {
  const dir = assertDir(opts.dir);
  const url = buildRepoUrl(opts.repo, { ssh: opts.ssh, baseUrl: opts["base-url"] });
  assertRef(opts.target, "--target");
  assertRef(opts.branch, "--branch");
  assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  const checksDir = join(dir, "checks");
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  if (existsSync(checksDir)) {
    fail(`stop: ${checksDir} already exists; run cleanup and re-clone from scratch`);
  }
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  const targetRef = `refs/heads/${opts.target}`;
  const crewRef = `refs/heads/${opts.branch}`;

  // Check 1: target ref exists locally in bare clone and matches exact ls-remote.
  const localTarget = runGitChecked(BARE_FLAGS, [
    "-C",
    bareDir,
    "rev-parse",
    "--verify",
    targetRef,
  ]).stdout;
  const remoteTarget = exactLsRemote(bareDir, targetRef);
  if (remoteTarget === null || remoteTarget !== localTarget) {
    fail(
      `stop: target ${targetRef} mismatch (bare=${localTarget}, ls-remote=${remoteTarget ?? "missing"})`,
    );
  }

  // Check 2: already landed. Only run when `<sha>` exists in the bare clone; if the crew branch
  // was not pushed yet (and `<sha>` is not on target), Check 3 reports `crew-branch-missing`.
  const hasCommit = spawnGitSync(
    [...BARE_FLAGS, "-C", bareDir, "rev-parse", "--verify", "--quiet", `${opts.sha}^{commit}`],
    undefined,
  );
  if (AMBIGUOUS_RE.test(hasCommit.stderr)) {
    fail(`stop: git warned about ambiguous ref on ${opts.sha}: ${hasCommit.stderr}`);
  }
  if (hasCommit.status === 0) {
    const alreadyLanded = runGitChecked(
      BARE_FLAGS,
      ["-C", bareDir, "merge-base", "--is-ancestor", opts.sha, targetRef],
      { allowExit1: true },
    );
    if (alreadyLanded.status === 0) {
      process.stdout.write(`status: already-landed\ntarget_sha: ${localTarget}\n`);
      return;
    }
  }

  // Check 3: crew branch exists on origin and in bare clone at exact `<sha>`.
  const remoteCrew = exactLsRemote(bareDir, crewRef);
  if (remoteCrew === null) {
    fail(`status: crew-branch-missing\nref: ${crewRef}`, 2);
  }
  const localCrewRes = spawnGitSync(
    [...BARE_FLAGS, "-C", bareDir, "rev-parse", "--verify", crewRef],
    undefined,
  );
  if (AMBIGUOUS_RE.test(localCrewRes.stderr)) {
    fail(`stop: git warned about ambiguous ref on ${crewRef}: ${localCrewRes.stderr}`);
  }
  if (localCrewRes.status !== 0) {
    fail(`status: crew-branch-missing\nref: ${crewRef}`, 2);
  }
  if (localCrewRes.stdout !== opts.sha || remoteCrew !== opts.sha) {
    fail(
      `stop: ${crewRef} is not at ${opts.sha} (bare=${localCrewRes.stdout}, ls-remote=${remoteCrew})`,
    );
  }

  // Check 4: fast-forward.
  const ff = runGitChecked(
    BARE_FLAGS,
    ["-C", bareDir, "merge-base", "--is-ancestor", targetRef, opts.sha],
    { allowExit1: true },
  );
  if (ff.status === 1) {
    fail(`status: not-fast-forward\ntarget_sha: ${localTarget}`, 3);
  }

  // Check 5: commit list.
  const commits = runGitChecked(BARE_FLAGS, [
    "-C",
    bareDir,
    "log",
    "--oneline",
    `${targetRef}..${opts.sha}`,
  ]).stdout;

  // Build fresh checks clone with hooks and fsmonitor disabled (own `.git` dir, never worktree).
  runGitChecked(CHECKS_FLAGS, ["clone", "--no-checkout", url, checksDir]);
  verifyOriginUrls(checksDir, url, CHECKS_FLAGS);
  runGitChecked(CHECKS_FLAGS, ["-C", checksDir, "checkout", "--detach", `${opts.sha}^{commit}`]);
  const gitEntry = join(checksDir, ".git");
  if (!existsSync(gitEntry) || !lstatSync(gitEntry).isDirectory()) {
    fail(`stop: ${gitEntry} is not a directory of its own`);
  }
  const checksTree = runGitChecked(CHECKS_FLAGS, [
    "-C",
    checksDir,
    "rev-parse",
    "HEAD^{tree}",
  ]).stdout;
  const expectedTree = runGitChecked(BARE_FLAGS, [
    "-C",
    bareDir,
    "rev-parse",
    `${opts.sha}^{tree}`,
  ]).stdout;
  if (checksTree !== expectedTree) {
    fail(`stop: checks clone tree ${checksTree} does not match ${opts.sha}^{tree} ${expectedTree}`);
  }

  process.stdout.write(
    `status: ready\ntarget_sha: ${localTarget}\nchecks: ${checksDir}\ncommits:\n${commits}\n`,
  );
}

function cmdPush(opts) {
  const dir = assertDir(opts.dir);
  const url = buildRepoUrl(opts.repo, { ssh: opts.ssh, baseUrl: opts["base-url"] });
  assertRef(opts.target, "--target");
  assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  const res = spawnGitSync(
    [
      ...BARE_FLAGS,
      "-C",
      bareDir,
      "push",
      "origin",
      `${opts.sha}^{commit}:refs/heads/${opts.target}`,
    ],
    undefined,
  );
  if (AMBIGUOUS_RE.test(res.stderr)) {
    fail(`stop: push warned about ambiguous ref: ${res.stderr}`);
  }
  if (res.status !== 0) {
    if (NON_FF_RE.test(res.stderr)) {
      fail(`status: not-fast-forward\n${res.stderr}`, 3);
    }
    fail(`status: refused\n${res.stderr || res.stdout}`, 1);
  }
  process.stdout.write(`status: pushed\nsha: ${opts.sha}\ntarget: ${opts.target}\n`);
}

function cmdConfirm(opts) {
  const dir = assertDir(opts.dir);
  const url = buildRepoUrl(opts.repo, { ssh: opts.ssh, baseUrl: opts["base-url"] });
  assertRef(opts.target, "--target");
  assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  const targetRef = `refs/heads/${opts.target}`;
  runGitChecked(BARE_FLAGS, ["-C", bareDir, "fetch", "origin", `+${targetRef}:${targetRef}`]);
  const localTarget = runGitChecked(BARE_FLAGS, [
    "-C",
    bareDir,
    "rev-parse",
    "--verify",
    targetRef,
  ]).stdout;
  const remoteTarget = exactLsRemote(bareDir, targetRef);
  if (remoteTarget === null || remoteTarget !== localTarget) {
    fail(
      `stop: post-push target ${targetRef} mismatch (bare=${localTarget}, ls-remote=${remoteTarget ?? "missing"})`,
    );
  }
  runGitChecked(BARE_FLAGS, ["-C", bareDir, "merge-base", "--is-ancestor", opts.sha, targetRef]);
  process.stdout.write(`status: confirmed\ntarget_sha: ${localTarget}\n`);
}

function cmdCleanup(opts) {
  const dir = assertDir(opts.dir);
  rmSync(join(dir, "bare.git"), { recursive: true, force: true });
  rmSync(join(dir, "checks"), { recursive: true, force: true });
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
  }
  process.stdout.write(`status: cleaned\ndir: ${dir}\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(
      "Usage: direct-ship.mjs <clone|verify|push|confirm|cleanup> [options]\n" +
        "  clone   --repo <owner>/<repo> --dir <workdir> [--ssh] [--base-url <prefix>]\n" +
        "  verify  --repo <owner>/<repo> --dir <workdir> --target <branch> --branch <crew> --sha <40-hex> [--ssh] [--base-url <prefix>]\n" +
        "  push    --repo <owner>/<repo> --dir <workdir> --target <branch> --sha <40-hex> [--ssh] [--base-url <prefix>]\n" +
        "  confirm --repo <owner>/<repo> --dir <workdir> --target <branch> --sha <40-hex> [--ssh] [--base-url <prefix>]\n" +
        "  cleanup --dir <workdir>\n",
    );
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      repo: { type: "string" },
      dir: { type: "string" },
      target: { type: "string" },
      branch: { type: "string" },
      sha: { type: "string" },
      ssh: { type: "boolean", default: false },
      "base-url": { type: "string" },
    },
    strict: true,
  });
  switch (command) {
    case "clone":
      cmdClone(values);
      break;
    case "verify":
      cmdVerify(values);
      break;
    case "push":
      cmdPush(values);
      break;
    case "confirm":
      cmdConfirm(values);
      break;
    case "cleanup":
      cmdCleanup(values);
      break;
    default:
      fail(
        `unknown command ${JSON.stringify(command)}; expected clone, verify, push, confirm, or cleanup`,
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2));
}
