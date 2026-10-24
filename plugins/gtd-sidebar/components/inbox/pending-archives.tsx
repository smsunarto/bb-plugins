import { useEffect, useRef, useState } from "react";
import {
  experimental_useThreadActions as useThreadActions,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { useCommittedEvent } from "../../hooks/use-committed-event";
import { ARCHIVE_ACTION_KEY } from "../../lib/thread-action-target";

const ARCHIVE_KEYS = [ARCHIVE_ACTION_KEY];

interface ArchiveRequest {
  id: number;
  thread: PluginThreadActionTarget;
}

/**
 * bb's own Archive, run for a thread settled from a row button or the
 * command palette, where no menu holds the thread's actions. bb's action owns
 * the parent confirmation, the split-pane cleanup and the Undo toast.
 *
 * The registry binds an action to one thread through a hook, and a list must
 * not subscribe every row to it to settle one. So each request mounts a
 * runner that reads the thread's Archive, starts it once, and unmounts.
 */
export function usePendingArchives() {
  const [requests, setRequests] = useState<readonly ArchiveRequest[]>([]);
  const nextId = useRef(0);
  const archive = useCommittedEvent((thread: PluginThreadActionTarget) => {
    const id = ++nextId.current;
    setRequests((current) => [...current, { id, thread }]);
  });
  const finish = useCommittedEvent((id: number) => {
    setRequests((current) => current.filter((request) => request.id !== id));
  });
  const runners = requests.map((request) => (
    <ArchiveRunner key={request.id} request={request} onDone={finish} />
  ));
  return { archive, runners };
}

function ArchiveRunner({
  request,
  onDone,
}: {
  request: ArchiveRequest;
  onDone: (id: number) => void;
}) {
  const [entry] = useThreadActions(request.thread, { keys: ARCHIVE_KEYS });
  const started = useRef(false);
  useEffect(() => {
    // Once per request: a strict-mode remount keeps the ref.
    if (started.current) return;
    started.current = true;
    // bb's action owns everything after the start, its confirmation
    // included, so the runner leaves as soon as the action is running.
    if (entry !== undefined && entry.action.disabled !== true) void entry.action.run();
    onDone(request.id);
  }, [entry, onDone, request.id]);
  return null;
}
