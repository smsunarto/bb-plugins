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
// Defense-in-depth checks on bare clones. `push` and `confirm` create brand-new ephemeral bare
// clones outside `<workdir>` so checks cannot tamper with them; these checks and the
// GIT_GRAFT_FILE / GIT_SHALLOW_FILE env pins remain as cheap defense in depth.
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

/** @typedef {{ repo: string; ssh: boolean }} WorkdirMarker */

/** @typedef {{ repo: string; ssh: boolean; sha: string; target: string; target_sha: string }} VerifiedState */

/**
 * @typedef {
 *   | { ok: true; landed: boolean; targetSha: string }
 *   | { ok: false; error: string }
 * } LandedCheckResult
 */

/** Paths registered by the running subcommand to remove if `fail()` stops before completion. */
/** @type {string | null} */
let rollbackWorkdir = null;
/** @type {Set<string>} */
const rollbackPaths = new Set();
/** Fresh mkdtemp dir created by `push` or `confirm`, removed on every exit except `landing-uncertain`. */
/** @type {string | null} */
let ephemeralDirToClean = null;

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
 * Read and validate `.captain-direct-ship-workdir` inside a non-symlink directory.
 * @param {string} dir
 * @returns {WorkdirMarker | null}
 */
function readWorkdirMarker(dir) {
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    const markerPath = join(dir, WORKDIR_MARKER);
    if (!lstatSync(markerPath).isFile()) return null;
    const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(markerPath, "utf8")));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("kind" in parsed) ||
      parsed.kind !== WORKDIR_MARKER_KIND ||
      !("repo" in parsed) ||
      !isValidRepo(parsed.repo) ||
      !("ssh" in parsed) ||
      typeof parsed.ssh !== "boolean"
    ) {
      return null;
    }
    return { repo: parsed.repo, ssh: parsed.ssh };
  } catch {
    return null;
  }
}

/**
 * Register paths inside a verified script-owned workdir for rollback on failure.
 * Never registers paths for a directory lacking a valid `WORKDIR_MARKER`.
 * @param {string} dir
 * @param {...string} paths
 */
function registerRollback(dir, ...paths) {
  if (readWorkdirMarker(dir) === null) {
    fail(`stop: ${dir} was not created by direct-ship.mjs; refusing to modify it`);
  }
  rollbackWorkdir = dir;
  for (const path of paths) rollbackPaths.add(path);
}

function clearRollback() {
  rollbackPaths.clear();
  rollbackWorkdir = null;
}

function cleanupEphemeralDir() {
  if (ephemeralDirToClean !== null) {
    rmSync(ephemeralDirToClean, { recursive: true, force: true });
    ephemeralDirToClean = null;
  }
}

function runRollback() {
  for (const path of rollbackPaths) {
    rmSync(path, { recursive: true, force: true });
  }
  rollbackPaths.clear();
  if (rollbackWorkdir !== null && existsSync(rollbackWorkdir)) {
    try {
      const remaining = readdirSync(rollbackWorkdir).filter((entry) => entry !== WORKDIR_MARKER);
      if (remaining.length === 0) {
        rmSync(join(rollbackWorkdir, WORKDIR_MARKER), { force: true });
        rmdirSync(rollbackWorkdir);
      }
    } catch {
      // Best-effort removal of an empty temp directory created by this script.
    }
  }
  rollbackWorkdir = null;
}

/**
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
function fail(message, code = 1) {
  cleanupEphemeralDir();
  runRollback();
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/**
 * Emit a structured `status:` block on stdout, optionally roll back, and exit.
 * @param {string} body
 * @param {number} code
 * @param {{ rollback?: boolean; keepEphemeral?: boolean }} [options]
 * @returns {never}
 */
function exitStatus(body, code, { rollback = true, keepEphemeral = false } = {}) {
  if (!keepEphemeral) cleanupEphemeralDir();
  if (rollback) runRollback();
  else clearRollback();
  process.stdout.write(`${body}\n`);
  process.exit(code);
}

/**
 * @param {string} targetSha
 * @returns {never}
 */
function exitAlreadyLanded(targetSha) {
  exitStatus(`status: already-landed\ntarget_sha: ${targetSha}`, 0, { rollback: false });
}

/**
 * @param {unknown} repo
 * @returns {repo is string}
 */
function isValidRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return false;
  const slash = repo.indexOf("/");
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  if (owner === "." || owner.includes("..")) return false;
  if (name === "." || name.includes("..")) return false;
  return !/\.git$/iu.test(name);
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
 * Escape C0/C1 control characters (< 0x20, 0x7f, 0x80-0x9f) and Unicode bidi overrides/isolates
 * (U+202A-U+202E, U+2066-U+2069) so commit subjects cannot disguise terminal output.
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
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += text.charAt(i);
    }
  }
  return out;
}

/**
 * @param {unknown} name
 * @param {string} flag
 * @returns {string}
 */
function assertRef(name, flag) {
  if (typeof name !== "string" || !REF_RE.test(name) || name.startsWith("-")) {
    fail(`invalid ${flag} ${JSON.stringify(name)}: invalid git branch ref name`);
  }
  const check = spawnGitSync(["check-ref-format", `refs/heads/${name}`]);
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
 * Strip only repo-pointing git env vars and pin GIT_GRAFT_FILE / GIT_SHALLOW_FILE to nonexistent
 * paths as defense in depth; preserve GIT_CONFIG_COUNT/KEY_n/VALUE_n for machine git credentials.
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
 * @param {{ trimStdout?: boolean }} [options]
 * @returns {GitResult}
 */
function spawnGitSync(args, { trimStdout = true } = {}) {
  const res = spawnSync("git", args, {
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
 * Run git while checking stderr even on exit 0 so git ambiguity lines stop the ship.
 * @param {readonly string[]} flags
 * @param {readonly string[]} args
 * @param {{ allowExit1?: boolean; trimStdout?: boolean }} [options]
 * @returns {{ ok: true; result: GitResult } | { ok: false; error: string }}
 */
function tryRunGitChecked(flags, args, { allowExit1 = false, trimStdout = true } = {}) {
  const result = spawnGitSync([...flags, ...args], { trimStdout });
  if (AMBIGUOUS_LINE_RE.test(result.stderr)) {
    return {
      ok: false,
      error: `stop: git reported ambiguous ref on ${args.join(" ")}: ${result.stderr}`,
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
 * @param {readonly string[]} flags
 * @param {readonly string[]} args
 * @param {{ allowExit1?: boolean; trimStdout?: boolean }} [options]
 * @returns {GitResult}
 */
function runGitChecked(flags, args, options) {
  const res = tryRunGitChecked(flags, args, options);
  if (!res.ok) fail(res.error);
  return res.result;
}

/**
 * Resolve `rev` inside `bareDir`, returning `null` if absent and an error if git emits an
 * ambiguity warning.
 * @param {string} bareDir
 * @param {string} rev
 * @returns {{ ok: true; sha: string | null } | { ok: false; error: string }}
 */
function tryRevParse(bareDir, rev) {
  const res = spawnGitSync([...BARE_FLAGS, "-C", bareDir, "rev-parse", "--verify", "--quiet", rev]);
  if (AMBIGUOUS_LINE_RE.test(res.stderr)) {
    return { ok: false, error: `stop: git warned about ambiguous ref on ${rev}: ${res.stderr}` };
  }
  return { ok: true, sha: res.status === 0 ? res.stdout : null };
}

/**
 * @param {string} bareDir
 * @param {string} rev
 * @returns {string | null}
 */
function revParseOptional(bareDir, rev) {
  const res = tryRevParse(bareDir, rev);
  if (!res.ok) fail(res.error);
  return res.sha;
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
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
function tryVerifyOriginUrls(repoDir, expectedUrl, flags) {
  for (const args of [
    ["-C", repoDir, "remote", "get-url", "--all", "origin"],
    ["-C", repoDir, "remote", "get-url", "--push", "--all", "origin"],
  ]) {
    const res = tryRunGitChecked(flags, args);
    if (!res.ok) return res;
    const lines = res.result.stdout === "" ? [] : res.result.stdout.split("\n");
    if (lines.length !== 1 || lines[0] !== expectedUrl) {
      return {
        ok: false,
        error: `stop: ${args.slice(2).join(" ")} in ${repoDir} returned ${JSON.stringify(lines)}, expected [${JSON.stringify(expectedUrl)}]`,
      };
    }
  }
  return { ok: true };
}

/**
 * @param {string} repoDir
 * @param {string} expectedUrl
 * @param {readonly string[]} flags
 */
function verifyOriginUrls(repoDir, expectedUrl, flags) {
  const res = tryVerifyOriginUrls(repoDir, expectedUrl, flags);
  if (!res.ok) fail(res.error);
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
 * Check `targetRef` in `bareDir` against exact `ls-remote` and whether `<sha>` is an ancestor of
 * it, optionally fetching `targetRef` first. Returns without exiting so post-push/confirm callers
 * can emit `status: landing-uncertain` without rolling back.
 * @param {string} bareDir
 * @param {string} targetRef
 * @param {string} sha
 * @param {{ fetchFirst: boolean }} options
 * @returns {LandedCheckResult}
 */
function tryCheckTargetAndLanded(bareDir, targetRef, sha, { fetchFirst }) {
  const bareProblem = findForbiddenBareState(bareDir);
  if (bareProblem !== null) return { ok: false, error: bareProblem };

  if (fetchFirst) {
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
  }

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

  const hasCommit = tryRevParse(bareDir, `${sha}^{commit}`);
  if (!hasCommit.ok) return hasCommit;
  if (hasCommit.sha === null) {
    return { ok: true, landed: false, targetSha: localTarget };
  }

  const landed = tryRunGitChecked(
    BARE_FLAGS,
    ["-C", bareDir, "merge-base", "--is-ancestor", sha, targetRef],
    { allowExit1: true },
  );
  if (!landed.ok) return landed;
  return { ok: true, landed: landed.result.status === 0, targetSha: localTarget };
}

/** @returns {string} */
function defaultTempParent() {
  const storage = process.env.BB_THREAD_STORAGE;
  return typeof storage === "string" && storage.trim() !== "" && existsSync(storage)
    ? storage
    : tmpdir();
}

/**
 * Create a brand-new workdir (via mkdtemp when `--dir` is omitted, or exclusive mkdir when provided)
 * and stamp it with `WORKDIR_MARKER` recording `{ repo, ssh }`.
 * @param {string | undefined} requestedDir
 * @param {string} repo
 * @param {boolean} ssh
 * @returns {{ dir: string; markerPath: string }}
 */
function createScriptWorkdir(requestedDir, repo, ssh) {
  /** @type {string} */
  let dir;
  if (requestedDir === undefined) {
    dir = realpathSync(mkdtempSync(join(defaultTempParent(), "captain-direct-ship-")));
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
  try {
    writeFileSync(
      markerPath,
      `${JSON.stringify({ kind: WORKDIR_MARKER_KIND, version: 1, repo, ssh })}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const msg = error instanceof Error ? error.message : String(error);
    fail(`stop: could not write workdir marker in ${dir}: ${msg}`);
  }
  registerRollback(dir);
  return { dir, markerPath };
}

/**
 * Create a brand-new bare blobless clone in a fresh mkdtemp directory outside `<workdir>`,
 * never touching `<workdir>/bare.git` or `<workdir>/checks`.
 * @param {string} repo
 * @param {string} url
 * @param {boolean} ssh
 * @returns {{ ok: true; dir: string; bareDir: string } | { ok: false; dir: string; error: string }}
 */
function tryCreateEphemeralBareClone(repo, url, ssh) {
  const dir = realpathSync(
    mkdtempSync(join(defaultTempParent(), "captain-direct-ship-ephemeral-")),
  );
  ephemeralDirToClean = dir;
  const markerPath = join(dir, WORKDIR_MARKER);
  writeFileSync(
    markerPath,
    `${JSON.stringify({ kind: WORKDIR_MARKER_KIND, version: 1, repo, ssh })}\n`,
    { flag: "wx" },
  );
  const bareDir = join(dir, "bare.git");
  const cloneRes = tryRunGitChecked(BARE_FLAGS, [
    "clone",
    "-q",
    "--bare",
    "--filter=blob:none",
    url,
    bareDir,
  ]);
  if (!cloneRes.ok) return { ok: false, dir, error: cloneRes.error };
  const bareProblem = findForbiddenBareState(bareDir);
  if (bareProblem !== null) return { ok: false, dir, error: bareProblem };
  const urlRes = tryVerifyOriginUrls(bareDir, url, BARE_FLAGS);
  if (!urlRes.ok) return { ok: false, dir, error: urlRes.error };
  return { ok: true, dir, bareDir };
}

/** @param {CliOptions} opts */
function cmdClone(opts) {
  const repo = assertRepo(opts.repo);
  const ssh = Boolean(opts.ssh);
  const url = buildRepoUrl(repo, { ssh, baseUrl: readTestBaseUrl() });
  const { dir } = createScriptWorkdir(opts.dir, repo, ssh);
  const bareDir = join(dir, "bare.git");
  registerRollback(dir, bareDir);
  runGitChecked(BARE_FLAGS, ["clone", "-q", "--bare", "--filter=blob:none", url, bareDir]);
  assertBareRepoClean(bareDir);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);
  clearRollback();
  process.stdout.write(`status: cloned\ndir: ${dir}\nurl: ${url}\nbare: ${bareDir}\n`);
}

/**
 * Format `git log -z --format=%h %s` output with control/bidi characters escaped.
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
  const ssh = Boolean(opts.ssh);
  const url = buildRepoUrl(repo, { ssh, baseUrl: readTestBaseUrl() });
  const target = assertRef(opts.target, "--target");
  const branch = assertRef(opts.branch, "--branch");
  const sha = assertSha(opts.sha);

  const bareDir = join(dir, "bare.git");
  const checksDir = join(dir, "checks");
  const verifiedPath = join(dir, VERIFIED_FILE);
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  if (existsSync(checksDir)) {
    fail(`stop: ${checksDir} already exists; run cleanup and re-clone from scratch`);
  }

  // Validate workdir ownership, --repo/--ssh against clone, and --target existence BEFORE
  // registering rollback so argument mistakes never delete the workdir.
  const marker = readWorkdirMarker(dir);
  if (marker === null) {
    fail(`stop: ${dir} was not created by direct-ship.mjs; refusing verify`);
  }
  if (marker.repo !== repo || marker.ssh !== ssh) {
    fail(
      `stop: verify (${repo}, ssh=${ssh}) does not match cloned workdir (${marker.repo}, ssh=${marker.ssh})`,
    );
  }

  const targetRef = `refs/heads/${target}`;
  const crewRef = `refs/heads/${branch}`;
  const localTarget = revParseOptional(bareDir, targetRef);
  if (localTarget === null) {
    fail(`stop: target branch ${targetRef} does not exist in ${bareDir}`);
  }

  registerRollback(dir, checksDir, verifiedPath, bareDir);
  assertBareRepoClean(bareDir);
  verifyOriginUrls(bareDir, url, BARE_FLAGS);

  // Check 1: target ref in bare clone matches exact ls-remote.
  const remoteTarget = exactLsRemote(bareDir, targetRef);
  if (remoteTarget === null || remoteTarget !== localTarget) {
    fail(
      `stop: target ${targetRef} mismatch (bare=${localTarget}, ls-remote=${remoteTarget ?? "missing"})`,
    );
  }

  // Check 2: already landed. Only run when `<sha>` exists in the bare clone; if the crew branch
  // was not pushed yet (and `<sha>` is not on target), Check 3 reports `crew-branch-missing`.
  const hasCommit = revParseOptional(bareDir, `${sha}^{commit}`);
  if (hasCommit !== null) {
    const alreadyLanded = runGitChecked(
      BARE_FLAGS,
      ["-C", bareDir, "merge-base", "--is-ancestor", sha, targetRef],
      { allowExit1: true },
    );
    if (alreadyLanded.status === 0) {
      exitAlreadyLanded(localTarget);
    }
  }

  // Check 3: crew branch exists on origin and in bare clone at exact `<sha>`.
  const remoteCrew = exactLsRemote(bareDir, crewRef);
  if (remoteCrew === null) {
    exitStatus(`status: crew-branch-missing\nref: ${crewRef}`, 2);
  }
  const localCrew = revParseOptional(bareDir, crewRef);
  if (localCrew === null) {
    exitStatus(`status: stale-clone\nref: ${crewRef}\nremote_sha: ${remoteCrew}`, 6);
  }
  if (localCrew !== sha || remoteCrew !== sha) {
    // If bare and origin agree on the crew tip, the clone is fresh and --sha was mistyped:
    // preserve the workdir so the caller can fix --sha or run cleanup.
    if (localCrew === remoteCrew) clearRollback();
    fail(`stop: ${crewRef} is not at ${sha} (bare=${localCrew}, ls-remote=${remoteCrew})`);
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

  // Check 5: commit list with control and bidi characters escaped.
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
    `${JSON.stringify({ repo, ssh, sha, target, target_sha: localTarget }, null, 2)}\n`,
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
    !("ssh" in parsed) ||
    !("sha" in parsed) ||
    !("target" in parsed) ||
    !("target_sha" in parsed) ||
    !isValidRepo(parsed.repo) ||
    typeof parsed.ssh !== "boolean" ||
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
    ssh: parsed.ssh,
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
  const hasCommit = revParseOptional(bareDir, `${sha}^{commit}`);
  if (hasCommit !== null) {
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
  }
  exitStatus(
    `status: not-fast-forward\ntarget_sha: ${currentTargetSha}\nverified_target_sha: ${verifiedTargetSha}`,
    3,
  );
}

/**
 * Validate workdir marker and `verified.json` before registering rollback or cloning, so
 * argument mistakes (`--repo`/`--ssh`/`--sha`/`--target`) or foreign directories stay untouched.
 * `verified.json` is an agent guardrail only: a mismatch stops, a match proves nothing about origin.
 * @param {string} dir
 * @param {string} repo
 * @param {boolean} ssh
 * @param {string} target
 * @param {string} sha
 * @returns {VerifiedState}
 */
function assertPushMatchesVerified(dir, repo, ssh, target, sha) {
  const bareDir = join(dir, "bare.git");
  if (!existsSync(bareDir)) fail(`stop: missing bare clone at ${bareDir}; run clone first`);
  const marker = readWorkdirMarker(dir);
  if (marker === null) {
    fail(`stop: ${dir} was not created by direct-ship.mjs; refusing push`);
  }
  const verified = readVerifiedState(dir);
  const mismatch =
    marker.repo !== repo ||
    marker.ssh !== ssh ||
    verified.repo !== repo ||
    verified.ssh !== ssh ||
    verified.sha !== sha ||
    verified.target !== target;
  if (mismatch) {
    fail(
      `stop: push (${repo}, ssh=${ssh}, ${target} @ ${sha}) does not match verified (${verified.repo}, ssh=${verified.ssh}, ${verified.target} @ ${verified.sha})`,
    );
  }
  return verified;
}

/** @param {CliOptions} opts */
function cmdPush(opts) {
  const dir = assertDir(opts.dir);
  const repo = assertRepo(opts.repo);
  const ssh = Boolean(opts.ssh);
  const url = buildRepoUrl(repo, { ssh, baseUrl: readTestBaseUrl() });
  const target = assertRef(opts.target, "--target");
  const sha = assertSha(opts.sha);

  const verified = assertPushMatchesVerified(dir, repo, ssh, target, sha);
  registerRollback(dir, join(dir, "checks"), join(dir, VERIFIED_FILE), join(dir, "bare.git"));

  // Create a brand-new bare clone outside `<workdir>`. Never read `<workdir>/bare.git` or
  // `<workdir>/checks` after checks ran.
  const fresh = tryCreateEphemeralBareClone(repo, url, ssh);
  if (!fresh.ok) fail(fresh.error);
  const freshBareDir = fresh.bareDir;

  const targetRef = `refs/heads/${target}`;
  const prePush = tryCheckTargetAndLanded(freshBareDir, targetRef, sha, { fetchFirst: false });
  if (!prePush.ok) {
    // We have not pushed yet; any failure here is a non-landing stop, never landing-uncertain.
    fail(prePush.error);
  }
  if (prePush.targetSha !== verified.target_sha) {
    if (prePush.landed) {
      exitAlreadyLanded(prePush.targetSha);
    }
    exitTargetMovedOrNotFf(freshBareDir, targetRef, sha, prePush.targetSha, verified.target_sha);
  }

  const res = spawnGitSync([
    ...BARE_FLAGS,
    "-C",
    freshBareDir,
    "push",
    "origin",
    `${sha}^{commit}:refs/heads/${target}`,
  ]);
  if (res.status !== 0) {
    const check = tryCheckTargetAndLanded(freshBareDir, targetRef, sha, { fetchFirst: true });
    if (!check.ok) {
      exitStatus(
        `status: landing-uncertain\nreason: ${check.error}\nephemeral_dir: ${fresh.dir}`,
        4,
        { rollback: false, keepEphemeral: true },
      );
    }
    if (check.landed) {
      exitAlreadyLanded(check.targetSha);
    }
    if (AMBIGUOUS_LINE_RE.test(res.stderr)) {
      fail(`stop: push failed with ambiguous ref: ${res.stderr}`);
    }
    if (NON_FF_RE.test(res.stderr)) {
      exitTargetMovedOrNotFf(freshBareDir, targetRef, sha, check.targetSha, verified.target_sha);
    }
    exitStatus(`status: refused\n${res.stderr || res.stdout}`, 1);
  }
  if (AMBIGUOUS_LINE_RE.test(res.stderr)) {
    exitStatus(
      `status: landing-uncertain\nreason: push exited 0 with ambiguous ref warning: ${res.stderr}\nephemeral_dir: ${fresh.dir}`,
      4,
      { rollback: false, keepEphemeral: true },
    );
  }
  cleanupEphemeralDir();
  clearRollback();
  process.stdout.write(`status: pushed\nsha: ${sha}\ntarget: ${target}\n`);
}

/** @param {CliOptions} opts */
function cmdConfirm(opts) {
  const repo = assertRepo(opts.repo);
  const ssh = Boolean(opts.ssh);
  const url = buildRepoUrl(repo, { ssh, baseUrl: readTestBaseUrl() });
  const target = assertRef(opts.target, "--target");
  const sha = assertSha(opts.sha);

  // Confirm never reads `<workdir>/bare.git` and never rolls back `<workdir>`: a push may already
  // have landed on origin. Every decision uses a brand-new bare clone outside `<workdir>`.
  const fresh = tryCreateEphemeralBareClone(repo, url, ssh);
  if (!fresh.ok) {
    exitStatus(
      `status: landing-uncertain\nreason: ${fresh.error}\nephemeral_dir: ${fresh.dir}`,
      4,
      { rollback: false, keepEphemeral: true },
    );
  }

  const targetRef = `refs/heads/${target}`;
  const check = tryCheckTargetAndLanded(fresh.bareDir, targetRef, sha, { fetchFirst: false });
  if (!check.ok) {
    exitStatus(
      `status: landing-uncertain\nreason: ${check.error}\nephemeral_dir: ${fresh.dir}`,
      4,
      { rollback: false, keepEphemeral: true },
    );
  }
  if (!check.landed) {
    fail(`stop: ${sha} is not an ancestor of ${targetRef} (${check.targetSha})`);
  }
  cleanupEphemeralDir();
  process.stdout.write(`status: confirmed\ntarget_sha: ${check.targetSha}\n`);
}

/** @param {CliOptions} opts */
function cmdCleanup(opts) {
  const dir = assertDir(opts.dir);
  if (!pathExistsIncludingSymlink(dir)) {
    process.stdout.write(`status: cleaned\ndir: ${dir}\n`);
    return;
  }
  if (readWorkdirMarker(dir) === null) {
    fail(`stop: ${dir} was not created by direct-ship.mjs; refusing cleanup`);
  }
  rmSync(join(dir, "bare.git"), { recursive: true, force: true });
  rmSync(join(dir, "checks"), { recursive: true, force: true });
  rmSync(join(dir, VERIFIED_FILE), { force: true });

  const remaining = readdirSync(dir)
    .filter((entry) => entry !== WORKDIR_MARKER)
    .sort();
  if (remaining.length > 0) {
    // Keep WORKDIR_MARKER so cleanup can be rerun after the extra entries are removed.
    process.stdout.write(
      `status: partially-cleaned\ndir: ${dir}\nremaining:\n${remaining.join("\n")}\n`,
    );
    return;
  }
  rmSync(join(dir, WORKDIR_MARKER), { force: true });
  rmdirSync(dir);
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
        "  confirm --repo <owner>/<repo> [--dir <workdir>] --target <branch> --sha <40-hex> [--ssh]\n" +
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
