import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DevError } from "./error.ts";
import {
  expandHome,
  OFFICIAL_REPOSITORY,
  type InstancePlan,
  type ResolvedRevision,
  type RevisionRequest,
} from "./model.ts";
import { runCommand, type CommandResult } from "./process.ts";
import { ensureOwnedDirectory } from "./store.ts";

export type RevisionResolverOptions = {
  repositoryOption?: string;
  environment?: NodeJS.ProcessEnv;
  resolverPath?: string;
  ownerToken?: string;
  run?: typeof runCommand;
};

type SemanticVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (number | string)[];
};

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function parseRevisionSelector(value: string): RevisionRequest {
  if (value === "latest") {
    return { kind: "latest" };
  }
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) {
    throw new DevError(
      "invalid_revision",
      `Revision "${value}" is ambiguous.`,
      "Use latest, local:<branch>, origin:<branch>, tag:<tag>, or commit:<sha>.",
    );
  }
  const kind = value.slice(0, colon);
  const target = value.slice(colon + 1);
  if (kind === "local") {
    return { kind, branch: target };
  }
  if (kind === "origin") {
    return { kind, branch: target };
  }
  if (kind === "tag") {
    return { kind, tag: target };
  }
  if (kind === "commit") {
    if (!COMMIT_PATTERN.test(target)) {
      throw new DevError(
        "invalid_revision",
        `Commit selector "${target}" is not a 7 to 40 character hexadecimal object name.`,
        "Pass an exact commit object name.",
      );
    }
    return { kind, commit: target.toLowerCase() };
  }
  throw new DevError(
    "invalid_revision",
    `Unknown revision selector kind "${kind}".`,
    "Use latest, local:<branch>, origin:<branch>, tag:<tag>, or commit:<sha>.",
  );
}

export function compareDesktopTags(left: string, right: string): number {
  const a = parseDesktopTag(left);
  const b = parseDesktopTag(right);
  if (a === null || b === null) {
    throw new DevError(
      "invalid_release_tag",
      `Cannot compare non-semver desktop tags "${left}" and "${right}".`,
      "Use a desktop-v<semver> tag.",
    );
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) {
      return av === bv ? 0 : av === undefined ? -1 : 1;
    }
    if (av === bv) {
      continue;
    }
    if (typeof av === "number" && typeof bv === "number") {
      return av - bv;
    }
    if (typeof av === "number") {
      return -1;
    }
    if (typeof bv === "number") {
      return 1;
    }
    return av.localeCompare(bv);
  }
  return 0;
}

export function selectLatestDesktopTag(tags: readonly string[]): string {
  const valid = tags.filter((tag) => parseDesktopTag(tag) !== null);
  if (valid.length === 0) {
    throw new DevError(
      "release_not_found",
      "The official repository did not advertise a desktop-v* semver tag.",
      "Check network access or pass an explicit tag or commit.",
    );
  }
  return valid.toSorted(compareDesktopTags).at(-1) ?? valid[0] ?? "";
}

export async function resolveRevision(
  request: RevisionRequest,
  options: RevisionResolverOptions = {},
): Promise<ResolvedRevision> {
  const run = options.run ?? runCommand;
  const environment = options.environment ?? process.env;
  if (request.kind === "latest") {
    const refs = lsRemoteTags(OFFICIAL_REPOSITORY, run);
    const tag = selectLatestDesktopTag([...refs.keys()]);
    const commit = refs.get(tag);
    if (commit === undefined) {
      throw new DevError(
        "release_not_found",
        `The official release tag ${tag} did not resolve to a commit.`,
        "Retry after checking GitHub access.",
      );
    }
    return revision("latest", `tag:${tag}`, "official", OFFICIAL_REPOSITORY, tag, commit);
  }

  const selected = selectedRepository(request, options.repositoryOption, environment);
  if (request.kind === "local") {
    const repository = requireRepository(selected, request);
    validateBranch(request.branch, run);
    const commit = revParse(repository, `refs/heads/${request.branch}^{commit}`, run);
    return revision(
      `local:${request.branch}`,
      `local:${request.branch}`,
      "selected-repository",
      repository,
      request.branch,
      commit,
    );
  }
  if (request.kind === "origin") {
    const repository = requireRepository(selected, request);
    validateBranch(request.branch, run);
    const fetch = run("git", [
      "-C",
      repository,
      "fetch",
      "origin",
      `refs/heads/${request.branch}:refs/remotes/origin/${request.branch}`,
    ]);
    requireSuccess(fetch, "origin_fetch_failed", `Could not fetch origin/${request.branch}.`);
    const commit = revParse(repository, `refs/remotes/origin/${request.branch}^{commit}`, run);
    return revision(
      `origin:${request.branch}`,
      `origin:${request.branch}`,
      "selected-repository",
      repository,
      `origin/${request.branch}`,
      commit,
    );
  }
  if (request.kind === "tag") {
    if (selected !== null) {
      const repository = requireRepository(selected, request);
      const commit = revParse(repository, `refs/tags/${request.tag}^{commit}`, run);
      return revision(
        `tag:${request.tag}`,
        `tag:${request.tag}`,
        "selected-repository",
        repository,
        request.tag,
        commit,
      );
    }
    const commit = lsRemoteTags(OFFICIAL_REPOSITORY, run).get(request.tag);
    if (commit === undefined) {
      throw new DevError(
        "revision_not_found",
        `Official tag "${request.tag}" does not exist.`,
        "Check the tag or select another repository with --repo.",
      );
    }
    return revision(
      `tag:${request.tag}`,
      `tag:${request.tag}`,
      "official",
      OFFICIAL_REPOSITORY,
      request.tag,
      commit,
    );
  }

  if (selected !== null) {
    const repository = requireRepository(selected, request);
    const commit = revParse(repository, `${request.commit}^{commit}`, run);
    return revision(
      `commit:${request.commit}`,
      `commit:${commit}`,
      "selected-repository",
      repository,
      commit.slice(0, 12),
      commit,
    );
  }
  const resolverPath = options.resolverPath;
  const ownerToken = options.ownerToken;
  if (resolverPath === undefined || ownerToken === undefined) {
    throw new DevError(
      "unsupported_revision",
      "An official commit needs an owned resolution repository.",
      "Retry through bb-kit dev start or select a local repository with --repo.",
    );
  }
  const commit = resolveOfficialCommit(request.commit, resolverPath, ownerToken, run);
  return revision(
    `commit:${request.commit}`,
    `commit:${commit}`,
    "official",
    OFFICIAL_REPOSITORY,
    commit.slice(0, 12),
    commit,
  );
}

export function prepareCheckout(plan: InstancePlan, ownerToken: string): void {
  ensureOwnedDirectory(plan.checkoutPath, ownerToken, "checkout");
  if (!existsSync(join(plan.checkoutPath, ".git"))) {
    requireSuccess(
      runCommand("git", ["init", plan.checkoutPath]),
      "git_failed",
      "Could not initialize checkout.",
    );
  }
  const remote = runCommand("git", ["-C", plan.checkoutPath, "remote", "get-url", "origin"]);
  if (remote.status !== 0) {
    requireSuccess(
      runCommand("git", [
        "-C",
        plan.checkoutPath,
        "remote",
        "add",
        "origin",
        plan.revision.repository,
      ]),
      "git_failed",
      "Could not configure checkout source.",
    );
  } else if (remote.stdout.trim() !== plan.revision.repository) {
    throw new DevError(
      "checkout_mismatch",
      `Checkout ${plan.checkoutPath} has another origin.`,
      "Destroy the owned instance or choose another name.",
    );
  }
  const head = runCommand("git", ["-C", plan.checkoutPath, "rev-parse", "HEAD"]);
  if (head.status === 0 && head.stdout.trim().toLowerCase() === plan.revision.commit) {
    return;
  }
  requireSuccess(
    runCommand("git", [
      "-C",
      plan.checkoutPath,
      "fetch",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      plan.revision.commit,
    ]),
    "git_failed",
    `Could not fetch ${plan.revision.commit}.`,
  );
  requireSuccess(
    runCommand("git", ["-C", plan.checkoutPath, "checkout", "--detach", plan.revision.commit]),
    "git_failed",
    `Could not detach checkout at ${plan.revision.commit}.`,
  );
  const exact = runCommand("git", ["-C", plan.checkoutPath, "rev-parse", "HEAD"]);
  if (exact.status !== 0 || exact.stdout.trim().toLowerCase() !== plan.revision.commit) {
    throw new DevError(
      "checkout_mismatch",
      `Checkout ${plan.checkoutPath} did not reach ${plan.revision.commit}.`,
      "Inspect the checkout and retry start.",
    );
  }
}

function parseDesktopTag(tag: string): SemanticVersion | null {
  const match =
    /^desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      tag,
    );
  if (match === null) {
    return null;
  }
  const prereleaseText = match[4] ?? "";
  const prereleaseParts = prereleaseText === "" ? [] : prereleaseText.split(".");
  if (prereleaseParts.some((part) => part === "" || /^0\d+$/.test(part))) {
    return null;
  }
  const prerelease = prereleaseParts.map((part) => {
    const number = /^\d+$/.test(part) ? Number(part) : Number.NaN;
    return Number.isNaN(number) ? part : number;
  });
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function selectedRepository(
  request: RevisionRequest,
  option: string | undefined,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (request.kind === "latest") {
    return null;
  }
  const configured = option ?? environment["BB_KIT_BB_REPO"];
  if (configured !== undefined && configured !== "") {
    return canonicalRepository(configured);
  }
  if (request.kind === "local" || request.kind === "origin") {
    return canonicalRepository(join(homedir(), "git", "bb"));
  }
  return null;
}

function canonicalRepository(path: string): string {
  try {
    return realpathSync(resolve(expandHome(path)));
  } catch {
    throw new DevError(
      "repository_not_found",
      `Selected bb repository "${path}" does not exist.`,
      "Pass --repo with an existing Git repository.",
    );
  }
}

function requireRepository(repository: string | null, request: RevisionRequest): string {
  if (repository === null) {
    throw new DevError(
      "repository_required",
      `Revision ${request.kind} requires a selected repository.`,
      "Pass --repo or set BB_KIT_BB_REPO.",
    );
  }
  return repository;
}

function validateBranch(branch: string, run: typeof runCommand): void {
  const result = run("git", ["check-ref-format", "--branch", branch]);
  if (result.status !== 0) {
    throw new DevError(
      "invalid_revision",
      `Branch name "${branch}" is invalid.`,
      "Pass a valid local or origin branch name.",
    );
  }
}

function revParse(repository: string, expression: string, run: typeof runCommand): string {
  const result = run("git", ["-C", repository, "rev-parse", "--verify", expression]);
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(result.stdout.trim())) {
    throw new DevError(
      "revision_not_found",
      `Revision "${expression.replace(/\^\{commit\}$/, "")}" does not exist in ${repository}.`,
      "Fetch the revision or select another repository.",
      { stderr: result.stderr.trim() },
    );
  }
  return result.stdout.trim().toLowerCase();
}

function lsRemoteTags(repository: string, run: typeof runCommand): Map<string, string> {
  const result = run("git", ["ls-remote", "--tags", repository]);
  requireSuccess(result, "revision_resolution_failed", `Could not read tags from ${repository}.`);
  const bases = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (match === null) {
      continue;
    }
    const commit = match[1];
    const tag = match[2];
    if (commit === undefined || tag === undefined) {
      continue;
    }
    if (match[3] === undefined) {
      bases.set(tag, commit.toLowerCase());
    } else {
      peeled.set(tag, commit.toLowerCase());
    }
  }
  return new Map([...bases].map(([tag, commit]) => [tag, peeled.get(tag) ?? commit]));
}

function resolveOfficialCommit(
  requested: string,
  resolverPath: string,
  ownerToken: string,
  run: typeof runCommand,
): string {
  ensureOwnedDirectory(resolverPath, ownerToken, "resolver");
  if (!existsSync(join(resolverPath, ".git"))) {
    requireSuccess(
      run("git", ["init", resolverPath]),
      "revision_resolution_failed",
      "Git init failed.",
    );
  }
  const remote = run("git", ["-C", resolverPath, "remote", "get-url", "origin"]);
  if (remote.status !== 0) {
    requireSuccess(
      run("git", ["-C", resolverPath, "remote", "add", "origin", OFFICIAL_REPOSITORY]),
      "revision_resolution_failed",
      "Could not configure the official repository.",
    );
  } else if (remote.stdout.trim() !== OFFICIAL_REPOSITORY) {
    throw new DevError(
      "owner_mismatch",
      `Resolver path ${resolverPath} has another Git origin.`,
      "Inspect the instance root before retrying.",
    );
  }
  let fetch = run("git", [
    "-C",
    resolverPath,
    "fetch",
    "--filter=blob:none",
    "--no-tags",
    "origin",
    requested,
  ]);
  if (fetch.status !== 0) {
    fetch = run("git", [
      "-C",
      resolverPath,
      "fetch",
      "--filter=blob:none",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
      "+refs/tags/*:refs/tags/*",
    ]);
  }
  if (fetch.status !== 0) {
    throw new DevError(
      "unsupported_revision",
      `The official repository did not serve commit ${requested}.`,
      "Use a reachable exact commit, or pass --repo with a repository that contains it.",
      { stderr: fetch.stderr.trim() },
    );
  }
  return revParse(resolverPath, `${requested}^{commit}`, run);
}

function revision(
  selector: string,
  canonical: string,
  source: ResolvedRevision["source"],
  repository: string,
  label: string,
  commit: string,
): ResolvedRevision {
  return { selector, canonical, source, repository, label, commit };
}

function requireSuccess(result: CommandResult, code: string, message: string): void {
  if (result.status !== 0) {
    throw new DevError(code, message, "Inspect Git diagnostics and retry.", {
      stderr: result.stderr.trim(),
    });
  }
}
