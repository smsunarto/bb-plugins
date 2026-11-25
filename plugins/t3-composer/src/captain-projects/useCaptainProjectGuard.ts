import { useEffect, useSyncExternalStore } from "react";
import {
  experimental_useRpcQuery as useRpcQuery,
  type PluginComposerApi,
} from "@get-bb/plugin-sdk/app";
import { usePickerComposer } from "../composer-handle";
import { applySelection } from "../composer-settings/apply-selection";
import { CAPTAIN_PLUGIN_ID, captainProjectsContract } from "./contract";
import {
  fallbackProjectId,
  hiddenProjectIds,
  publishHiddenProjectIds,
  rememberVisibleProject,
  subscribeHiddenProjectIds,
} from "./hidden-projects";

const NO_INPUT = {};
/** BB refuses a project change while an upload, attachment copy or submit is in flight. */
export const MOVE_ATTEMPTS = 6;
export const MOVE_RETRY_MS = 500;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Moves a new-thread composer to `next`, retrying a refusal a few times: BB answers a refused
 * project change with the selection unchanged. Stops when the composer leaves the hidden
 * projects, after `attempts`, or when `signal` aborts.
 */
export async function moveOffHiddenProject(
  composer: Pick<PluginComposerApi, "setSelection">,
  next: string,
  isHidden: (projectId: string) => boolean,
  signal: AbortSignal,
  { attempts = MOVE_ATTEMPTS, retryMs = MOVE_RETRY_MS } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- each attempt waits on the one before.
    const { applied } = await applySelection(composer, { projectId: next });
    if (signal.aborted) return;
    const landed = applied?.projectId;
    if (landed !== undefined && !isHidden(landed)) return;
    if (attempt < attempts) {
      // oxlint-disable-next-line no-await-in-loop -- the retry is paced on purpose.
      await wait(retryMs, signal);
      if (signal.aborted) return;
    }
  }
}

/**
 * In a new-thread composer, reads the Captains projects from the Captain plugin, publishes
 * them for the project picker's content script, and moves the composer off one when it lands
 * there: picked by hand, remembered by BB from an earlier thread, or opened from its route.
 * The ids cached from the last answer apply before Captain answers; a failed read keeps them.
 * The move goes through `setSelection`, so BB also remembers the new project.
 */
export function useCaptainProjectGuard(): void {
  const composer = usePickerComposer();
  const newThread = composer.scope.kind === "new-thread";
  const projectId = newThread ? (composer.selection?.projectId ?? null) : null;
  const query = useRpcQuery({
    contract: captainProjectsContract,
    pluginId: CAPTAIN_PLUGIN_ID,
    method: "homeProjects",
    input: NO_INPUT,
    enabled: newThread,
  });
  const answered = query.data?.projectIds;
  const hidden = useSyncExternalStore(subscribeHiddenProjectIds, hiddenProjectIds);

  useEffect(() => {
    if (answered) publishHiddenProjectIds(answered);
  }, [answered]);

  useEffect(() => {
    if (projectId === null) return;
    const next = fallbackProjectId(projectId, hidden);
    if (next === null) {
      rememberVisibleProject(projectId);
      return;
    }
    const controller = new AbortController();
    void moveOffHiddenProject(composer, next, (id) => hidden.includes(id), controller.signal);
    return () => controller.abort();
  }, [composer, projectId, hidden]);
}
