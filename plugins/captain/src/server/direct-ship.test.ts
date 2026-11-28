import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import {
  buildRepoUrl,
  escapeControlChars,
  TEST_BASE_URL_ENV,
} from "../../skills/captain-ship/scripts/direct-ship.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(HERE, "../../skills/captain-ship/scripts/direct-ship.mjs");
const SKILL_PATH = resolve(HERE, "../../skills/captain-ship/SKILL.md");

const REPO_SLUG = "smsunarto/demo-repo";
const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

type RunResult = { status: number; stdout: string; stderr: string };

/** Clean environment for git and script subprocesses: strip inherited GIT_* hook vars and isolate global config. */
function cleanEnv(globalConfig: string, baseUrl?: string, storageDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && key !== TEST_BASE_URL_ENV && key !== "BB_THREAD_STORAGE") {
      env[key] = value;
    }
  }
  env["GIT_CONFIG_GLOBAL"] = globalConfig;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_TERMINAL_PROMPT"] = "0";
  if (baseUrl !== undefined) {
    env[TEST_BASE_URL_ENV] = baseUrl;
  }
  if (storageDir !== undefined) {
    env["BB_THREAD_STORAGE"] = storageDir;
  }
  return env;
}

function runGit(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean },
): RunResult {
  const res = spawnSync("git", args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  const result = {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`);
  }
  return result;
}

function runScript(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean; scriptPath?: string },
): RunResult {
  const res = spawnSync(process.execPath, [options.scriptPath ?? SCRIPT_PATH, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  const result = {
    status: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `direct-ship.mjs ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function runScriptAsync(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; allowFailure?: boolean; scriptPath?: string },
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [options.scriptPath ?? SCRIPT_PATH, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        status: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
      if (result.status !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `direct-ship.mjs ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
          ),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}

function findRealGit(): string {
  const res = spawnSync("which", ["git"], { encoding: "utf8" });
  if (res.error || res.status !== 0 || !res.stdout.trim()) {
    throw new Error("could not locate real git binary");
  }
  return res.stdout.trim();
}

/** Create an executable `git` shim directory prepended to `PATH` for simulating rare git failures. */
function makeGitShimEnv(
  root: string,
  name: string,
  env: NodeJS.ProcessEnv,
  body: string,
): NodeJS.ProcessEnv {
  const shimDir = join(root, `shim-${name}`);
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "git");
  writeFileSync(shimPath, `#!/bin/sh\nREAL_GIT=${JSON.stringify(findRealGit())}\n${body}\n`);
  chmodSync(shimPath, 0o755);
  return {
    ...env,
    PATH: `${shimDir}${delimiter}${env["PATH"] ?? ""}`,
  };
}

function parseField(stdout: string, key: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith(`${key}: `));
  if (!line) throw new Error(`missing ${key}: in output:\n${stdout}`);
  return line.slice(`${key}: `.length);
}

function listEphemeralDirs(storageDir: string): string[] {
  return readdirSync(storageDir).filter((name) =>
    name.startsWith("captain-direct-ship-ephemeral-"),
  );
}

/**
 * Unpack packs in `bareDir` and rewrite the loose commit object for `targetSha` to include
 * `parent <forgedParentSha>`, proving git's `merge-base --is-ancestor` trusts loose objects.
 */
function forgeLooseCommitParent(
  bareDir: string,
  targetSha: string,
  forgedParentSha: string,
  env: NodeJS.ProcessEnv,
): void {
  const packDir = join(bareDir, "objects", "pack");
  if (existsSync(packDir)) {
    for (const file of readdirSync(packDir)) {
      if (!file.endsWith(".pack")) continue;
      const packPath = join(packDir, file);
      const packBytes = readFileSync(packPath);
      rmSync(packPath);
      rmSync(packPath.replace(/\.pack$/u, ".idx"), { force: true });
      rmSync(packPath.replace(/\.pack$/u, ".rev"), { force: true });
      const unpack = spawnSync("git", ["--git-dir", bareDir, "unpack-objects"], {
        input: packBytes,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (unpack.status !== 0) {
        throw new Error(`git unpack-objects failed: ${unpack.stderr.toString()}`);
      }
    }
  }
  const loosePath = join(bareDir, "objects", targetSha.slice(0, 2), targetSha.slice(2));
  const raw = inflateSync(readFileSync(loosePath));
  const nul = raw.indexOf(0);
  const body = raw.subarray(nul + 1).toString("utf8");
  const lines = body.split("\n");
  // Insert `parent <forgedParentSha>` right after the `tree ` header line.
  lines.splice(1, 0, `parent ${forgedParentSha}`);
  const forgedBody = Buffer.from(lines.join("\n"), "utf8");
  const forgedObj = Buffer.concat([Buffer.from(`commit ${forgedBody.length}\0`), forgedBody]);
  chmodSync(loosePath, 0o644);
  writeFileSync(loosePath, deflateSync(forgedObj));
}

/**
 * Write a `commit-graph` in `bareDir` and patch `targetSha`'s first parent entry in the CDAT
 * chunk to point at `forgedParentSha`, then recompute the trailing SHA-1 checksum.
 */
function forgeCommitGraphParent(
  bareDir: string,
  targetSha: string,
  forgedParentSha: string,
  env: NodeJS.ProcessEnv,
): void {
  runGit(["--git-dir", bareDir, "commit-graph", "write", "--reachable"], { env });
  const graphPath = join(bareDir, "objects", "info", "commit-graph");
  const buf = Buffer.from(readFileSync(graphPath));
  const numChunks = buf.readUInt8(6);
  let oidLookupOff = -1;
  let oidLookupEnd = -1;
  let cdatOff = -1;
  for (let i = 0; i < numChunks; i += 1) {
    const entryOff = 8 + i * 12;
    const id = buf.subarray(entryOff, entryOff + 4).toString("ascii");
    const off = Number(buf.readBigUInt64BE(entryOff + 4));
    const nextOff = Number(buf.readBigUInt64BE(entryOff + 12 + 4));
    if (id === "OIDL") {
      oidLookupOff = off;
      oidLookupEnd = nextOff;
    } else if (id === "CDAT") {
      cdatOff = off;
    }
  }
  if (oidLookupOff < 0 || cdatOff < 0) {
    throw new Error("missing OIDL or CDAT chunk in commit-graph");
  }
  const commitCount = (oidLookupEnd - oidLookupOff) / 20;
  let targetIdx = -1;
  let parentIdx = -1;
  for (let i = 0; i < commitCount; i += 1) {
    const hex = buf.subarray(oidLookupOff + i * 20, oidLookupOff + (i + 1) * 20).toString("hex");
    if (hex === targetSha) targetIdx = i;
    if (hex === forgedParentSha) parentIdx = i;
  }
  if (targetIdx < 0 || parentIdx < 0) {
    throw new Error(`commits not found in commit-graph (target=${targetIdx}, parent=${parentIdx})`);
  }
  // Each CDAT entry is 36 bytes: 20-byte tree OID, 4-byte parent1, 4-byte parent2, 8-byte gen/time.
  buf.writeUInt32BE(parentIdx, cdatOff + targetIdx * 36 + 20);
  // Set generation >= 2 (top 30 bits of the 8-byte gen+time field) so git accepts the parent edge.
  const genTimeOff = cdatOff + targetIdx * 36 + 28;
  const orig = buf.readBigUInt64BE(genTimeOff);
  const patched = (orig & ((1n << 34n) - 1n)) | (10n << 34n);
  buf.writeBigUInt64BE(patched, genTimeOff);
  const digest = createHash("sha1")
    .update(buf.subarray(0, buf.length - 20))
    .digest();
  digest.copy(buf, buf.length - 20);
  chmodSync(graphPath, 0o644);
  writeFileSync(graphPath, buf);
}

/** Create a bare origin served over `file://` (with partial-clone filtering enabled) and a crew clone with one base commit. */
function setupScratchRepo() {
  // Resolve symlinks on the temp root so `$PWD` logged by local hooks matches `originDir`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "captain-direct-ship-")));
  roots.push(root);
  const storageDir = join(root, "storage");
  mkdirSync(storageDir);
  const globalConfig = join(root, "global.gitconfig");
  writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");

  const remotesRoot = join(root, "remotes");
  const originDir = join(remotesRoot, `${REPO_SLUG}.git`);
  mkdirSync(dirname(originDir), { recursive: true });
  const baseUrl = `file://${remotesRoot}`;
  const originUrl = `${baseUrl}/${REPO_SLUG}.git`;
  const env = cleanEnv(globalConfig, baseUrl, storageDir);
  const crewDir = join(root, "crew");

  runGit(["init", "--bare", "-b", "main", originDir], { env });
  runGit(["--git-dir", originDir, "config", "uploadpack.allowFilter", "true"], { env });
  runGit(["clone", originUrl, crewDir], { env });

  writeFileSync(join(crewDir, "README.md"), "base\n");
  runGit(["add", "README.md"], { cwd: crewDir, env });
  runGit(["commit", "-m", "base"], { cwd: crewDir, env });
  runGit(["push", "-u", "origin", "main"], { cwd: crewDir, env });
  const base = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

  return {
    root,
    storageDir,
    globalConfig,
    env,
    remotesRoot,
    baseUrl,
    originDir,
    originUrl,
    crewDir,
    base,
  };
}

describe("captain-ship direct-ship script", () => {
  test("SKILL.md documents script, status table, caveats, and buildRepoUrl constructs GitHub URLs from --repo alone", () => {
    const skill = readFileSync(SKILL_PATH, "utf8");
    expect(skill).toContain("<skill-dir>/scripts/direct-ship.mjs");
    expect(skill).toContain("status: stale-clone");
    expect(skill).toContain("status: target-moved");
    expect(skill).toContain("status: landing-uncertain");
    expect(skill).toContain("status: partially-cleaned");
    expect(skill).toContain("replacing any existing `Repo:` lines");
    expect(skill).toContain("machine git credentials");
    expect(skill).toContain("stop after `status: ready`");
    expect(skill).toContain("never trust `<workdir>/bare.git` or `<workdir>/checks`");
    expect(skill).toContain("from outside `<workdir>`");

    expect(buildRepoUrl("smsunarto/bb-plugins")).toBe(
      "https://github.com/smsunarto/bb-plugins.git",
    );
    expect(buildRepoUrl("smsunarto/.github")).toBe("https://github.com/smsunarto/.github.git");
    expect(buildRepoUrl("smsunarto/bb-plugins", { ssh: true })).toBe(
      "git@github.com:smsunarto/bb-plugins.git",
    );
  });

  test("CLI rejects --base-url, omits it from --help, and enforces tightened --repo and git check-ref-format ref validation", () => {
    const { root, env } = setupScratchRepo();

    const help = runScript(["--help"], { env });
    expect(help.stdout).not.toContain("--base-url");

    const baseUrlFlag = runScript(
      ["clone", "--repo", REPO_SLUG, "--base-url", "file:///tmp", "--dir", join(root, "w")],
      { env, allowFailure: true },
    );
    expect(baseUrlFlag.status).not.toBe(0);
    expect(baseUrlFlag.stderr).toContain("--base-url");

    for (const badRepo of [
      "../demo",
      "smsunarto/..",
      "smsunarto/a..b",
      "./demo",
      "smsunarto/.",
      "smsunarto/demo.git",
      "smsunarto/demo.GIT",
      "smsunarto/.git",
    ]) {
      const res = runScript(["clone", "--repo", badRepo, "--dir", join(root, "bad-repo")], {
        env,
        allowFailure: true,
      });
      expect(res.status, `expected ${badRepo} to be rejected`).not.toBe(0);
      expect(res.stderr).toContain("invalid --repo");
    }

    const validSha = "a".repeat(40);
    // Leading `-` is rejected before git check-ref-format; all other git-invalid names must hit git check-ref-format.
    const leadingDash = runScript(
      [
        "verify",
        "--repo",
        REPO_SLUG,
        "--dir",
        join(root, "nonexistent"),
        "--target=-leading",
        "--branch",
        "crew",
        "--sha",
        validSha,
      ],
      { env, allowFailure: true },
    );
    expect(leadingDash.status).not.toBe(0);
    expect(leadingDash.stderr).toContain("invalid --target");

    for (const badRef of [
      "a//b",
      "x.lock",
      "a/x.lock/b",
      ".hidden",
      "a/.hidden",
      "trailing.",
      "a..b",
      "/leading",
      "trailing/",
    ]) {
      const res = runScript(
        [
          "verify",
          "--repo",
          REPO_SLUG,
          "--dir",
          join(root, "nonexistent"),
          `--target=${badRef}`,
          "--branch",
          "crew",
          "--sha",
          validSha,
        ],
        { env, allowFailure: true },
      );
      expect(res.status, `expected ref ${badRef} to be rejected`).not.toBe(0);
      expect(res.stderr).toContain("rejected by git check-ref-format");
    }
  });

  test("clone creates a temp workdir via mkdtemp, refuses existing dirs, and cleanup keeps marker when extra files remain", () => {
    const { root, storageDir, env, crewDir } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "m.txt"), "ok\n");
    runGit(["add", "m.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: mkdtemp"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Omitting --dir creates a fresh directory under BB_THREAD_STORAGE and prints `dir: <workdir>`.
    const cloned = runScript(["clone", "--repo", REPO_SLUG], { env });
    expect(cloned.stdout).toContain("status: cloned");
    const autoDir = parseField(cloned.stdout, "dir");
    expect(autoDir.startsWith(storageDir)).toBe(true);
    expect(existsSync(join(autoDir, "bare.git"))).toBe(true);

    runScript(
      [
        "verify",
        "--repo",
        REPO_SLUG,
        "--dir",
        autoDir,
        "--target",
        "main",
        "--branch",
        "crew",
        "--sha",
        sha,
      ],
      { env },
    );

    // Extra file in workdir: cleanup removes clones, preserves marker, prints status: partially-cleaned
    // and lists the remaining entry so a second cleanup works after removing it.
    writeFileSync(join(autoDir, "extra.log"), "kept\n");
    const partial = runScript(["cleanup", "--dir", autoDir], { env });
    expect(partial.stdout).toContain("status: partially-cleaned");
    expect(partial.stdout).toContain("extra.log");
    expect(existsSync(join(autoDir, "bare.git"))).toBe(false);
    expect(existsSync(join(autoDir, "checks"))).toBe(false);
    expect(existsSync(join(autoDir, "verified.json"))).toBe(false);
    expect(existsSync(join(autoDir, ".captain-direct-ship-workdir"))).toBe(true);

    rmSync(join(autoDir, "extra.log"));
    const finalClean = runScript(["cleanup", "--dir", autoDir], { env });
    expect(finalClean.stdout).toContain("status: cleaned");
    expect(existsSync(autoDir)).toBe(false);

    // Idempotent cleanup on an already-removed dir succeeds without error.
    expect(runScript(["cleanup", "--dir", autoDir], { env }).stdout).toContain("status: cleaned");

    // Pre-existing empty dir is refused by clone and untouched by cleanup.
    const existingEmpty = join(root, "preexisting-empty");
    mkdirSync(existingEmpty);
    const cloneExisting = runScript(["clone", "--repo", REPO_SLUG, "--dir", existingEmpty], {
      env,
      allowFailure: true,
    });
    expect(cloneExisting.status).not.toBe(0);
    expect(cloneExisting.stderr).toContain("already exists");
    expect(existsSync(existingEmpty)).toBe(true);

    const cleanupEmpty = runScript(["cleanup", "--dir", existingEmpty], {
      env,
      allowFailure: true,
    });
    expect(cleanupEmpty.status).not.toBe(0);
    expect(cleanupEmpty.stderr).toContain("was not created by direct-ship.mjs");
    expect(existsSync(existingEmpty)).toBe(true);

    // Foreign directory with bare.git and checks/ (no marker): refused by clone, verify, push, and cleanup,
    // and rollback never removes its bare.git.
    const foreignDir = join(root, "foreign-project");
    mkdirSync(join(foreignDir, "checks"), { recursive: true });
    mkdirSync(join(foreignDir, "bare.git"), { recursive: true });
    writeFileSync(join(foreignDir, "checks", "keep.txt"), "important\n");
    writeFileSync(
      join(foreignDir, "verified.json"),
      JSON.stringify({ repo: REPO_SLUG, ssh: false, sha, target: "main", target_sha: sha }),
    );
    expect(
      runScript(["clone", "--repo", REPO_SLUG, "--dir", foreignDir], { env, allowFailure: true })
        .status,
    ).not.toBe(0);
    expect(
      runScript(
        ["push", "--repo", REPO_SLUG, "--dir", foreignDir, "--target", "main", "--sha", sha],
        {
          env,
          allowFailure: true,
        },
      ).status,
    ).not.toBe(0);
    rmSync(join(foreignDir, "checks"), { recursive: true });
    expect(
      runScript(
        [
          "verify",
          "--repo",
          REPO_SLUG,
          "--dir",
          foreignDir,
          "--target",
          "main",
          "--branch",
          "crew",
          "--sha",
          sha,
        ],
        { env, allowFailure: true },
      ).status,
    ).not.toBe(0);
    expect(existsSync(join(foreignDir, "bare.git"))).toBe(true);
    const cleanupForeign = runScript(["cleanup", "--dir", foreignDir], { env, allowFailure: true });
    expect(cleanupForeign.status).not.toBe(0);
    expect(existsSync(join(foreignDir, "bare.git"))).toBe(true);

    // A symlink pointing at a real script workdir is also refused by cleanup.
    const realWorkdir = join(root, "real-workdir");
    runScript(["clone", "--repo", REPO_SLUG, "--dir", realWorkdir], { env });
    const symlinkWorkdir = join(root, "symlink-workdir");
    symlinkSync(realWorkdir, symlinkWorkdir);
    const cleanupLink = runScript(["cleanup", "--dir", symlinkWorkdir], {
      env,
      allowFailure: true,
    });
    expect(cleanupLink.status).not.toBe(0);
    expect(existsSync(join(realWorkdir, "bare.git"))).toBe(true);
    runScript(["cleanup", "--dir", realWorkdir], { env });
    expect(existsSync(realWorkdir)).toBe(false);
  });

  test("the script's bare blobless clone excludes refs/replace while --mirror imports it", () => {
    const { root, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "feature.ts"), "export const ok = 1;\n");
    runGit(["add", "feature.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: feature"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    runGit(["checkout", "-b", "evil-branch", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "backdoor.ts"), "export const evil = true;\n");
    runGit(["add", "backdoor.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: feature"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${evil}:refs/replace/${sha}`], { cwd: crewDir, env });
    expect(
      runGit(["--git-dir", originDir, "for-each-ref", "refs/replace"], { env }).stdout,
    ).toContain(`refs/replace/${sha}`);

    const workdir = join(root, "ship-run");
    runScript(["clone", "--repo", REPO_SLUG, "--dir", workdir], { env });
    const bareDir = join(workdir, "bare.git");

    // Confirm the blobless clone actually omitted blobs from its pack.
    const missingBlobs = runGit(
      ["--git-dir", bareDir, "rev-list", "--objects", "--all", "--missing=print"],
      { env },
    )
      .stdout.split("\n")
      .filter((line) => line.startsWith("?"));
    expect(missingBlobs.length).toBeGreaterThan(0);

    expect(runGit(["-C", bareDir, "for-each-ref", "refs/replace"], { env }).stdout).toBe("");
    expect(
      runGit(["-C", bareDir, "config", "--get-all", "remote.origin.fetch"], {
        env,
        allowFailure: true,
      }).stdout,
    ).toBe("");
    expect(runGit(["-C", bareDir, "rev-parse", "--is-shallow-repository"], { env }).stdout).toBe(
      "false",
    );

    // Control: --mirror imports refs/replace/* from origin, which is why the script never uses it.
    const mirrorDir = join(root, "mirror.git");
    runGit(["clone", "--mirror", originUrl, mirrorDir], { env });
    expect(runGit(["-C", mirrorDir, "for-each-ref", "refs/replace"], { env }).stdout).toContain(
      `refs/replace/${sha}`,
    );

    runScript(["cleanup", "--dir", workdir], { env });
    expect(existsSync(workdir)).toBe(false);
  });

  test("rewritten crew fetch refspec and annotated tag replace ref cannot hijack direct ship end to end", () => {
    const { root, storageDir, env, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "feature.ts"), "export const ok = 1;\n");
    runGit(["add", "feature.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: add feature"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Crew pushes an annotated tag `rep/<sha>` pointing at an unreviewed commit and adds a fetch refspec.
    runGit(["checkout", "-b", "evil-work", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "backdoor.ts"), "export const pwn = true;\n");
    runGit(["add", "backdoor.ts"], { cwd: crewDir, env });
    runGit(["commit", "-m", "evil commit"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["tag", "-a", `rep/${sha}`, "-m", "hide", evil], { cwd: crewDir, env });
    runGit(["push", "origin", `refs/tags/rep/${sha}`], { cwd: crewDir, env });
    runGit(["tag", "-d", `rep/${sha}`], { cwd: crewDir, env });
    runGit(["checkout", "crew"], { cwd: crewDir, env });
    runGit(["branch", "-D", "evil-work"], { cwd: crewDir, env });
    runGit(["config", "--add", "remote.origin.fetch", "+refs/tags/rep/*:refs/replace/*"], {
      cwd: crewDir,
      env,
    });
    runGit(["fetch", "origin"], { cwd: crewDir, env });
    expect(runGit(["rev-parse", `${sha}^{commit}`], { cwd: crewDir, env }).stdout).toBe(evil);

    // Run every subcommand of direct-ship.mjs end to end.
    const workdir = join(root, "ship-h1");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(verified.stdout).toContain("status: ready");
    expect(verified.stdout).toContain("task: add feature");
    expect(verified.stdout).not.toContain("evil commit");

    // Checks clone holds the reviewed file, not the backdoor.
    const checksDir = join(workdir, "checks");
    expect(existsSync(join(checksDir, "feature.ts"))).toBe(true);
    expect(existsSync(join(checksDir, "backdoor.ts"))).toBe(false);

    const pushed = runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    expect(pushed.stdout).toContain("status: pushed");
    expect(listEphemeralDirs(storageDir)).toEqual([]);

    const confirmed = runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });
    expect(confirmed.stdout).toContain("status: confirmed");
    expect(confirmed.stdout).toContain(`target_sha: ${sha}`);
    expect(listEphemeralDirs(storageDir)).toEqual([]);

    runScript(["cleanup", "--dir", workdir], { env });
    expect(existsSync(workdir)).toBe(false);

    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
  });

  test("a remote branch literally named <sha> stops on ambiguous warning, and ^{commit} still lands <sha> if warnings are off", () => {
    const { root, globalConfig, env, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "ok.txt"), "ok\n");
    runGit(["add", "ok.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: ok"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    writeFileSync(join(crewDir, "evil.txt"), "evil\n");
    runGit(["add", "evil.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "evil"], { cwd: crewDir, env });
    const evil = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${evil}:refs/heads/${sha}`], { cwd: crewDir, env });

    // Default config: git emits an `ambiguous` warning and the script stops before pushing.
    const workdir1 = join(root, "ship-ambig");
    const common1 = ["--repo", REPO_SLUG, "--dir", workdir1];
    runScript(["clone", ...common1], { env });
    const stopped = runScript(
      ["verify", ...common1, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(stopped.status).not.toBe(0);
    expect(stopped.stderr).toMatch(/ambiguous/iu);
    runScript(["cleanup", "--dir", workdir1], { env });

    // Even if ambiguity warnings are suppressed in global config, `^{commit}` resolves `<sha>` as an object.
    writeFileSync(
      globalConfig,
      "[user]\n\tname = Test\n\temail = test@example.com\n[core]\n\twarnAmbiguousRefs = false\n[advice]\n\tobjectNameWarning = false\n",
    );
    const workdir2 = join(root, "ship-peel");
    const common2 = ["--repo", REPO_SLUG, "--dir", workdir2];
    runScript(["clone", ...common2], { env });
    runScript(["verify", ...common2, "--target", "main", "--branch", "crew", "--sha", sha], {
      env,
    });
    runScript(["push", ...common2, "--target", "main", "--sha", sha], { env });
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );

    // Control: pushing bare `<sha>` (without `^{commit}`) from the bare clone resolves refs/heads/<sha> and lands EVIL.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    runGit(
      [
        "--no-replace-objects",
        "-C",
        join(workdir2, "bare.git"),
        "push",
        "origin",
        `${sha}:refs/heads/main`,
      ],
      { env },
    );
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      evil,
    );
    runScript(["cleanup", "--dir", workdir2], { env });
  });

  test("a shallow file in the crew repo cannot hide a side-branch commit from verify's commit list", () => {
    const { root, env, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "side", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "e1.txt"), "hidden\n");
    runGit(["add", "e1.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "E1 hidden"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "e2.txt"), "e2\n");
    runGit(["add", "e2.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "E2 tip"], { cwd: crewDir, env });
    const e2 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

    runGit(["checkout", "-b", "crew", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "c1.txt"), "c1\n");
    runGit(["add", "c1.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "C1 task"], { cwd: crewDir, env });
    runGit(["merge", "--no-ff", "side", "-m", "M merge"], { cwd: crewDir, env });
    const mergeSha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Confirm the shallow boundary hides E1 in the crew repo.
    const shallowPath = runGit(["rev-parse", "--git-path", "shallow"], {
      cwd: crewDir,
      env,
    }).stdout;
    writeFileSync(join(crewDir, shallowPath), `${e2}\n`);
    const crewLog = runGit(["log", "--format=%s", `refs/remotes/origin/main..${mergeSha}`], {
      cwd: crewDir,
      env,
    }).stdout.split("\n");
    expect(crewLog).not.toContain("E1 hidden");

    // direct-ship.mjs verify lists all four commits including E1.
    const workdir = join(root, "ship-shallow");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", mergeSha],
      { env },
    );
    for (const subject of ["M merge", "C1 task", "E2 tip", "E1 hidden"]) {
      expect(verified.stdout).toContain(subject);
    }
    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("commit subjects escape C0/C1 controls and Unicode bidi overrides/isolates", () => {
    expect(escapeControlChars("ok\t\r\n\x00\x07\x1b[31m\x7f\u009b31m\u202e\u2066\u2069")).toBe(
      "ok\\t\\r\\n\\x00\\x07\\x1b[31m\\x7f\\x9b31m\\u202e\\u2066\\u2069",
    );

    const { root, env, crewDir } = setupScratchRepo();
    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "ctrl.txt"), "ctrl\n");
    runGit(["add", "ctrl.txt"], { cwd: crewDir, env });
    const msgFile = join(root, "ctrl-msg.txt");
    writeFileSync(msgFile, "hidden unreviewed\rtask \x1b[31m\x07\x7f\u009b31m\u202erev\u2066iso");
    runGit(["commit", "--cleanup=verbatim", "-F", msgFile], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    const workdir = join(root, "ship-ctrl");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(verified.stdout).toContain(
      "hidden unreviewed\\rtask \\x1b[31m\\x07\\x7f\\x9b31m\\u202erev\\u2066iso",
    );
    const hasRawUnsafe = Array.from(verified.stdout).some((ch) => {
      const code = ch.charCodeAt(0);
      return (
        (code < 0x20 && code !== 0x0a) ||
        code === 0x7f ||
        (code >= 0x80 && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    });
    expect(hasRawUnsafe).toBe(false);
    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("exact ls-remote matching defeats a decoy a/refs/heads/main branch before and after push", () => {
    const { root, env, originUrl, crewDir } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "work.txt"), "work\n");
    runGit(["add", "work.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: work"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });
    runGit(["push", "origin", `${sha}:refs/heads/a/refs/heads/main`], { cwd: crewDir, env });

    // Unfiltered ls-remote returns 2 lines for `refs/heads/main`.
    expect(
      runGit(["ls-remote", originUrl, "refs/heads/main"], { env }).stdout.split("\n"),
    ).toHaveLength(2);

    const workdir = join(root, "ship-ls-remote");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });
    expect(
      runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], {
        env,
      }).stdout,
    ).toContain("status: ready");
    runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    const confirmed = runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });
    expect(confirmed.stdout).toContain("status: confirmed");
    expect(confirmed.stdout).toContain(`target_sha: ${sha}`);
    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("global core.hooksPath and core.fsmonitor scripts do not fire during script runs, while controls fire both", () => {
    const { root, globalConfig, env, originDir, originUrl, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "a.txt"), "a\n");
    runGit(["add", "a.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: a"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    const hooksDir = join(root, "hooks");
    const hookLog = join(root, "hooks.log");
    const fsmLog = join(root, "fsmonitor.log");
    const fsmScript = join(root, "fsmonitor.sh");
    mkdirSync(hooksDir);
    for (const name of [
      "pre-push",
      "post-checkout",
      "post-index-change",
      "reference-transaction",
    ]) {
      const hookPath = join(hooksDir, name);
      writeFileSync(hookPath, `#!/bin/sh\necho "${name}:$PWD" >> "${hookLog}"\n`);
      chmodSync(hookPath, 0o755);
    }
    writeFileSync(fsmScript, `#!/bin/sh\necho "fsmonitor:$PWD" >> "${fsmLog}"\nprintf '/\\0'\n`);
    chmodSync(fsmScript, 0o755);

    writeFileSync(
      globalConfig,
      [
        "[user]",
        "\tname = Test",
        "\temail = test@example.com",
        "[core]",
        `\thooksPath = ${hooksDir}`,
        `\tfsmonitor = ${fsmScript}`,
        "\tfsmonitorHookVersion = 1",
        "",
      ].join("\n"),
    );

    const workdir = join(root, "ship-hooks");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });
    runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], { env });

    const bareDir = join(workdir, "bare.git");

    runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });

    // Exclude origin's own local receive-pack lines (which fire only because the test pushes over `file://`).
    const readClientHookLogs = () =>
      existsSync(hookLog)
        ? readFileSync(hookLog, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line !== "" && !line.endsWith(`:${originDir}`))
        : [];
    const readFsmLogs = () =>
      existsSync(fsmLog)
        ? readFileSync(fsmLog, "utf8")
            .trim()
            .split("\n")
            .filter((line) => line !== "")
        : [];

    expect(readClientHookLogs()).toEqual([]);
    expect(readFsmLogs()).toEqual([]);

    // Control without the script's `-c` overrides: clone, checkout, and push fire hooks and fsmonitor.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    const controlClone = join(root, "control-checks");
    runGit(["clone", "--no-checkout", originUrl, controlClone], { env });
    runGit(["-C", controlClone, "checkout", "--detach", `${sha}^{commit}`], { env });
    runGit(["-C", bareDir, "push", "origin", `${sha}^{commit}:refs/heads/main`], { env });

    const firedHooks = readClientHookLogs();
    expect(firedHooks.some((line) => line.startsWith("post-checkout:"))).toBe(true);
    expect(firedHooks.some((line) => line.startsWith("reference-transaction:"))).toBe(true);
    expect(firedHooks.some((line) => line.startsWith("pre-push:"))).toBe(true);
    expect(readFsmLogs().some((line) => line.startsWith(`fsmonitor:${controlClone}`))).toBe(true);

    runScript(["cleanup", "--dir", workdir], { env });
  });

  test("crew repo includeIf pushurl is ignored; global insteadOf, pushInsteadOf, multi-line push URLs, and post-verify push URL changes are refused", () => {
    const { root, storageDir, globalConfig, env, originDir, originUrl, crewDir, base } =
      setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "item.txt"), "item\n");
    runGit(["add", "item.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: item"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Decoy bare repo that worktree-scoped includeIf redirects pushurl to.
    const evilOriginDir = join(root, "evil-origin.git");
    runGit(["init", "--bare", "-b", "main", evilOriginDir], { env });
    const includeFile = join(root, "worktree-override.gitconfig");
    writeFileSync(includeFile, `[remote "origin"]\n\tpushurl = file://${evilOriginDir}\n`);

    runGit(["config", "includeIf.gitdir:**/worktrees/**.path", includeFile], {
      cwd: crewDir,
      env,
    });

    // Confirm a linked worktree under `worktrees/` actually inherits the redirected pushurl.
    const worktreesParent = join(root, "worktrees");
    mkdirSync(worktreesParent);
    const linkedWt = join(worktreesParent, "ship-wt");
    runGit(["worktree", "add", "--detach", linkedWt, sha], { cwd: crewDir, env });
    expect(
      runGit(["-C", linkedWt, "remote", "get-url", "--push", "--all", "origin"], { env }).stdout,
    ).toBe(`file://${evilOriginDir}`);

    // Running the script even from inside the poisoned crew repo ignores its config and lands on real origin.
    const workdir = join(root, "ship-isolated");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { cwd: linkedWt, env });
    runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], {
      cwd: linkedWt,
      env,
    });
    runScript(["push", ...common, "--target", "main", "--sha", sha], { cwd: linkedWt, env });
    runScript(["confirm", ...common, "--target", "main", "--sha", sha], { cwd: linkedWt, env });
    runScript(["cleanup", "--dir", workdir], { cwd: linkedWt, env });

    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
    expect(
      runGit(["--git-dir", evilOriginDir, "rev-parse", "--verify", "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).not.toBe(0);

    // Reset main for URL guard checks.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });

    // 1. Global `insteadOf` paired with identity `pushInsteadOf`: fails `get-url --all`.
    writeFileSync(
      globalConfig,
      [
        "[user]",
        "\tname = Test",
        "\temail = test@example.com",
        `[url "file://${evilOriginDir}"]`,
        `\tinsteadOf = ${originUrl}`,
        `[url "${originUrl}"]`,
        `\tpushInsteadOf = ${originUrl}`,
        "",
      ].join("\n"),
    );
    const workdirRewritten = join(root, "ship-rewritten");
    const rejected = runScript(["clone", "--repo", REPO_SLUG, "--dir", workdirRewritten], {
      env,
      allowFailure: true,
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("remote get-url --all origin");
    expect(existsSync(workdirRewritten)).toBe(false);

    // 2. Global `pushInsteadOf` alone (fetch URL still matches originUrl): fails `get-url --push --all`.
    writeFileSync(
      globalConfig,
      [
        "[user]",
        "\tname = Test",
        "\temail = test@example.com",
        `[url "file://${evilOriginDir}"]`,
        `\tpushInsteadOf = ${originUrl}`,
        "",
      ].join("\n"),
    );
    const workdirPushRewrite = join(root, "ship-push-rewritten");
    const rejectedPushUrl = runScript(["clone", "--repo", REPO_SLUG, "--dir", workdirPushRewrite], {
      env,
      allowFailure: true,
    });
    expect(rejectedPushUrl.status).not.toBe(0);
    expect(rejectedPushUrl.stderr).toContain("remote get-url --push --all origin");
    expect(existsSync(workdirPushRewrite)).toBe(false);

    // Restore clean global config for multi-line push URL and push-time URL re-check tests.
    writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.com\n");

    // 3. Multi-line `get-url --push --all` where line 0 still equals originUrl: fails the one-line rule.
    const workdirMultiUrl = join(root, "ship-multi-url");
    runScript(["clone", "--repo", REPO_SLUG, "--dir", workdirMultiUrl], { env });
    runGit(
      [
        "-C",
        join(workdirMultiUrl, "bare.git"),
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        originUrl,
      ],
      { env },
    );
    runGit(
      [
        "-C",
        join(workdirMultiUrl, "bare.git"),
        "remote",
        "set-url",
        "--add",
        "--push",
        "origin",
        `file://${evilOriginDir}`,
      ],
      { env },
    );
    const rejectedMulti = runScript(
      [
        "verify",
        "--repo",
        REPO_SLUG,
        "--dir",
        workdirMultiUrl,
        "--target",
        "main",
        "--branch",
        "crew",
        "--sha",
        sha,
      ],
      { env, allowFailure: true },
    );
    expect(rejectedMulti.status).not.toBe(0);
    expect(rejectedMulti.stderr).toContain("remote get-url --push --all origin");
    expect(existsSync(workdirMultiUrl)).toBe(false);

    // 4. Push re-checks origin URLs on its fresh ephemeral bare clone even after verify succeeded.
    const workdirPushCheck = join(root, "ship-push-recheck");
    const commonPushCheck = ["--repo", REPO_SLUG, "--dir", workdirPushCheck];
    runScript(["clone", ...commonPushCheck], { env });
    runScript(
      ["verify", ...commonPushCheck, "--target", "main", "--branch", "crew", "--sha", sha],
      {
        env,
      },
    );
    writeFileSync(
      globalConfig,
      [
        "[user]",
        "\tname = Test",
        "\temail = test@example.com",
        `[url "file://${evilOriginDir}"]`,
        `\tpushInsteadOf = ${originUrl}`,
        "",
      ].join("\n"),
    );
    const rejectedAtPush = runScript(
      ["push", ...commonPushCheck, "--target", "main", "--sha", sha],
      {
        env,
        allowFailure: true,
      },
    );
    expect(rejectedAtPush.status).not.toBe(0);
    expect(rejectedAtPush.stderr).toContain("remote get-url --push --all origin");
    expect(existsSync(workdirPushCheck)).toBe(false);
    expect(listEphemeralDirs(storageDir)).toEqual([]);
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      base,
    );
    expect(
      runGit(["--git-dir", evilOriginDir, "rev-parse", "--verify", "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).not.toBe(0);
  });

  test("running the script through a symlinked directory with spaces and percent-encoding invokes the CLI", () => {
    const { root, env } = setupScratchRepo();
    const linkDir = join(root, "linked scripts %20 dir");
    symlinkSync(dirname(SCRIPT_PATH), linkDir);
    const viaSymlink = join(linkDir, "direct-ship.mjs");
    const workdir = join(root, "ship-symlink");

    const cloned = runScript(["clone", "--repo", REPO_SLUG, "--dir", workdir], {
      env,
      scriptPath: viaSymlink,
    });
    expect(cloned.stdout).toContain("status: cloned");
    expect(existsSync(join(workdir, "bare.git"))).toBe(true);

    const bad = runScript(["clone", "--repo", "not-a-repo", "--dir", join(root, "unused")], {
      env,
      scriptPath: viaSymlink,
      allowFailure: true,
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("invalid --repo");

    const cleaned = runScript(["cleanup", "--dir", workdir], { env, scriptPath: viaSymlink });
    expect(cleaned.stdout).toContain("status: cleaned");
    expect(existsSync(workdir)).toBe(false);
  });

  test("a commit subject, workdir path, and post-receive hook message containing 'ambiguous' do not stop a valid ship", () => {
    const { root, env, originDir, crewDir } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "note.txt"), "clarify\n");
    runGit(["add", "note.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "fix: clarify ambiguous wording that matches more than one case"], {
      cwd: crewDir,
      env,
    });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // A remote post-receive hook printing an ambiguity-looking line (git prefixes it with `remote: `)
    // must not trigger the anchored AMBIGUOUS_LINE_RE stop after push lands.
    const postReceive = join(originDir, "hooks", "post-receive");
    writeFileSync(
      postReceive,
      "#!/bin/sh\necho \"warning: refname 'main' is ambiguous\" >&2\nexit 0\n",
    );
    chmodSync(postReceive, 0o755);

    const workdir = join(root, "ambiguous-workdir");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });
    const verified = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(verified.stdout).toContain("status: ready");
    expect(verified.stdout).toContain("ambiguous wording");
    const pushed = runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    expect(pushed.stdout).toContain("status: pushed");
    expect(
      runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env }).stdout,
    ).toContain("status: confirmed");
    runScript(["cleanup", "--dir", workdir], { env });
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
  });

  test("cleanEnv preserves GIT_CONFIG_COUNT credential helpers while stripping repo-pointing GIT_* vars", async () => {
    const { root, env } = setupScratchRepo();
    // Stripped repo-pointing GIT_* vars cannot hijack a valid clone.
    const fileWorkdir = join(root, "ship-stripped-env");
    const strippedEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_DIR: join(root, "bogus.git"),
      GIT_WORK_TREE: join(root, "bogus-wt"),
    };
    const fileClone = runScript(["clone", "--repo", REPO_SLUG, "--dir", fileWorkdir], {
      env: strippedEnv,
    });
    expect(fileClone.stdout).toContain("status: cloned");
    runScript(["cleanup", "--dir", fileWorkdir], { env });

    const helperLog = join(root, "cred-helper.log");
    const server = createServer((_req, res) => {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      res.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
    try {
      const { port } = server.address() as AddressInfo;
      const workdir = join(root, "ship-cred");
      const credEnv: NodeJS.ProcessEnv = {
        ...env,
        [TEST_BASE_URL_ENV]: `http://127.0.0.1:${port}`,
        GIT_DIR: join(root, "bogus.git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: `!sh -c 'echo invoked >> "${helperLog}"'`,
      };
      const res = await runScriptAsync(["clone", "--repo", REPO_SLUG, "--dir", workdir], {
        env: credEnv,
        allowFailure: true,
      });
      expect(res.status).not.toBe(0);
      expect(existsSync(helperLog)).toBe(true);
      expect(readFileSync(helperLog, "utf8")).toContain("invoked");
      // Failed clone cleans up any partial workdir.
      expect(existsSync(workdir)).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("push enforces verified repo/ssh/sha/target without deleting on typo, distinguishes target-moved (5) vs not-fast-forward (3), reports refused (1), and reports already-landed on rerun", () => {
    const { root, storageDir, env, originDir, crewDir, base } = setupScratchRepo();

    // Two commits on crew: base -> c1 -> c2.
    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "c1.txt"), "1\n");
    runGit(["add", "c1.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: step 1"], { cwd: crewDir, env });
    const c1 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    writeFileSync(join(crewDir, "c2.txt"), "2\n");
    runGit(["add", "c2.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: step 2"], { cwd: crewDir, env });
    const c2 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // 1. push before verify is refused without deleting bare.git.
    const wdUnverified = join(root, "ship-unverified");
    const commonUnverified = ["--repo", REPO_SLUG, "--dir", wdUnverified];
    runScript(["clone", ...commonUnverified], { env });
    const unverified = runScript(["push", ...commonUnverified, "--target", "main", "--sha", c2], {
      env,
      allowFailure: true,
    });
    expect(unverified.status).toBe(1);
    expect(unverified.stderr).toContain("verified.json");
    expect(existsSync(join(wdUnverified, "bare.git"))).toBe(true);
    runScript(["cleanup", "--dir", wdUnverified], { env });

    // 2. push with mistyped --repo, --ssh, --sha, or --target fails without destroying the verified workdir.
    const wdMismatch = join(root, "ship-mismatch");
    const commonMismatch = ["--repo", REPO_SLUG, "--dir", wdMismatch];
    runScript(["clone", ...commonMismatch], { env });
    runScript(["verify", ...commonMismatch, "--target", "main", "--branch", "crew", "--sha", c2], {
      env,
    });
    const wrongRepo = runScript(
      [
        "push",
        "--repo",
        "smsunarto/other-repo",
        "--dir",
        wdMismatch,
        "--target",
        "main",
        "--sha",
        c2,
      ],
      { env, allowFailure: true },
    );
    expect(wrongRepo.status).toBe(1);
    expect(wrongRepo.stderr).toContain("does not match verified");
    expect(existsSync(join(wdMismatch, "bare.git"))).toBe(true);
    expect(existsSync(join(wdMismatch, "checks"))).toBe(true);

    const wrongSsh = runScript(
      ["push", ...commonMismatch, "--target", "main", "--sha", c2, "--ssh"],
      { env, allowFailure: true },
    );
    expect(wrongSsh.status).toBe(1);
    expect(wrongSsh.stderr).toContain("does not match verified");
    expect(existsSync(join(wdMismatch, "bare.git"))).toBe(true);

    const wrongSha = runScript(["push", ...commonMismatch, "--target", "main", "--sha", c1], {
      env,
      allowFailure: true,
    });
    expect(wrongSha.status).toBe(1);
    expect(wrongSha.stderr).toContain("does not match verified");
    const wrongTarget = runScript(["push", ...commonMismatch, "--target", "other", "--sha", c2], {
      env,
      allowFailure: true,
    });
    expect(wrongTarget.status).toBe(1);
    expect(wrongTarget.stderr).toContain("does not match verified");
    expect(existsSync(join(wdMismatch, "verified.json"))).toBe(true);
    runScript(["cleanup", "--dir", wdMismatch], { env });

    // 3a. Target advances to c1 (an ancestor of c2) after verify recorded target_sha=base:
    // push refuses with exit 5 (`status: target-moved` on stdout) and removes its ephemeral clone.
    const wdMovedAncestor = join(root, "ship-moved-ancestor");
    const commonMovedAncestor = ["--repo", REPO_SLUG, "--dir", wdMovedAncestor];
    runScript(["clone", ...commonMovedAncestor], { env });
    runScript(
      ["verify", ...commonMovedAncestor, "--target", "main", "--branch", "crew", "--sha", c2],
      { env },
    );
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", c1], { env });
    const movedAncestor = runScript(
      ["push", ...commonMovedAncestor, "--target", "main", "--sha", c2],
      { env, allowFailure: true },
    );
    expect(movedAncestor.status).toBe(5);
    expect(movedAncestor.stdout).toContain("status: target-moved");
    expect(movedAncestor.stdout).toContain(`target_sha: ${c1}`);
    expect(movedAncestor.stdout).toContain(`verified_target_sha: ${base}`);
    expect(movedAncestor.stderr).toBe("");
    expect(existsSync(wdMovedAncestor)).toBe(false);
    expect(listEphemeralDirs(storageDir)).toEqual([]);
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      c1,
    );

    // 3b. Target moves to a diverging commit (NOT an ancestor of c2): push exits 3 (`status: not-fast-forward` on stdout).
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    runGit(["checkout", "-b", "diverge", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "diverge.txt"), "d\n");
    runGit(["add", "diverge.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "diverging commit"], { cwd: crewDir, env });
    const divergeSha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["checkout", "crew"], { cwd: crewDir, env });

    const wdMovedDiverge = join(root, "ship-moved-diverge");
    const commonMovedDiverge = ["--repo", REPO_SLUG, "--dir", wdMovedDiverge];
    runScript(["clone", ...commonMovedDiverge], { env });
    runScript(
      ["verify", ...commonMovedDiverge, "--target", "main", "--branch", "crew", "--sha", c2],
      { env },
    );
    runGit(["push", "origin", `${divergeSha}:refs/heads/main`], { cwd: crewDir, env });
    const movedDiverge = runScript(
      ["push", ...commonMovedDiverge, "--target", "main", "--sha", c2],
      { env, allowFailure: true },
    );
    expect(movedDiverge.status).toBe(3);
    expect(movedDiverge.stdout).toContain("status: not-fast-forward");
    expect(movedDiverge.stderr).toBe("");
    expect(existsSync(wdMovedDiverge)).toBe(false);
    expect(listEphemeralDirs(storageDir)).toEqual([]);

    // 3c. Target moved AND pre-push check fails (ls-remote error before push ever runs):
    // must report a non-landing stop (exit 1 on stderr), NOT status: landing-uncertain.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    const wdPrePushFail = join(root, "ship-pre-push-fail");
    const commonPrePushFail = ["--repo", REPO_SLUG, "--dir", wdPrePushFail];
    runScript(["clone", ...commonPrePushFail], { env });
    runScript(
      ["verify", ...commonPrePushFail, "--target", "main", "--branch", "crew", "--sha", c2],
      { env },
    );
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", c1], { env });
    const failLsRemoteEnv = makeGitShimEnv(
      root,
      "fail-ls-remote-pre-push",
      env,
      'for arg in "$@"; do if [ "$arg" = "ls-remote" ]; then echo "simulated ls-remote failure" >&2; exit 128; fi; done\nexec "$REAL_GIT" "$@"',
    );
    const prePushFailed = runScript(
      ["push", ...commonPrePushFail, "--target", "main", "--sha", c2],
      { env: failLsRemoteEnv, allowFailure: true },
    );
    expect(prePushFailed.status).toBe(1);
    expect(prePushFailed.stdout).not.toContain("landing-uncertain");
    expect(prePushFailed.stderr).toContain("simulated ls-remote failure");
    expect(existsSync(wdPrePushFail)).toBe(false);
    expect(listEphemeralDirs(storageDir)).toEqual([]);

    // 3d. Remote pre-receive hook rejects push: exits 1 with `status: refused` on stdout.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });
    const preReceive = join(originDir, "hooks", "pre-receive");
    writeFileSync(preReceive, "#!/bin/sh\necho 'protected branch rule' >&2\nexit 1\n");
    chmodSync(preReceive, 0o755);
    const wdRefused = join(root, "ship-refused");
    const commonRefused = ["--repo", REPO_SLUG, "--dir", wdRefused];
    runScript(["clone", ...commonRefused], { env });
    runScript(["verify", ...commonRefused, "--target", "main", "--branch", "crew", "--sha", c2], {
      env,
    });
    const refused = runScript(["push", ...commonRefused, "--target", "main", "--sha", c2], {
      env,
      allowFailure: true,
    });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("status: refused");
    expect(refused.stderr).toBe("");
    expect(existsSync(wdRefused)).toBe(false);
    expect(listEphemeralDirs(storageDir)).toEqual([]);
    rmSync(preReceive);

    // 4. Lost-response rerun: push lands c2, then rerunning push (and even after another commit lands on top) reports already-landed (exit 0).
    const wdRerun = join(root, "ship-rerun");
    const commonRerun = ["--repo", REPO_SLUG, "--dir", wdRerun];
    runScript(["clone", ...commonRerun], { env });
    runScript(["verify", ...commonRerun, "--target", "main", "--branch", "crew", "--sha", c2], {
      env,
    });
    expect(
      runScript(["push", ...commonRerun, "--target", "main", "--sha", c2], { env }).stdout,
    ).toContain("status: pushed");

    const rerunSame = runScript(["push", ...commonRerun, "--target", "main", "--sha", c2], { env });
    expect(rerunSame.stdout).toContain("status: already-landed");
    expect(listEphemeralDirs(storageDir)).toEqual([]);

    // Another commit lands on top of c2 on origin/main; rerunning push still reports already-landed.
    writeFileSync(join(crewDir, "later.txt"), "later\n");
    runGit(["add", "later.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "later commit"], { cwd: crewDir, env });
    const later = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "origin", `${later}:refs/heads/main`], { cwd: crewDir, env });

    const rerunLater = runScript(["push", ...commonRerun, "--target", "main", "--sha", c2], {
      env,
    });
    expect(rerunLater.stdout).toContain("status: already-landed");
    expect(
      runScript(["confirm", ...commonRerun, "--target", "main", "--sha", c2], { env }).stdout,
    ).toContain("status: confirmed");
    expect(listEphemeralDirs(storageDir)).toEqual([]);
    runScript(["cleanup", "--dir", wdRerun], { env });
    expect(existsSync(wdRerun)).toBe(false);
  });

  test("verify preserves workdir on argument mistakes, emits stale-clone (6), enforces both local and remote crew-at-sha, and cleans up after checks/ exists", () => {
    const { root, storageDir, env, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "one.txt"), "1\n");
    runGit(["add", "one.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: one"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;

    // 1. Crew branch not pushed yet: verify exits 2 with status: crew-branch-missing on stdout.
    const workdir = join(root, "ship-lifecycle");
    const common = ["--repo", REPO_SLUG, "--dir", workdir];
    runScript(["clone", ...common], { env });

    // 1a. Argument mistakes (`--target mian`, wrong `--repo`, toggled `--ssh`) preserve the workdir.
    const typoTarget = runScript(
      ["verify", ...common, "--target", "mian", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(typoTarget.status).toBe(1);
    expect(typoTarget.stderr).toContain("refs/heads/mian");
    expect(existsSync(join(workdir, "bare.git"))).toBe(true);

    const typoRepo = runScript(
      [
        "verify",
        "--repo",
        "smsunarto/other-repo",
        "--dir",
        workdir,
        "--target",
        "main",
        "--branch",
        "crew",
        "--sha",
        sha,
      ],
      { env, allowFailure: true },
    );
    expect(typoRepo.status).toBe(1);
    expect(typoRepo.stderr).toContain("does not match cloned workdir");
    expect(existsSync(join(workdir, "bare.git"))).toBe(true);

    const typoSsh = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha, "--ssh"],
      { env, allowFailure: true },
    );
    expect(typoSsh.status).toBe(1);
    expect(typoSsh.stderr).toContain("does not match cloned workdir");
    expect(existsSync(join(workdir, "bare.git"))).toBe(true);

    const missing = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("status: crew-branch-missing");
    expect(missing.stderr).toBe("");
    expect(existsSync(workdir)).toBe(false);

    // 1b. Crew branch pushed AFTER clone: verify exits 6 with status: stale-clone on stdout.
    const wdPushedAfter = join(root, "ship-pushed-after-clone");
    const commonAfter = ["--repo", REPO_SLUG, "--dir", wdPushedAfter];
    runScript(["clone", ...commonAfter], { env });
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });
    const staleClone = runScript(
      ["verify", ...commonAfter, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(staleClone.status).toBe(6);
    expect(staleClone.stdout).toContain("status: stale-clone");
    expect(staleClone.stdout).toContain(`remote_sha: ${sha}`);
    expect(staleClone.stderr).toBe("");
    expect(existsSync(wdPushedAfter)).toBe(false);

    // 1c. Both local and remote halves of crew-at-<sha> check:
    writeFileSync(join(crewDir, "two.txt"), "2\n");
    runGit(["add", "two.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: two"], { cwd: crewDir, env });
    const sha2 = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    // Push sha2 to an auxiliary branch so bare.git has sha2 in its object store even when crew is at sha.
    runGit(["push", "origin", `${sha2}:refs/heads/aux-sha2`], { cwd: crewDir, env });

    // Local half ONLY: clone has crew=sha and aux-sha2=sha2; then origin advances crew to sha2.
    // remoteCrew === sha2, while localCrew === sha (!== sha2). Mutating the check to `remoteCrew !== sha`
    // would wrongly pass with status: ready!
    const wdLocalCrewStale = join(root, "ship-local-crew-stale");
    const commonLocalStale = ["--repo", REPO_SLUG, "--dir", wdLocalCrewStale];
    runScript(["clone", ...commonLocalStale], { env });
    runGit(["push", "origin", `${sha2}:refs/heads/crew`], { cwd: crewDir, env });
    const localStale = runScript(
      ["verify", ...commonLocalStale, "--target", "main", "--branch", "crew", "--sha", sha2],
      { env, allowFailure: true },
    );
    expect(localStale.status).toBe(1);
    expect(localStale.stderr).toContain(`is not at ${sha2}`);
    expect(existsSync(wdLocalCrewStale)).toBe(false);

    // Mistyped --sha when both bare and origin agree crew is at sha2: fails AND preserves workdir.
    const wdWrongCrewSha = join(root, "ship-wrong-crew-sha");
    const commonWrongCrew = ["--repo", REPO_SLUG, "--dir", wdWrongCrewSha];
    runScript(["clone", ...commonWrongCrew], { env });
    const wrongCrew = runScript(
      ["verify", ...commonWrongCrew, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(wrongCrew.status).toBe(1);
    expect(wrongCrew.stderr).toContain(`is not at ${sha}`);
    expect(existsSync(join(wdWrongCrewSha, "bare.git"))).toBe(true);
    runScript(["cleanup", "--dir", wdWrongCrewSha], { env });

    // Remote half ONLY: clone has crew=sha; origin advances crew to sha2; verify --sha sha fails.
    runGit(["push", "--force", "origin", `${sha}:refs/heads/crew`], { cwd: crewDir, env });
    const wdRemoteCrewMoved = join(root, "ship-remote-crew-moved");
    const commonRemoteMoved = ["--repo", REPO_SLUG, "--dir", wdRemoteCrewMoved];
    runScript(["clone", ...commonRemoteMoved], { env });
    runGit(["push", "origin", `${sha2}:refs/heads/crew`], { cwd: crewDir, env });
    const remoteMoved = runScript(
      ["verify", ...commonRemoteMoved, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(remoteMoved.status).toBe(1);
    expect(remoteMoved.stderr).toContain(`is not at ${sha}`);
    expect(existsSync(wdRemoteCrewMoved)).toBe(false);

    // Restore crew to sha and delete aux branch.
    runGit(["push", "--force", "origin", `${sha}:refs/heads/crew`], { cwd: crewDir, env });
    runGit(["push", "origin", ":refs/heads/aux-sha2"], { cwd: crewDir, env });

    // 1d. Target moves on origin after clone before verify: verify fails local-vs-ls-remote target comparison.
    const wdTargetMismatch = join(root, "ship-target-mismatch");
    const commonTargetMismatch = ["--repo", REPO_SLUG, "--dir", wdTargetMismatch];
    runScript(["clone", ...commonTargetMismatch], { env });
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", sha2], { env });
    const targetMismatch = runScript(
      ["verify", ...commonTargetMismatch, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(targetMismatch.status).toBe(1);
    expect(targetMismatch.stderr).toContain("mismatch");
    expect(existsSync(wdTargetMismatch)).toBe(false);
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", base], { env });

    // 1e. Verify failing AFTER `checks/` was created removes `checks/`, `bare.git`, and `<workdir>`.
    const wdAfterChecks = join(root, "ship-fail-after-checks");
    const commonAfterChecks = ["--repo", REPO_SLUG, "--dir", wdAfterChecks];
    runScript(["clone", ...commonAfterChecks], { env });
    const failCheckoutEnv = makeGitShimEnv(
      root,
      "fail-checkout",
      env,
      'for arg in "$@"; do if [ "$arg" = "checkout" ]; then echo "simulated checkout failure" >&2; exit 1; fi; done\nexec "$REAL_GIT" "$@"',
    );
    const failedAfterChecks = runScript(
      ["verify", ...commonAfterChecks, "--target", "main", "--branch", "crew", "--sha", sha],
      { env: failCheckoutEnv, allowFailure: true },
    );
    expect(failedAfterChecks.status).toBe(1);
    expect(failedAfterChecks.stderr).toContain("simulated checkout failure");
    expect(existsSync(join(wdAfterChecks, "checks"))).toBe(false);
    expect(existsSync(join(wdAfterChecks, "bare.git"))).toBe(false);
    expect(existsSync(wdAfterChecks)).toBe(false);

    // 2. Confirm before push fails ancestor check, cleans its ephemeral clone, and leaves workdir intact.
    runScript(["clone", ...common], { env });
    const notLandedConfirm = runScript(["confirm", ...common, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(notLandedConfirm.status).toBe(1);
    expect(notLandedConfirm.stderr).toContain("is not an ancestor");
    expect(notLandedConfirm.stdout).not.toContain("status: confirmed");
    expect(existsSync(join(workdir, "bare.git"))).toBe(true);
    expect(listEphemeralDirs(storageDir)).toEqual([]);

    // Full verify -> push -> confirm -> cleanup succeeds.
    expect(
      runScript(["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha], {
        env,
      }).stdout,
    ).toContain("status: ready");
    runScript(["push", ...common, "--target", "main", "--sha", sha], { env });
    runScript(["confirm", ...common, "--target", "main", "--sha", sha], { env });
    runScript(["cleanup", "--dir", workdir], { env });

    // Fresh clone's verify reports already-landed without creating `checks`.
    runScript(["clone", ...common], { env });
    const landed = runScript(
      ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    expect(landed.stdout).toContain("status: already-landed");
    expect(existsSync(join(workdir, "checks"))).toBe(false);
    runScript(["cleanup", "--dir", workdir], { env });

    // 3. A crew branch behind moved main gets status: not-fast-forward (exit 3) on stdout without creating `checks`.
    runGit(["checkout", "-b", "stale-crew", base], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "stale.txt"), "stale\n");
    runGit(["add", "stale.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: stale"], { cwd: crewDir, env });
    const staleSha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "stale-crew"], { cwd: crewDir, env });

    runScript(["clone", ...common], { env });
    const notFf = runScript(
      ["verify", ...common, "--target", "main", "--branch", "stale-crew", "--sha", staleSha],
      { env, allowFailure: true },
    );
    expect(notFf.status).toBe(3);
    expect(notFf.stdout).toContain("status: not-fast-forward");
    expect(notFf.stderr).toBe("");
    expect(existsSync(workdir)).toBe(false);
  });

  test("mutations in bare.git during checks (loose-object forge, commit-graph forge, core.sshCommand, grafts) cannot make push or confirm fake a landing", () => {
    const { root, storageDir, env, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "feat.txt"), "feat\n");
    runGit(["add", "feat.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: feat"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // Vector (a): loose-object forge in bare.git (both Mode A with forged verified.json target_sha
    // and Mode B with push rejected by origin).
    const wdLoose = join(root, "ship-loose-forge");
    const commonLoose = ["--repo", REPO_SLUG, "--dir", wdLoose];
    runScript(["clone", ...commonLoose], { env });
    runScript(["verify", ...commonLoose, "--target", "main", "--branch", "crew", "--sha", sha], {
      env,
    });
    const looseBare = join(wdLoose, "bare.git");
    forgeLooseCommitParent(looseBare, base, sha, env);
    // Control: the poisoned bare.git itself DOES claim sha is an ancestor of refs/heads/main.
    expect(
      runGit(["--git-dir", looseBare, "merge-base", "--is-ancestor", sha, "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).toBe(0);
    // Also set push.gpgSign=true in bare.git (which old push read) and tamper verified.json target_sha.
    runGit(["--git-dir", looseBare, "config", "push.gpgSign", "true"], { env });
    writeFileSync(
      join(wdLoose, "verified.json"),
      `${JSON.stringify({ repo: REPO_SLUG, ssh: false, sha, target: "main", target_sha: "0".repeat(40) }, null, 2)}\n`,
    );

    const pushLoose = runScript(["push", ...commonLoose, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(pushLoose.status).toBe(5);
    expect(pushLoose.stdout).toContain("status: target-moved");
    expect(pushLoose.stdout).not.toContain("status: already-landed");
    const confirmLoose = runScript(["confirm", ...commonLoose, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(confirmLoose.status).toBe(1);
    expect(confirmLoose.stdout).not.toContain("status: confirmed");
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      base,
    );

    // Vector (b): commit-graph forge in bare.git + pre-receive rejection on origin (Mode B).
    const preReceive = join(originDir, "hooks", "pre-receive");
    writeFileSync(preReceive, "#!/bin/sh\necho 'rejected for test' >&2\nexit 1\n");
    chmodSync(preReceive, 0o755);

    const wdGraph = join(root, "ship-graph-forge");
    const commonGraph = ["--repo", REPO_SLUG, "--dir", wdGraph];
    runScript(["clone", ...commonGraph], { env });
    runScript(["verify", ...commonGraph, "--target", "main", "--branch", "crew", "--sha", sha], {
      env,
    });
    const graphBare = join(wdGraph, "bare.git");
    forgeCommitGraphParent(graphBare, base, sha, env);
    // Control: default merge-base in poisoned bare.git reads commit-graph and returns 0, while
    // `-c core.commitGraph=false` returns 1.
    expect(
      runGit(["--git-dir", graphBare, "merge-base", "--is-ancestor", sha, "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).toBe(0);
    expect(
      runGit(
        [
          "-c",
          "core.commitGraph=false",
          "--git-dir",
          graphBare,
          "merge-base",
          "--is-ancestor",
          sha,
          "refs/heads/main",
        ],
        { env, allowFailure: true },
      ).status,
    ).toBe(1);

    const pushGraph = runScript(["push", ...commonGraph, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(pushGraph.status).toBe(1);
    expect(pushGraph.stdout).toContain("status: refused");
    expect(pushGraph.stdout).not.toContain("status: already-landed");
    const confirmGraph = runScript(["confirm", ...commonGraph, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(confirmGraph.status).toBe(1);
    expect(confirmGraph.stdout).not.toContain("status: confirmed");

    // Vector (c): core.sshCommand planted in bare.git config is never executed by push or confirm.
    const fakeSshLog = join(root, "fake-ssh.log");
    const fakeSsh = join(root, "fake-ssh.sh");
    writeFileSync(fakeSsh, `#!/bin/sh\necho "invoked:$*" >> "${fakeSshLog}"\nexit 99\n`);
    chmodSync(fakeSsh, 0o755);

    const wdSsh = join(root, "ship-ssh-config-forge");
    const commonSsh = ["--repo", REPO_SLUG, "--dir", wdSsh];
    runScript(["clone", ...commonSsh], { env });
    runScript(["verify", ...commonSsh, "--target", "main", "--branch", "crew", "--sha", sha], {
      env,
    });
    runGit(["--git-dir", join(wdSsh, "bare.git"), "config", "core.sshCommand", fakeSsh], { env });
    runGit(
      [
        "--git-dir",
        join(wdSsh, "bare.git"),
        "remote",
        "set-url",
        "origin",
        "ssh://example/repo.git",
      ],
      { env },
    );

    const pushSsh = runScript(["push", ...commonSsh, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(pushSsh.status).toBe(1);
    expect(pushSsh.stdout).toContain("status: refused");
    expect(pushSsh.stdout).not.toContain("status: already-landed");
    const confirmSsh = runScript(["confirm", ...commonSsh, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(confirmSsh.status).toBe(1);
    expect(confirmSsh.stdout).not.toContain("status: confirmed");
    expect(existsSync(fakeSshLog)).toBe(false);

    rmSync(preReceive);

    // Vector (d): review round-2 repro — check forges T in bare.git and deletes verified.json and
    // checks/; push stops advising cleanup+re-clone (never "run verify"), and re-running verify
    // still decides already-landed in a fresh ephemeral clone and MUST NOT report already-landed.
    const wdRerunVerify = join(root, "ship-rerun-verify-forge");
    const commonRerunVerify = ["--repo", REPO_SLUG, "--dir", wdRerunVerify];
    runScript(["clone", ...commonRerunVerify], { env });
    runScript(
      ["verify", ...commonRerunVerify, "--target", "main", "--branch", "crew", "--sha", sha],
      { env },
    );
    const rerunBare = join(wdRerunVerify, "bare.git");
    forgeLooseCommitParent(rerunBare, base, sha, env);
    expect(
      runGit(["--git-dir", rerunBare, "merge-base", "--is-ancestor", sha, "refs/heads/main"], {
        env,
        allowFailure: true,
      }).status,
    ).toBe(0);
    rmSync(join(wdRerunVerify, "verified.json"));
    rmSync(join(wdRerunVerify, "checks"), { recursive: true });

    const pushAfterDelete = runScript(
      ["push", ...commonRerunVerify, "--target", "main", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(pushAfterDelete.status).toBe(1);
    expect(pushAfterDelete.stderr).toContain("run cleanup, then clone and verify again");
    expect(pushAfterDelete.stderr).not.toContain("run verify before push");

    const verifyAfterForge = runScript(
      ["verify", ...commonRerunVerify, "--target", "main", "--branch", "crew", "--sha", sha],
      { env, allowFailure: true },
    );
    expect(verifyAfterForge.stdout).not.toContain("status: already-landed");
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      base,
    );
    runScript(["cleanup", "--dir", wdRerunVerify], { env });

    // Invalid verified.json also advises cleanup + re-clone, never "run verify".
    const wdInvalidVerified = join(root, "ship-invalid-verified");
    const commonInvalid = ["--repo", REPO_SLUG, "--dir", wdInvalidVerified];
    runScript(["clone", ...commonInvalid], { env });
    writeFileSync(join(wdInvalidVerified, "verified.json"), "{}\n");
    const pushInvalid = runScript(["push", ...commonInvalid, "--target", "main", "--sha", sha], {
      env,
      allowFailure: true,
    });
    expect(pushInvalid.status).toBe(1);
    expect(pushInvalid.stderr).toContain("run cleanup, then clone and verify again");
    runScript(["cleanup", "--dir", wdInvalidVerified], { env });

    // Defense in depth: verify still refuses grafts, shallow, and alternates planted in bare.git before verify.
    for (const rel of ["info/grafts", "shallow", "objects/info/alternates"]) {
      const wd = join(root, `ship-defense-${rel.replaceAll("/", "-")}`);
      const common = ["--repo", REPO_SLUG, "--dir", wd];
      runScript(["clone", ...common], { env });
      const targetPath = join(wd, "bare.git", rel);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${base} ${sha}\n`);
      const verifyBad = runScript(
        ["verify", ...common, "--target", "main", "--branch", "crew", "--sha", sha],
        { env, allowFailure: true },
      );
      expect(verifyBad.status).not.toBe(0);
      expect(verifyBad.stderr).toContain(rel);
      expect(existsSync(wd)).toBe(false);
    }

    expect(listEphemeralDirs(storageDir)).toEqual([]);
  });

  test("post-push fetch failures emit status: landing-uncertain (exit 4) keeping workdir and ephemeral_dir, and confirm catches clone-vs-ls-remote mismatch", () => {
    const { root, storageDir, env, originDir, crewDir, base } = setupScratchRepo();

    runGit(["checkout", "-b", "crew"], { cwd: crewDir, env });
    writeFileSync(join(crewDir, "ship.txt"), "ship\n");
    runGit(["add", "ship.txt"], { cwd: crewDir, env });
    runGit(["commit", "-m", "task: ship"], { cwd: crewDir, env });
    const sha = runGit(["rev-parse", "HEAD"], { cwd: crewDir, env }).stdout;
    runGit(["push", "-u", "origin", "crew"], { cwd: crewDir, env });

    // 1. Lost push response (push lands on origin then exits 128) + follow-up fetch fails:
    // push exits 4 (`status: landing-uncertain` on stdout) and preserves workdir + ephemeral_dir.
    const wdLost = join(root, "ship-lost-push");
    const commonLost = ["--repo", REPO_SLUG, "--dir", wdLost];
    runScript(["clone", ...commonLost], { env });
    runScript(["verify", ...commonLost, "--target", "main", "--branch", "crew", "--sha", sha], {
      env,
    });

    const lostPushEnv = makeGitShimEnv(
      root,
      "lost-push-fetch-fail",
      env,
      [
        'for arg in "$@"; do',
        '  if [ "$arg" = "push" ]; then "$REAL_GIT" "$@"; echo "connection reset after push" >&2; exit 128; fi',
        '  if [ "$arg" = "fetch" ]; then echo "network unreachable on fetch" >&2; exit 128; fi',
        "done",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    );
    const uncertainPush = runScript(["push", ...commonLost, "--target", "main", "--sha", sha], {
      env: lostPushEnv,
      allowFailure: true,
    });
    expect(uncertainPush.status).toBe(4);
    expect(uncertainPush.stdout).toContain("status: landing-uncertain");
    expect(uncertainPush.stderr).toBe("");
    const pushEphemeral = parseField(uncertainPush.stdout, "ephemeral_dir");
    expect(existsSync(pushEphemeral)).toBe(true);
    expect(existsSync(join(wdLost, "bare.git"))).toBe(true);
    expect(existsSync(join(wdLost, "verified.json"))).toBe(true);
    expect(runGit(["--git-dir", originDir, "rev-parse", "refs/heads/main"], { env }).stdout).toBe(
      sha,
    );
    runScript(["cleanup", "--dir", pushEphemeral], { env });
    expect(existsSync(pushEphemeral)).toBe(false);

    // 2. Confirm when fresh clone fails: exits 4 (`status: landing-uncertain`) and preserves workdir.
    const failCloneEnv = makeGitShimEnv(
      root,
      "confirm-clone-fail",
      env,
      'for arg in "$@"; do if [ "$arg" = "clone" ]; then echo "transient network error" >&2; exit 128; fi; done\nexec "$REAL_GIT" "$@"',
    );
    const uncertainConfirm = runScript(
      ["confirm", ...commonLost, "--target", "main", "--sha", sha],
      { env: failCloneEnv, allowFailure: true },
    );
    expect(uncertainConfirm.status).toBe(4);
    expect(uncertainConfirm.stdout).toContain("status: landing-uncertain");
    expect(uncertainConfirm.stderr).toBe("");
    const confirmFailEphemeral = parseField(uncertainConfirm.stdout, "ephemeral_dir");
    expect(existsSync(confirmFailEphemeral)).toBe(true);
    expect(existsSync(join(wdLost, "bare.git"))).toBe(true);
    runScript(["cleanup", "--dir", confirmFailEphemeral], { env });

    // 3. Confirm when origin target moves between `clone` and `ls-remote` (tests local-vs-ls-remote comparison).
    const raceEnv = makeGitShimEnv(
      root,
      "confirm-clone-race",
      env,
      [
        'for arg in "$@"; do',
        `  if [ "$arg" = "clone" ]; then "$REAL_GIT" "$@"; rc=$?; "$REAL_GIT" --git-dir ${JSON.stringify(originDir)} update-ref refs/heads/main ${JSON.stringify(base)}; exit $rc; fi`,
        "done",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
    );
    const racedConfirm = runScript(["confirm", ...commonLost, "--target", "main", "--sha", sha], {
      env: raceEnv,
      allowFailure: true,
    });
    expect(racedConfirm.status).toBe(4);
    expect(racedConfirm.stdout).toContain("status: landing-uncertain");
    expect(racedConfirm.stdout).toContain("mismatch after fetch");
    const raceEphemeral = parseField(racedConfirm.stdout, "ephemeral_dir");
    runScript(["cleanup", "--dir", raceEphemeral], { env });

    // Restore origin/main to sha and verify recovery with plain confirm + cleanup works cleanly.
    runGit(["--git-dir", originDir, "update-ref", "refs/heads/main", sha], { env });
    expect(
      runScript(["confirm", ...commonLost, "--target", "main", "--sha", sha], { env }).stdout,
    ).toContain("status: confirmed");
    expect(listEphemeralDirs(storageDir)).toEqual([]);
    runScript(["cleanup", "--dir", wdLost], { env });
    expect(existsSync(wdLost)).toBe(false);
  });
});
