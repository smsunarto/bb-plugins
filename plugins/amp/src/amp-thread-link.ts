import { execFile } from "node:child_process";
import { isValidAmpThreadId, isValidProviderSessionId, type OrbUsageRecord } from "./orb-usage.ts";
import type { AmpExecutionTarget } from "./execution-target.ts";

export const AMP_THREAD_LINK_KEY_PREFIX = "amp-thread-link:";

export function ampThreadLinkKey(threadId: string): string {
  return `${AMP_THREAD_LINK_KEY_PREFIX}${threadId}`;
}

export interface AmpThreadLinkRecord {
  providerSessionId: string;
  ampThreadId: string | null;
}

/** One bridge report, projected into the durable thread link and Orb UI state. */
export interface SessionLinkReport extends AmpThreadLinkRecord {
  usage: OrbUsageRecord;
}

export function buildSessionLinkCommandArgs(report: {
  sessionId: string;
  executionTarget: AmpExecutionTarget;
  ampThreadId: string | null;
}): string[] {
  return [
    "amp",
    "link-session",
    report.sessionId,
    report.executionTarget,
    ...(report.ampThreadId ? [report.ampThreadId] : []),
  ];
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function parseAmpThreadLinkRecord(value: unknown): AmpThreadLinkRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["providerSessionId", "ampThreadId"])) return null;
  if (!isValidProviderSessionId(record.providerSessionId)) return null;
  if (record.ampThreadId !== null && !isValidAmpThreadId(record.ampThreadId)) return null;
  return {
    providerSessionId: record.providerSessionId,
    ampThreadId: record.ampThreadId,
  };
}

/** Parse the private `bb amp link-session` wire format used by the ACP bridge. */
export function parseSessionLinkReport(argv: string[]): SessionLinkReport | null {
  const [command, providerSessionId, executionTarget, ampThreadId, ...extra] = argv;
  if (
    command !== "link-session" ||
    extra.length > 0 ||
    !isValidProviderSessionId(providerSessionId) ||
    (ampThreadId !== undefined && !isValidAmpThreadId(ampThreadId))
  ) {
    return null;
  }

  if (executionTarget === "local") {
    return {
      providerSessionId,
      ampThreadId: ampThreadId ?? null,
      usage: { providerSessionId, state: "local" },
    };
  }
  if (executionTarget !== "orb") return null;
  return ampThreadId === undefined
    ? {
        providerSessionId,
        ampThreadId: null,
        usage: { providerSessionId, state: "orb-starting" },
      }
    : {
        providerSessionId,
        ampThreadId,
        usage: { providerSessionId, state: "orb-active", ampThreadId },
      };
}

/** A provider session owns one Amp thread. Late starting reports cannot erase it. */
export function mergeAmpThreadLinkRecord(
  current: AmpThreadLinkRecord | null,
  incoming: AmpThreadLinkRecord,
): AmpThreadLinkRecord {
  if (current?.providerSessionId === incoming.providerSessionId && current.ampThreadId !== null) {
    return current;
  }
  return {
    providerSessionId: incoming.providerSessionId,
    ampThreadId: incoming.ampThreadId,
  };
}

/** Select only a link that belongs to bb's current provider session. */
export function currentAmpThreadId(
  providerSessionId: string,
  link: AmpThreadLinkRecord | null,
  usage: OrbUsageRecord | null,
): string | null {
  if (link?.providerSessionId === providerSessionId && link.ampThreadId !== null) {
    return link.ampThreadId;
  }
  if (usage?.providerSessionId === providerSessionId && usage.state === "orb-active") {
    return usage.ampThreadId;
  }
  return null;
}

type AmpArchiveAction = "archive" | "unarchive";

/**
 * Amp has one command for both directions — `threads archive <id>`, with
 * `--unarchive` to restore — so both directions share this runner.
 */
function runAmpArchiveCommand(
  ampCli: string,
  ampThreadId: string,
  action: AmpArchiveAction,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<void> {
  if (!isValidAmpThreadId(ampThreadId)) {
    return Promise.reject(new Error(`Invalid Amp thread id: ${ampThreadId}`));
  }

  const env: NodeJS.ProcessEnv = { ...sourceEnv, CI: "1", TERM: "dumb" };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    execFile(
      ampCli,
      buildAmpArchiveCommandArgs(ampThreadId, action),
      {
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(
          new Error(`Could not ${action} Amp thread ${ampThreadId}: ${detail}`, {
            cause: error,
          }),
        );
      },
    );
  });
}

export function buildAmpArchiveCommandArgs(
  ampThreadId: string,
  action: AmpArchiveAction,
): string[] {
  const args = ["threads", "archive", ampThreadId];
  return action === "archive" ? args : [...args, "--unarchive"];
}

/** Archive an existing Amp thread without starting or continuing an agent turn. */
export function archiveAmpThread(
  ampCli: string,
  ampThreadId: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return runAmpArchiveCommand(ampCli, ampThreadId, "archive", sourceEnv);
}

/** The mirror of `archiveAmpThread`, for a bb thread that came back. */
export function unarchiveAmpThread(
  ampCli: string,
  ampThreadId: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  return runAmpArchiveCommand(ampCli, ampThreadId, "unarchive", sourceEnv);
}

export const AMP_ARCHIVE_WATCH_KEY_PREFIX = "amp-archive-watch:";

export function ampArchiveWatchKey(threadId: string): string {
  return `${AMP_ARCHIVE_WATCH_KEY_PREFIX}${threadId}`;
}

export function threadIdFromArchiveWatchKey(key: string): string | null {
  if (!key.startsWith(AMP_ARCHIVE_WATCH_KEY_PREFIX)) return null;
  const threadId = key.slice(AMP_ARCHIVE_WATCH_KEY_PREFIX.length);
  return threadId.length === 0 ? null : threadId;
}

/**
 * One archived bb thread whose Amp thread is waiting to be given back.
 *
 * bb fires `thread.archived` but has no unarchive event, so the restore has to
 * be noticed rather than received. This row is what there is to notice: it says
 * which Amp thread this plugin archived, and it lives exactly as long as bb
 * still calls the bb thread archived.
 */
export interface AmpArchiveWatchRecord {
  ampThreadId: string;
  /** Failed restores so far. Kept to stop a permanent failure retrying forever. */
  failures: number;
}

export function parseAmpArchiveWatchRecord(value: unknown): AmpArchiveWatchRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["ampThreadId", "failures"])) return null;
  if (!isValidAmpThreadId(record.ampThreadId)) return null;
  if (
    typeof record.failures !== "number" ||
    !Number.isInteger(record.failures) ||
    record.failures < 0
  ) {
    return null;
  }
  return { ampThreadId: record.ampThreadId, failures: record.failures };
}

/**
 * How many times a restore may fail before the watch is dropped.
 *
 * The Amp CLI reaches the network, so one failure says nothing. A thread
 * deleted in Amp, though, fails identically and forever — and this poll runs on
 * a timer, so "forever" is a hot loop. Three attempts separates the two.
 */
export const MAX_ARCHIVE_WATCH_FAILURES = 3;

/** The record to store after a failed restore, or null to stop trying. */
export function archiveWatchRecordAfterFailure(
  record: AmpArchiveWatchRecord,
): AmpArchiveWatchRecord | null {
  const failures = record.failures + 1;
  return failures >= MAX_ARCHIVE_WATCH_FAILURES
    ? null
    : { ampThreadId: record.ampThreadId, failures };
}

/**
 * The watched bb threads bb no longer lists as archived.
 *
 * A truncated archive listing puts extra ids in here rather than missing one,
 * which is why the caller confirms each against the thread itself before
 * restoring anything.
 */
export function watchedThreadIdsToConfirm(
  watchKeys: readonly string[],
  archivedThreadIds: ReadonlySet<string>,
): string[] {
  const ids = [];
  for (const key of watchKeys) {
    const threadId = threadIdFromArchiveWatchKey(key);
    if (threadId !== null && !archivedThreadIds.has(threadId)) ids.push(threadId);
  }
  return ids;
}
