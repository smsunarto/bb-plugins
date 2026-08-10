import { randomUUID } from "node:crypto";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  failedToSpawn: boolean;
  timedOut: boolean;
};

export type SmartCheckoutResult = {
  ok: boolean;
  message: string;
  detail: string | null;
};

export type SmartCheckoutDependencies = {
  runGit: (args: string[], timeoutMs?: number) => Promise<CommandResult>;
  checkout: (branch: string) => Promise<CommandResult>;
  currentBranch: () => Promise<string | null>;
  transactionId?: () => string;
  // Handled applies are recorded durably in plugin-owned refs. This set is
  // the fail-safe for the running plugin if that write only partly succeeds.
  blockedStashOids?: Set<string>;
};

type StashInspectionDependencies = Pick<
  SmartCheckoutDependencies,
  "runGit" | "blockedStashOids"
>;

const AUTO_STASH_PREFIX = "bb-gh-stack:auto-stash:v1:";
const STASH_STATE_PREFIX = "refs/bb-gh-stack/stash-state/";
const STASH_OID = /^[0-9a-f]{40,64}$/i;
const TRANSACTION_ID = /^[A-Za-z0-9-]+$/;

type StashEntry = {
  oid: string;
  marker: string;
  owner: string;
  transactionId: string;
};

type StashList =
  | { entries: StashEntry[]; result: CommandResult; error: null }
  | { entries: null; result: CommandResult; error: string };

type RestoreOutcome = {
  ok: boolean;
  status: "none" | "restored" | "failed";
  message: string | null;
  details: CommandResult[];
};

type StashState =
  | { oids: Set<string>; result: CommandResult; error: null }
  | { oids: null; result: CommandResult; error: string };

function markerFor(prefix: string, owner: string, transactionId: string): string {
  return `${prefix}${Buffer.from(owner).toString("base64url")}:${transactionId}`;
}

function parseMarker(
  subject: string,
  prefix: string,
): { marker: string; owner: string; transactionId: string } | null {
  const start = subject.lastIndexOf(prefix);
  if (start < 0) return null;
  const marker = subject.slice(start);
  const body = marker.slice(prefix.length);
  const separator = body.indexOf(":");
  if (separator <= 0) return null;
  const encodedOwner = body.slice(0, separator);
  const transactionId = body.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encodedOwner) || !TRANSACTION_ID.test(transactionId)) {
    return null;
  }
  try {
    const owner = Buffer.from(encodedOwner, "base64url").toString("utf8");
    if (!owner || markerFor(prefix, owner, transactionId) !== marker) return null;
    return { marker, owner, transactionId };
  } catch {
    return null;
  }
}

function parseStashList(stdout: string, prefix: string): StashEntry[] {
  const entries: StashEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const firstTab = line.indexOf("\t");
    if (firstTab <= 0) continue;
    const oid = line.slice(0, firstTab);
    const subject = line.slice(firstTab + 1);
    if (!STASH_OID.test(oid)) continue;
    const parsed = parseMarker(subject, prefix);
    if (!parsed) continue;
    entries.push({ oid, ...parsed });
  }
  return entries;
}

function commandDetail(result: CommandResult): string | null {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (!combined) return null;
  return combined.length > 2_000 ? `…${combined.slice(-2_000)}` : combined;
}

function joinDetails(results: CommandResult[]): string | null {
  const details = results
    .filter(
      (result) => result.code !== 0 || result.failedToSpawn || result.timedOut,
    )
    .map(commandDetail)
    .filter((detail): detail is string => detail !== null);
  return details.length > 0 ? details.join("\n\n") : null;
}

function commandReason(result: CommandResult, fallback: string): string {
  if (result.failedToSpawn) return "The required command could not be started.";
  if (result.timedOut) return "The checkout command timed out.";
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== "aborting");
  return (lines.find((line) => line.startsWith("error:")) ?? lines[0] ?? fallback)
    .replace(/^error:\s*/, "")
    .replace(/:$/, ".");
}

function isTrackedCheckoutConflict(result: CommandResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  if (
    /untracked working tree files would be overwritten/i.test(output) ||
    /move or remove them before you switch branches/i.test(output)
  ) {
    return false;
  }
  return (
    /your local changes to the following files would be overwritten by (?:checkout|switching branches)/i.test(
      output,
    ) ||
    /commit your changes or stash them before you switch branches/i.test(output)
  );
}

async function listOwnedStashes(
  deps: StashInspectionDependencies,
  prefix: string,
): Promise<StashList> {
  const result = await deps.runGit([
    "stash",
    "list",
    "--format=%H%x09%gs",
  ]);
  if (result.code !== 0) {
    return {
      entries: null,
      result,
      error: commandReason(result, "Git could not inspect the stash list."),
    };
  }
  return { entries: parseStashList(result.stdout, prefix), result, error: null };
}

async function readStashHead(
  deps: SmartCheckoutDependencies,
): Promise<
  | { oid: string | null; result: CommandResult; error: null }
  | { oid: null; result: CommandResult; error: string }
> {
  const result = await deps.runGit([
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/stash",
  ]);
  const oid = result.stdout.trim();
  if (result.code === 0 && STASH_OID.test(oid)) {
    return { oid, result, error: null };
  }
  // --quiet exits 1 with no output when the repository has no stash yet.
  if (
    result.code === 1 &&
    !result.failedToSpawn &&
    !result.timedOut &&
    !result.stdout.trim() &&
    !result.stderr.trim()
  ) {
    return { oid: null, result, error: null };
  }
  return {
    oid: null,
    result,
    error: commandReason(result, "Git could not identify the stash reference."),
  };
}

async function createAutoStash(
  owner: string,
  deps: SmartCheckoutDependencies,
): Promise<
  | { entry: StashEntry; details: CommandResult[]; error: null }
  | { entry: null; details: CommandResult[]; error: string }
> {
  const details: CommandResult[] = [];
  const before = await readStashHead(deps);
  details.push(before.result);
  if (before.error) return { entry: null, details, error: before.error };

  const transactionId = (deps.transactionId ?? randomUUID)();
  if (!TRANSACTION_ID.test(transactionId)) {
    return {
      entry: null,
      details,
      error: "The plugin could not create a safe auto-stash identifier.",
    };
  }
  const marker = markerFor(AUTO_STASH_PREFIX, owner, transactionId);
  // Deliberately omit -u/--include-untracked: unrelated untracked files stay
  // in the worktree and can still block the retry without ever being stashed.
  const push = await deps.runGit(["stash", "push", "-m", marker], 30_000);
  details.push(push);

  const after = await readStashHead(deps);
  details.push(after.result);
  if (after.error) return { entry: null, details, error: after.error };
  const list = await listOwnedStashes(deps, AUTO_STASH_PREFIX);
  details.push(list.result);
  if (list.error !== null) return { entry: null, details, error: list.error };

  const entry = list.entries.find(
    (candidate) => candidate.oid === after.oid && candidate.marker === marker,
  );
  if (!entry || !after.oid || after.oid === before.oid) {
    return {
      entry: null,
      details,
      error:
        push.code === 0
          ? "Git reported success but did not create the plugin auto-stash. Checkout was stopped."
          : commandReason(push, "Git could not stash the tracked changes."),
    };
  }
  // A timeout can race with a completed stash write. The verified unique
  // marker and changed refs/stash are the authoritative postcondition.
  return { entry, details, error: null };
}

async function readHandledStashOids(
  deps: StashInspectionDependencies,
): Promise<StashState> {
  const result = await deps.runGit([
    "for-each-ref",
    "--format=%(objectname)",
    STASH_STATE_PREFIX,
  ]);
  if (result.code !== 0) {
    return {
      oids: null,
      result,
      error: commandReason(result, "Git could not inspect plugin stash state."),
    };
  }
  return {
    oids: new Set(
      result.stdout
        .split("\n")
        .map((oid) => oid.trim())
        .filter((oid) => STASH_OID.test(oid)),
    ),
    result,
    error: null,
  };
}

// Branches whose tracked changes are still waiting in a plugin-owned stash.
// A handled stash remains in Git as a recovery backup but is no longer active.
export async function activeAutoStashOwners(
  deps: StashInspectionDependencies,
): Promise<Set<string> | null> {
  const auto = await listOwnedStashes(deps, AUTO_STASH_PREFIX);
  if (auto.error !== null) return null;
  const state = await readHandledStashOids(deps);
  if (state.error !== null) return null;

  return new Set(
    auto.entries
      .filter(
        (entry) =>
          !state.oids.has(entry.oid) &&
          !deps.blockedStashOids?.has(entry.oid),
      )
      .map((entry) => entry.owner),
  );
}

// "On <branch>: …" / "WIP on <branch>: …" — how Git records the branch a
// stash was taken from. Anchored, so a branch name appearing later in a
// hand-written message cannot be mistaken for the owner.
const STASH_BRANCH = /^(?:WIP on|On) ([^:]+):/;

// How many stash entries exist per branch, counting every entry Git holds —
// this plugin's auto-stashes as well as ones made by hand or by another tool.
// Null when the stash list could not be read, so the caller can tell "no
// stashes" from "unknown".
export async function stashCountsByBranch(
  deps: StashInspectionDependencies,
): Promise<Map<string, number> | null> {
  const result = await deps.runGit(["stash", "list", "--format=%gs"]);
  if (result.code !== 0) return null;
  const counts = new Map<string, number>();
  for (const line of result.stdout.split("\n")) {
    const match = STASH_BRANCH.exec(line.trim());
    if (!match) continue;
    const branch = match[1].trim();
    if (!branch) continue;
    counts.set(branch, (counts.get(branch) ?? 0) + 1);
  }
  return counts;
}

async function markEntryHandled(
  entry: StashEntry,
  deps: SmartCheckoutDependencies,
): Promise<{ durable: boolean; details: CommandResult[] }> {
  deps.blockedStashOids?.add(entry.oid);
  const details: CommandResult[] = [];
  const stateRef = `${STASH_STATE_PREFIX}${Buffer.from(entry.owner).toString("base64url")}/${entry.transactionId}`;
  // The empty expected value means create-only. A UUID collision cannot
  // overwrite another transaction's state.
  const update = await deps.runGit(
    ["update-ref", stateRef, entry.oid, ""],
    15_000,
  );
  details.push(update);
  const verify = await deps.runGit(["rev-parse", "--verify", stateRef]);
  details.push(verify);
  return {
    durable: update.code === 0 && verify.code === 0 && verify.stdout.trim() === entry.oid,
    details,
  };
}

async function restoreEntry(
  entry: StashEntry,
  expectedBranch: string,
  deps: SmartCheckoutDependencies,
): Promise<RestoreOutcome> {
  const current = await deps.currentBranch();
  if (current !== expectedBranch) {
    return {
      ok: false,
      status: "failed",
      message: `Checkout moved to ${current ?? "a detached HEAD"}; plugin stash ${entry.oid.slice(0, 8)} was retained without applying it.`,
      details: [],
    };
  }

  const details: CommandResult[] = [];
  const apply = await deps.runGit(
    ["stash", "apply", "--index", entry.oid],
    30_000,
  );
  details.push(apply);
  if (apply.code !== 0) {
    const handled = await markEntryHandled(entry, deps);
    details.push(...handled.details);
    return {
      ok: false,
      status: "failed",
      message: `Restoring plugin stash ${entry.oid.slice(0, 8)} conflicted or failed. Its changes may be partially applied; the stash was retained${handled.durable ? " for manual recovery" : " and will not be retried automatically while this plugin is running"}.`,
      details,
    };
  }

  // Never delete by stash@{n}: another process can push a handmade stash
  // between selector verification and deletion. Mark this immutable OID as
  // consumed instead and retain the plugin stash as a recovery backup.
  const handled = await markEntryHandled(entry, deps);
  details.push(...handled.details);
  return {
    ok: handled.durable,
    status: handled.durable ? "restored" : "failed",
    message: handled.durable
      ? "Its plugin-stashed changes are back in the working tree; the plugin stash remains as a recovery backup."
      : `The changes from plugin stash ${entry.oid.slice(0, 8)} were restored, but Git could not record that restoration durably. The stash remains as a backup and will not be retried automatically while this plugin is running.`,
    details,
  };
}

async function restoreLatestForBranch(
  branch: string,
  deps: SmartCheckoutDependencies,
): Promise<RestoreOutcome> {
  const auto = await listOwnedStashes(deps, AUTO_STASH_PREFIX);
  if (auto.error !== null) {
    return {
      ok: false,
      status: "failed",
      message: `Checked out ${branch}, but Git could not inspect plugin auto-stashes: ${auto.error}`,
      details: [auto.result],
    };
  }
  const state = await readHandledStashOids(deps);
  if (state.error !== null) {
    return {
      ok: false,
      status: "failed",
      message: `Checked out ${branch}, but Git could not inspect plugin stash state: ${state.error}`,
      details: [auto.result, state.result],
    };
  }
  const entry = auto.entries.find(
    (candidate) =>
      candidate.owner === branch &&
      !state.oids.has(candidate.oid) &&
      !deps.blockedStashOids?.has(candidate.oid),
  );
  if (!entry) {
    return {
      ok: true,
      status: "none",
      message: null,
      details: [auto.result, state.result],
    };
  }
  const restored = await restoreEntry(entry, branch, deps);
  return {
    ...restored,
    details: [auto.result, state.result, ...restored.details],
  };
}

async function finishCheckout(
  target: string,
  sourceStash: StashEntry | null,
  checkoutResults: CommandResult[],
  deps: SmartCheckoutDependencies,
): Promise<SmartCheckoutResult> {
  const restored = await restoreLatestForBranch(target, deps);
  const parts = [`Checked out ${target}.`];
  if (sourceStash) {
    parts.push(
      `Tracked changes are safely stored in plugin stash ${sourceStash.oid.slice(0, 8)} and return when ${sourceStash.owner} is checked out again.`,
    );
  }
  if (restored.message) parts.push(restored.message);
  return {
    ok: restored.ok,
    message: parts.join(" "),
    detail: joinDetails([...checkoutResults, ...restored.details]),
  };
}

export async function checkoutWithAutoStash(
  target: string,
  deps: SmartCheckoutDependencies,
): Promise<SmartCheckoutResult> {
  const details: CommandResult[] = [];
  const source = await deps.currentBranch();
  const initial = await deps.checkout(target);
  details.push(initial);
  let actual = await deps.currentBranch();

  // Branch state is the postcondition. gh-stack can return nonzero after Git
  // has already switched branches, and exit 0 is not enough on its own.
  if (actual === target) return finishCheckout(target, null, details, deps);

  const fallback = `gh stack checkout exited with code ${initial.code}.`;
  if (
    initial.code === 0 ||
    !source ||
    actual !== source ||
    !isTrackedCheckoutConflict(initial)
  ) {
    return {
      ok: false,
      message:
        actual && actual !== source
          ? `Checkout did not reach ${target}; the workspace is now on ${actual}. ${commandReason(initial, fallback)}`
          : commandReason(initial, fallback),
      detail: joinDetails(details),
    };
  }

  const tracked = await deps.runGit([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
  ]);
  details.push(tracked);
  if (tracked.code !== 0 || tracked.stdout.length === 0) {
    return {
      ok: false,
      message:
        tracked.code === 0
          ? commandReason(initial, fallback)
          : "Git could not verify the tracked changes that blocked checkout.",
      detail: joinDetails(details),
    };
  }

  const created = await createAutoStash(source, deps);
  details.push(...created.details);
  if (created.error !== null) {
    return {
      ok: false,
      message: `Local tracked changes block checkout and could not be safely auto-stashed: ${created.error}`,
      detail: joinDetails(details),
    };
  }

  const retry = await deps.checkout(target);
  details.push(retry);
  actual = await deps.currentBranch();
  if (actual === target) {
    return finishCheckout(target, created.entry, details, deps);
  }

  if (actual !== source) {
    const rollback = await deps.checkout(source);
    details.push(rollback);
    actual = await deps.currentBranch();
  }
  if (actual !== source) {
    return {
      ok: false,
      message: `Checkout did not reach ${target}, and rollback could not return to ${source}; the workspace is on ${actual ?? "a detached HEAD"}. Plugin stash ${created.entry.oid.slice(0, 8)} was retained without applying it.`,
      detail: joinDetails(details),
    };
  }

  const restored = await restoreEntry(created.entry, source, deps);
  details.push(...restored.details);
  return {
    ok: false,
    message: restored.ok
      ? `${commandReason(retry, fallback)} The workspace returned to ${source}, and its tracked changes were restored.`
      : `${commandReason(retry, fallback)} The workspace returned to ${source}. ${restored.message}`,
    detail: joinDetails(details),
  };
}
