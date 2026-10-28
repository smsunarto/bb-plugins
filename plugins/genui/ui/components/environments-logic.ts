// Pure pieces of Environments (environments.tsx): which rows show, and which
// rows on screen need their git status and pull request (re)read.
import { defaultEnvironments, type EnvironmentInfo } from "../../core/environments";

/** Environment details read at once. */
export const DETAIL_CONCURRENCY = 3;

/** How old the detail of an environment with a running thread may get before it is read again. */
export const LIVE_DETAIL_MS = 30_000;

/** Rows per page once every environment is shown. */
export const ENVIRONMENT_PAGE = 25;

/** What the view shows: the default (live environments) or all of them, a page at a time. */
export interface EnvironmentsShown {
  readonly rows: readonly EnvironmentInfo[];
  /** Environments the default view leaves out, for "Show all N". 0 once all are shown. */
  readonly hidden: number;
  /** Rows past the pages shown, for "Show N more". */
  readonly more: number;
}

export function shownEnvironments(environments: readonly EnvironmentInfo[], all: boolean, pages: number): EnvironmentsShown {
  const { shown, filtered } = defaultEnvironments(environments);
  const pool = all || !filtered ? environments : shown;
  const limit = Math.max(1, pages) * ENVIRONMENT_PAGE;
  return {
    rows: pool.slice(0, limit),
    hidden: all || !filtered ? 0 : environments.length - shown.length,
    more: Math.max(0, pool.length - limit),
  };
}

/**
 * The on-screen environments whose detail should be read now, in screen
 * order: never read, or with a running thread and read more than
 * LIVE_DETAIL_MS ago. Ones being read are skipped.
 */
export function detailsDue(
  onScreen: readonly string[],
  environments: ReadonlyMap<string, EnvironmentInfo>,
  readAt: ReadonlyMap<string, number>,
  reading: ReadonlySet<string>,
  now: number,
): string[] {
  return onScreen.filter((id) => {
    const environment = environments.get(id);
    if (environment === undefined || reading.has(id)) return false;
    const at = readAt.get(id);
    if (at === undefined) return true;
    return environment.threadCounts.running > 0 && now - at > LIVE_DETAIL_MS;
  });
}
