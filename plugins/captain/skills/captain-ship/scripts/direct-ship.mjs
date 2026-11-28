#!/usr/bin/env node
// @ts-check
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const TEST_BASE_URL_ENV = "CAPTAIN_DIRECT_SHIP_TEST_BASE_URL";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REF_RE = /^[A-Za-z0-9._/-]+$/u;
const SHA_RE = /^[0-9a-f]{40}$/u;
const AMBIGUOUS_LINE_RE =
  /^(?:warning: refname '.+' is ambiguous\.?|(?:error|fatal): .*matches more than one\b)/imu;
const NON_FF_RE = /non-fast-forward|fetch first/iu;

const VERIFIED_FILE = "verified.json";
const WORKDIR_MARKER = ".captain-direct-ship-workdir";
const WORKDIR_MARKER_KIND = "captain-direct-ship";
const FORBIDDEN_BARE_PATHS = ["info/grafts", "shallow", "objects/info/alternates"];
const NONEXISTENT_GRAFT_FILE = "/dev/null/direct-ship-no-grafts";
const NONEXISTENT_SHALLOW_FILE = "/dev/null/direct-ship-no-shallow";
const BARE_FLAGS = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null"];
const CHECKS_FLAGS = [...BARE_FLAGS, "-c", "core.fsmonitor=false"];
const STRIPPED_GIT_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR",
]);

/**
 * @typedef {{
 *   repo?: string | undefined;
 *   dir?: string | undefined;
 *   target?: string | undefined;
 *   branch?: string | undefined;
 *   sha?: string | undefined;
 *   ssh?: boolean | undefined;
 * }} CliOptions
 */

/** @typedef {{ status: number; stdout: string; stderr: string }} GitResult */

/** @typedef {{ repo: string; sha: string; target: string; target_sha: string }} VerifiedState */

/**
 * @typedef {
 *   | { ok: true; landed: boolean; targetSha: string }
 *   | { ok: false; error: string }
 * } LandedCheckResult
 */

/** Paths registered by the running subcommand to remove if `fail()` stops before completion. */
/** @type {string | null} */
let rollbackWorkdir = null;
let rollbackOwnsWorkdir = false;
/** @type {Set<string>} */
const rollbackPaths = new Set();

/**
 * @param {string} path
 * @returns {boolean}
 */
function pathExistsIncludingSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isScriptWorkdir(dir) {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    const markerPath = join(dir, WORKDIR_MARKER);
    if (!lstatSync(markerPath).isFile()) return false;
    const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(markerPath, "utf8")));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      parsed.kind === WORKDIR_MARKER_KIND
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {boolean} ownsWorkdir
 * @param {...string} paths
 */
function registerRollback(dir, ownsWorkdir, ...paths) {
  rollbackWorkdir = dir;
  rollbackOwnsWorkdir = ownsWorkdir;
  for (const path of paths) rollbackPaths.add(path);
}

function clearRollback() {
  rollbackPaths.clear();
  rollbackWorkdir = null;
  rollbackOwnsWorkdir = false;
}

function runRollback() {
  for (const path of rollbackPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  rollbackPaths.clear();
  if (rollbackOwnsWorkdir && rollbackWorkdir !== null && existsSync(rollbackWorkdir)) {
    try {
      if (readdirSync(rollbackWorkdir).length === 0) rmdirSync(rollbackWorkdir);
    } catch {
      // Best-effort removal of an empty temp directory created by this script.
    }
  }
  rollbackWorkdir = null;
  rollbackOwnsWorkdir = false;
}

/**
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
function fail(message, code = 1) {
  runRollback();
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Emit a structured `status:` block on stdout, optionally roll back, and exit.
 * @param {string} body
 * @param {number} code
 * @param {{ rollback?: boolean }} [options]
 * @returns {never}
 */
function exitStatus(body, code, { rollback = true } = {}) {
  if (rollback) runRollback();
  else clearRollback();
  process.stdout.write(`${body}\n`);
  process.exit(code);
}

/**
 * @param {unknown} repo
 * @returns {repo is string}
 */
function isValidRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return false;
  const [owner, name] = repo.split("/");
  if (!owner || !name) return false;
  if (owner === "." || owner === ".." || owner.includes("..")) return false;
  if (name === "." || name === ".." || name.includes("..")) return false;
  if (/\.git$/iu.test(name)) return false;
  return true;
}

/**
 * @param {unknown} repo
 * @returns {string}
 */
function assertRepo(repo) {
  if (!isValidRepo(repo)) {
    fail(`invalid --repo ${JSON.stringify(repo)}: expected <owner>/<repo> (no '..', no '.git')`);
  }
  return repo;
}

/** @returns {string | undefined} */
function readTestBaseUrl() {
  const value = process.env[TEST_BASE_URL_ENV];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Build the clone/push URL strictly from `--repo`, never from any checkout's git config.
 * @param {string} repo
 * @param {{ ssh?: boolean | undefined; baseUrl?: string | undefined }} [options]
 * @returns {string}
 */
export function buildRepoUrl(repo, { ssh = false, baseUrl } = {}) {
  const validRepo = assertRepo(repo);
  if (baseUrl !== undefined) {
    return `${baseUrl.replace(/\/+$/u, "")}/${validRepo}.git`;
  }
  return ssh ? `git@github.com:${validRepo}.git` : `https://github.com/${validRepo}.git`;
}

/**
 * Escape bytes below 0x20 and 0x7f so control characters cannot disguise commit subjects.
 * @param {string} text
 * @returns {string}
 */
export function escapeControlChars(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += text.charAt(i);
  }
  return out;
}

/**
 * @param {unknown} name
 * @param {string} flag
 * @returns {string}
 */
function assertRef(name, flag) {
  if (
    typeof name !== "string" ||
    !REF_RE.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.startsWith("-") ||
    name.endsWith(".") ||
    name.includes("//") ||
    name.includes("..") ||
    name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    fail(`invalid ${flag} ${JSON.stringify(name)}: invalid git branch ref name`);
  }
  const check = spawnGitSync(["check-ref-format", `refs/heads/${name}`], undefined);
  if (check.status !== 0) {
    fail(`invalid ${flag} ${JSON.stringify(name)}: rejected by git check-ref-format`);
  }
  return name;
}

/**
 * @param {unknown} sha
 * @returns {string}
 */
function assertSha(sha) {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    fail(`invalid --sha ${JSON.stringify(sha)}: expected lowercase 40-hex commit SHA`);
  }
  return sha;
}

/**
 * @param {unknown} dir
 * @returns {string}
 */
function assertDir(dir) {
  if (typeof dir !== "string" || dir.trim() === "") {
    fail("missing required --dir <workdir>");
  }
  return resolve(dir);
}

/**
 * Strip only repo-pointing git env vars and disable grafts/shallow via nonexistent paths;
 * preserve GIT_CONFIG_COUNT/KEY_n/VALUE_n for machine git credentials.
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIPPED_GIT_ENV.has(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_GRAFT_FILE = NONEXISTENT_GRAFT_FILE;
  env.GIT_SHALLOW_FILE = NONEXISTENT_SHALLOW_FILE;
  return env;
}

/**
 * @param {string[]} args
 * @param {string | undefined} cwd
 * @param {{ trimStdout?: boolean }} [options]
 * @returns {GitResult}
 */
function spawnGitSync(args, cwd, { trimStdout = true } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) {
    fail(`failed to execute git: ${res.error.message}`);
  }
  const rawStdout = res.stdout ?? "";
  return {
    status: res.status ?? 1,
    stdout: trimStdout ? rawStdout.trim() : rawStdout,
    stderr: (res.stderr ?? "").trim(),
  };
}

/**
 * Run git while capturing stderr even on exit 0 so git ambiguity lines stop the ship.
 * @param {readonly string[]} flags
 * @param {readonly string[]} args
 * @param {{ cwd?: string; allowExit1?: boolean; trimStdout?: boolean }} [options]
 * @returns {GitResult}
 */
function runGitChecked(flags, args, { cwd, allowExit1 = false, trimStdout = true } = {}) {
  const fullArgs = [...flags, ...args];
  const result = spawnGitSync(fullArgs, cwd, { trimStdout });
  if (AMBIGUOUS_LINE_RE.test(result.stderr)) {
    fail(`stop: git reported ambiguous ref on ${args.join(" ")}: ${result.stderr}`);
  }
  if (result.status === 0 || (allowExit1 && result.status === 1)) {
    return result;
  }
  fail(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
}

/**
 * @param {string} bareDir
 * @returns {string | null}
 */
function findForbiddenBareState(bareDir) {
  for (const rel of FORBIDDEN_BARE_PATHS) {
    if (pathExistsIncludingSymlink(join(bareDir, rel))) {
      return `stop: unexpected repo state in ${bareDir}: ${rel} exists`;
    }
  }
  return null;
}

/** @param {string} bareDir */
function assertBareRepoClean(bareDir) {
  const problem = findForbiddenBareState(bareDir);
  if (problem !== null) fail(problem);
}

/**
 * Require both fetch and push `get-url --all` to print exactly one line equal to `expectedUrl`.
 * @param {string} repoDir
 * @param {string} expectedUrl
 * @param {readonly string[]} flags
 */
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

/**
 * Parse `git ls-remote origin <ref>` stdout by exact second field and require 0 or 1 match.
 * @param {string} stdout
 * @param {string} ref
 * @returns {{ ok: true; sha: string | null } | { ok: false; error: string }}
 */
function parseExactLsRemote(stdout, ref) {
  const lines = stdout === "" ? [] : stdout.split("\n");
  const matched = lines
    .map((line) => line.split(/\s+/u))
    .filter((parts) => parts[1] === ref)
    .map((parts) => parts[0] ?? "");
  if (matched.length > 1) {
    return { ok: false, error: `stop: ls-remote matched multiple entries for exact ref ${ref}` };
  }
  return { ok: true, sha: matched[0] ?? null };
}

/**
 * Filter `git ls-remote origin <ref>` by exact second field and require 0 or 1 match.
 * @param {string} bareDir
 * @param {string} ref
 * @returns {string | null}
 */
function exactLsRemote(bareDir, ref) {
  const { stdout } = runGitChecked(BARE_FLAGS, ["-C", bareDir, "ls-remote", "origin", ref]);
  const parsed = parseExactLsRemote(stdout, ref);
  if (!parsed.ok) fail(parsed.error);
  return parsed.sha;
}

/**
 * Non-throwing variant of `runGitChecked` for post-push / confirm checks.
 * @param {readonly string[]} flags
 * @param {readonly string[]} args
 * @param {{ allowExit1?: boolean }} [options]
 * @returns {{ ok: true; result: GitResult } | { ok: false; error: string }}
 */
function tryRunGitChecked(flags, args, { allowExit1 = false } = {}) {
  const result = spawnGitSync([...flags, ...args], undefined);
  if (AMBIGUOUS_LINE_RE.test(result.stderr)) {
    return {
      ok: false,
      error: `git reported ambiguous ref on ${args.join(" ")}: ${result.stderr}`,
    };
  }
  if (result.status === 0 || (allowExit1 && result.status === 1)) {
    return { ok: true, result };
  }
  return {
    ok: false,
    error: `git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
  };
}

/**
 * Fetch target fresh into `bare.git` and return whether `<sha>` is already on it without exiting.
 * @param {string} bareDir
 * @param {string} targetRef
 * @param {string} sha
 * @returns {LandedCheckResult}
 */
function tryFetchAndCheckLanded(bareDir, targetRef, sha) {
  const bareProblem = findForbiddenBareState(bareDir);
  if (bareProblem !== null) return { ok: false, error: bareProblem };

  const fetchRes = tryRunGitChecked(BARE_FLAGS, [
    "-C",
    bareDir,
    "fetch",
    "-q",
    "origin",
    `+${targetRef}:${targetRef}`,
  ]);
  if (!fetchRes.ok) return fetchRes;

  const postFetchProblem = findForbiddenBareState(bareDir);
  if (postFetchProblem !== null) return { ok: false, error: postFetchProblem };

  const localRes = tryRunGitChecked(BARE_FLAGS, [
    "-C",
    bareDir,
    "rev-parse",
    "--verify",
    targetRef,
  ]);
  if (!localRes.ok) return localRes;
  const localTarget = localRes.result.stdout;

  const lsRes = tryRunGitChecked(BARE_FLAGS, ["-C", bareDir, "ls-remote", "origin", targetRef]);
  if (!lsRes.ok) return lsRes;
  const remoteParsed = parseExactLsRemote(lsRes.result.stdout, targetRef);
  if (!remoteParsed.ok) return remoteParsed;
  if (remoteParsed.sha === null || remoteParsed.sha !== localTarget) {
    return {
      ok: false,
      error: `target ${targetRef} mismatch after fetch (bare=${localTarget}, ls-remote=${remoteParsed.sha ?? "missing"})`,
    };
  }

  const landed = tryRunGitChecked(
    BARE_FLAGS,
    ["-C", bareDir, "merge-base", "--is-ancestor", sha, targetRef],
    { allowExit1: true },
  );
  if (!landed.ok) return landed;
  return { ok: true, landed: landed.result.status === 0, targetSha: localTarget };
}

/**
 * Create a brand-new workdir (via mkdtemp when `--dir` is omitted, or exclusive mkdir when provided)
 * and stamp it with `WORKDIR_MARKER`.
 * @param {string | undefined} requestedDir
 * @returns {{ dir: string; markerPath: string }}
 */
function createScriptWorkdir(requestedDir) {
  /** @type {string} */
  let dir;
  if (requestedDir === undefined) {
    const storage = process.env.BB_THREAD_STORAGE;
    const parent =
      typeof storage === "string" && storage.trim() !== "" && existsSync(storage)
        ? storage
        : tmpdir();
    dir = realpathSync(mkdtempSync(join(parent, "captain-direct-ship-")));
  } else {
    dir = assertDir(requestedDir);
    if (pathExistsIncludingSymlink(dir)) {
      fail(`stop: ${dir} already exists; pass a new non-existent --dir or omit --dir`);
    }
    try {
      mkdirSync(dir);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      fail(`stop: could not create ${dir}: ${msg}`);
    }
  }
  const markerPath = join(dir, WORKDIR_MARKER);
  registerRollback(dir, true, markerPath);
  try {
    writeFileSync(markerPath, `${JSON.stringify({ kind: WORKDIR_MARKER_KIND, version: 1 })}\n`, {
      flag: "wx",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`stop: could not write workdir marker in ${dir}: ${msg}`);
  }
  return { dir, markerPath };
}

/** @param {CliOptions} opts */
function cmdClone(opts) {
  const repo = assertRepo(opts.repo);
  const url = buildRepoUrl(repo, { ssh: opts.ssh, baseUrl: readTestBaseUrl() });
  const { dir, markerPath } = createScriptWorkdir(opts.dir);
  const bareDir = join(dir, "bare.git");
  registerRollback(dir, true, bareDir, markerPath);
  runGitChecked(BARE_FLAGS, ["clone", "-q", "--bare", "--filter=blob:none", url, bareDir]);
  assertBareRepoClean(bareDir);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);
  process.stdout.write(`status: cloned\ndir: ${dir}\nurl: ${url}\nbare: ${bareDir}\n`);
}

/**
 * Format `git log -z --format=%h %s` output with control characters escaped.
 * @param {string} rawStdout
 * @returns {string}
 */
function formatEscapedCommitLog(rawStdout) {
  if (rawStdout === "") return "";
  const entries = rawStdout.split("\0");
  if (entries[entries.length - 1] === "") entries.pop();
  return entries.map((entry) => escapeControlChars(entry)).join("\n");
}

/** @param {CliOptions} opts */
function cmdVerify(opts) {
  const dir = assertDir(opts.dir);
  const repo = assertRepo(opts.repo);
  const url = buildRepoUrl(repo, { ssh: opts.ssh, baseUrl: readTestBaseUrl() });
  const target = assertRef(opts.target, "--target");
  const branch = assertRef(opts.branch, "--branch");
  const sha = assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  const checksDir = join(dir, "checks");
  const verifiedPath = join(dir, VERIFIED_FILE);
  const markerPath = join(dir, WORKDIR_MARKER);
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  if (existsSync(checksDir)) {
    fail(`stop: ${checksDir} already exists; run cleanup and re-clone from scratch`);
  }
  registerRollback(dir, isScriptWorkdir(dir), checksDir, verifiedPath, bareDir, markerPath);
  assertBareRepoClean(bareDir);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  const targetRef = `refs/heads/${target}`;
  const crewRef = `refs/heads/${branch}`;

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
    [...BARE_FLAGS, "-C", bareDir, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    undefined,
  );
  if (AMBIGUOUS_LINE_RE.test(hasCommit.stderr)) {
    fail(`stop: git warned about ambiguous ref on ${sha}: ${hasCommit.stderr}`);
  }
  if (hasCommit.status === 0) {
    const alreadyLanded = runGitChecked(
      BARE_FLAGS,
      ["-C", bareDir, "merge-base", "--is-ancestor", sha, targetRef],
      { allowExit1: true },
    );
    if (alreadyLanded.status === 0) {
      clearRollback();
      process.stdout.write(`status: already-landed\ntarget_sha: ${localTarget}\n`);
      return;
    }
  }

  // Check 3: crew branch exists on origin and in bare clone at exact `<sha>`.
  const remoteCrew = exactLsRemote(bareDir, crewRef);
  if (remoteCrew === null) {
    exitStatus(`status: crew-branch-missing\nref: ${crewRef}`, 2);
  }
  const localCrewRes = spawnGitSync(
    [...BARE_FLAGS, "-C", bareDir, "rev-parse", "--verify", crewRef],
    undefined,
  );
  if (AMBIGUOUS_LINE_RE.test(localCrewRes.stderr)) {
    fail(`stop: git warned about ambiguous ref on ${crewRef}: ${localCrewRes.stderr}`);
  }
  if (localCrewRes.status !== 0) {
    fail(
      `stop: ${crewRef} exists on origin (${remoteCrew}) but is missing from bare clone; re-clone from scratch`,
    );
  }
  if (localCrewRes.stdout !== sha || remoteCrew !== sha) {
    fail(
      `stop: ${crewRef} is not at ${sha} (bare=${localCrewRes.stdout}, ls-remote=${remoteCrew})`,
    );
  }

  // Check 4: fast-forward.
  const ff = runGitChecked(
    BARE_FLAGS,
    ["-C", bareDir, "merge-base", "--is-ancestor", targetRef, sha],
    { allowExit1: true },
  );
  if (ff.status === 1) {
    exitStatus(`status: not-fast-forward\ntarget_sha: ${localTarget}`, 3);
  }

  // Check 5: commit list with control characters escaped.
  const rawLog = runGitChecked(
    BARE_FLAGS,
    ["-C", bareDir, "log", "-z", "--format=%h %s", `${targetRef}..${sha}`],
    { trimStdout: false },
  ).stdout;
  const commits = formatEscapedCommitLog(rawLog);

  // Build fresh checks clone with hooks and fsmonitor disabled (own `.git` dir, never worktree).
  runGitChecked(CHECKS_FLAGS, ["clone", "-q", "--no-checkout", url, checksDir]);
  verifyOriginUrls(checksDir, url, CHECKS_FLAGS);
  runGitChecked(CHECKS_FLAGS, ["-C", checksDir, "checkout", "-q", "--detach", `${sha}^{commit}`]);

  writeFileSync(
    verifiedPath,
    `${JSON.stringify({ repo, sha, target, target_sha: localTarget }, null, 2)}\n`,
  );

  clearRollback();
  process.stdout.write(
    `status: ready\ntarget_sha: ${localTarget}\nchecks: ${checksDir}\ncommits:\n${commits}\n`,
  );
}

/**
 * @param {string} dir
 * @returns {VerifiedState}
 */
function readVerifiedState(dir) {
  const verifiedPath = join(dir, VERIFIED_FILE);
  if (!existsSync(verifiedPath)) {
    fail(`stop: missing ${VERIFIED_FILE} in ${dir}; run verify before push`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(verifiedPath, "utf8"));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`stop: unreadable ${VERIFIED_FILE}: ${msg}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("repo" in parsed) ||
    !("sha" in parsed) ||
    !("target" in parsed) ||
    !("target_sha" in parsed) ||
    !isValidRepo(parsed.repo) ||
    typeof parsed.sha !== "string" ||
    typeof parsed.target !== "string" ||
    typeof parsed.target_sha !== "string" ||
    !SHA_RE.test(parsed.sha) ||
    !SHA_RE.test(parsed.target_sha)
  ) {
    fail(`stop: invalid ${VERIFIED_FILE} in ${dir}`);
  }
  return {
    repo: parsed.repo,
    sha: parsed.sha,
    target: parsed.target,
    target_sha: parsed.target_sha,
  };
}

/**
 * Classify a target move after proving `<sha>` has not landed on `targetRef`.
 * Emits `status: target-moved` (exit 5) if target is still an ancestor of `<sha>`,
 * otherwise `status: not-fast-forward` (exit 3).
 * @param {string} bareDir
 * @param {string} targetRef
 * @param {string} sha
 * @param {string} currentTargetSha
 * @param {string} verifiedTargetSha
 * @returns {never}
 */
function exitTargetMovedOrNotFf(bareDir, targetRef, sha, currentTargetSha, verifiedTargetSha) {
  const stillFf = runGitChecked(
    BARE_FLAGS,
    ["-C", bareDir, "merge-base", "--is-ancestor", targetRef, sha],
    { allowExit1: true },
  );
  if (stillFf.status === 0) {
    exitStatus(
      `status: target-moved\ntarget_sha: ${currentTargetSha}\nverified_target_sha: ${verifiedTargetSha}`,
      5,
    );
  }
  exitStatus(
    `status: not-fast-forward\ntarget_sha: ${currentTargetSha}\nverified_target_sha: ${verifiedTargetSha}`,
    3,
  );
}

/** @param {CliOptions} opts */
function cmdPush(opts) {
  const dir = assertDir(opts.dir);
  const repo = assertRepo(opts.repo);
  const url = buildRepoUrl(repo, { ssh: opts.ssh, baseUrl: readTestBaseUrl() });
  const target = assertRef(opts.target, "--target");
  const sha = assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  const checksDir = join(dir, "checks");
  const verifiedPath = join(dir, VERIFIED_FILE);
  const markerPath = join(dir, WORKDIR_MARKER);
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);

  // Check verified state before registering rollback so a mistyped --repo/--sha/--target
  // never destroys a verified workdir.
  const verified = readVerifiedState(dir);
  if (verified.repo !== repo || verified.sha !== sha || verified.target !== target) {
    fail(
      `stop: push (${repo} ${target} @ ${sha}) does not match verified (${verified.repo} ${verified.target} @ ${verified.sha})`,
    );
  }

  registerRollback(dir, isScriptWorkdir(dir), checksDir, verifiedPath, bareDir, markerPath);
  assertBareRepoClean(bareDir);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  const targetRef = `refs/heads/${target}`;
  const currentRemoteTarget = exactLsRemote(bareDir, targetRef);
  if (currentRemoteTarget === null) {
    fail(`stop: target ${targetRef} no longer exists on origin`);
  }
  if (currentRemoteTarget !== verified.target_sha) {
    const check = tryFetchAndCheckLanded(bareDir, targetRef, sha);
    if (!check.ok) {
      exitStatus(`status: landing-uncertain\nreason: ${check.error}`, 4, { rollback: false });
    }
    if (check.landed) {
      clearRollback();
      process.stdout.write(`status: already-landed\ntarget_sha: ${check.targetSha}\n`);
      return;
    }
    exitTargetMovedOrNotFf(bareDir, targetRef, sha, check.targetSha, verified.target_sha);
  }

  const res = spawnGitSync(
    [...BARE_FLAGS, "-C", bareDir, "push", "origin", `${sha}^{commit}:refs/heads/${target}`],
    undefined,
  );
  if (res.status !== 0) {
    const check = tryFetchAndCheckLanded(bareDir, targetRef, sha);
    if (!check.ok) {
      exitStatus(`status: landing-uncertain\nreason: ${check.error}`, 4, { rollback: false });
    }
    if (check.landed) {
      clearRollback();
      process.stdout.write(`status: already-landed\ntarget_sha: ${check.targetSha}\n`);
      return;
    }
    if (AMBIGUOUS_LINE_RE.test(res.stderr)) {
      fail(`stop: push failed with ambiguous ref: ${res.stderr}`);
    }
    if (NON_FF_RE.test(res.stderr)) {
      exitTargetMovedOrNotFf(bareDir, targetRef, sha, check.targetSha, verified.target_sha);
    }
    exitStatus(`status: refused\n${res.stderr || res.stdout}`, 1);
  }
  if (AMBIGUOUS_LINE_RE.test(res.stderr)) {
    exitStatus(
      `status: landing-uncertain\nreason: push exited 0 with ambiguous ref warning: ${res.stderr}`,
      4,
      { rollback: false },
    );
  }
  clearRollback();
  process.stdout.write(`status: pushed\nsha: ${sha}\ntarget: ${target}\n`);
}

/** @param {CliOptions} opts */
function cmdConfirm(opts) {
  const dir = assertDir(opts.dir);
  const repo = assertRepo(opts.repo);
  const url = buildRepoUrl(repo, { ssh: opts.ssh, baseUrl: readTestBaseUrl() });
  const target = assertRef(opts.target, "--target");
  const sha = assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  // Never roll back inside confirm: a push may already have landed on origin.
  assertBareRepoClean(bareDir);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  const targetRef = `refs/heads/${target}`;
  const check = tryFetchAndCheckLanded(bareDir, targetRef, sha);
  if (!check.ok) {
    exitStatus(`status: landing-uncertain\nreason: ${check.error}`, 4, { rollback: false });
  }
  if (!check.landed) {
    fail(`stop: ${sha} is not an ancestor of ${targetRef} (${check.targetSha})`);
  }
  process.stdout.write(`status: confirmed\ntarget_sha: ${check.targetSha}\n`);
}

/** @param {CliOptions} opts */
function cmdCleanup(opts) {
  const dir = assertDir(opts.dir);
  if (!pathExistsIncludingSymlink(dir)) {
    process.stdout.write(`status: cleaned\ndir: ${dir}\n`);
    return;
  }
  if (!isScriptWorkdir(dir)) {
    fail(`stop: ${dir} was not created by direct-ship.mjs; refusing cleanup`);
  }
  rmSync(join(dir, "bare.git"), { recursive: true, force: true });
  rmSync(join(dir, "checks"), { recursive: true, force: true });
  rmSync(join(dir, VERIFIED_FILE), { force: true });
  rmSync(join(dir, WORKDIR_MARKER), { force: true });
  if (existsSync(dir) && readdirSync(dir).length === 0) {
    rmdirSync(dir);
  }
  process.stdout.write(`status: cleaned\ndir: ${dir}\n`);
}

/** @param {string[]} argv */
function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(
      "Usage: direct-ship.mjs <clone|verify|push|confirm|cleanup> [options]\n" +
        "  clone   --repo <owner>/<repo> [--dir <new-workdir>] [--ssh]\n" +
        "  verify  --repo <owner>/<repo> --dir <workdir> --target <branch> --branch <crew> --sha <40-hex> [--ssh]\n" +
        "  push    --repo <owner>/<repo> --dir <workdir> --target <branch> --sha <40-hex> [--ssh]\n" +
        "  confirm --repo <owner>/<repo> --dir <workdir> --target <branch> --sha <40-hex> [--ssh]\n" +
        "  cleanup --dir <workdir>\n",
    );
    return;
  }
  /** @type {CliOptions} */
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        dir: { type: "string" },
        target: { type: "string" },
        branch: { type: "string" },
        sha: { type: "string" },
        ssh: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`invalid arguments: ${msg}`);
  }
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

/** @returns {boolean} */
function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main(process.argv.slice(2));
}
