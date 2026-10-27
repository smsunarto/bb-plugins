import { useMemo, useRef, useState } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { gtdSidebarRpcContract } from "../lib/rpc-contract";
import { useCommittedEvent } from "./use-committed-event";
import { useRetained } from "./use-retained";

const NO_FAMILIES: readonly string[] = [];

/** A fold this window asked for that its fold read may not show. */
interface FoldIntent {
  collapsed: boolean;
  /** Unanswered: it holds over every read. */
  pending: boolean;
}
const NO_INTENTS: ReadonlyMap<string, FoldIntent> = new Map();

export interface CollapsedThreadsApi {
  /** Thread ids whose children are folded away. */
  collapsedThreads: ReadonlySet<string>;
  toggleThread(threadId: string): void;
}

/**
 * thread-list's `collapsedThreads` preference as the inbox's fold state — the
 * same list the built-in sidebar folds by, so a family folded there is folded
 * here, and the fold survives a reload.
 *
 * The read is bb's cached `listCollapsedThreads`, keyed by the roster's
 * families: the backend folds families it has not seen before answering. A
 * new family set is a new read, so the last answer stays on screen while it
 * loads, and the new families stay folded until it lands.
 *
 * A toggle folds on the click and holds here, not as a bb prediction: bb
 * predicts only on the read keyed by the families at the click, and the
 * roster can move to another family set's cached read before a read taken
 * after the write lands. While its write is out the fold holds over every
 * read. Once answered, saved or not (host unreachable, thread-list off), it
 * holds until the read shows it or a read of the same families lands; that
 * read also carries any newer fold another window made.
 */
export function useCollapsedThreads(
  familyIds: readonly string[] = NO_FAMILIES,
): CollapsedThreadsApi {
  // Thread status updates replace the roster without changing its families.
  // Key the read on the sorted ids so those updates reuse it.
  const familyKey = [...new Set(familyIds)].sort().join("\u0000");
  const input = useMemo(
    () => ({ familyIds: familyKey ? familyKey.split("\u0000") : [...NO_FAMILIES] }),
    [familyKey],
  );
  const { data, error, isFetching } = useRpcQuery({
    contract: gtdSidebarRpcContract,
    method: "listCollapsedThreads",
    input,
  });
  const answer = useMemo(
    () =>
      data === undefined ? undefined : { familyIds: input.familyIds, threadIds: data.threadIds },
    [data, input],
  );
  const shown = useRetained(answer);

  const [intents, setIntents] = useState(NO_INTENTS);
  // A read of the same families landed when its data changed (nothing
  // predicts on it), or, since an unchanged answer keeps the old data, when a
  // fetch finished cleanly or a success cleared a failed refresh. The error is
  // a new object each render, so only whether there is one is compared.
  const failed = error !== null;
  const [checked, setChecked] = useState({ input, data, failed, isFetching });
  if (
    input !== checked.input ||
    data !== checked.data ||
    failed !== checked.failed ||
    isFetching !== checked.isFetching
  ) {
    setChecked({ input, data, failed, isFetching });
    const landed =
      input === checked.input &&
      data !== undefined &&
      !failed &&
      (data !== checked.data || (checked.isFetching && !isFetching) || checked.failed);
    const held = new Map(
      [...intents].filter(
        ([id, intent]) =>
          intent.pending ||
          (!landed && (data === undefined || data.threadIds.includes(id) !== intent.collapsed)),
      ),
    );
    if (held.size !== intents.size) setIntents(held);
  }

  const collapsedThreads = useMemo(() => {
    const folded = new Set(shown?.threadIds);
    const answered = new Set(shown?.familyIds);
    for (const id of input.familyIds) if (!answered.has(id)) folded.add(id);
    for (const [id, intent] of intents) {
      if (intent.collapsed) folded.add(id);
      else folded.delete(id);
    }
    return folded;
  }, [shown, input, intents]);

  const { mutate } = useRpcMutation({
    contract: gtdSidebarRpcContract,
    method: "setThreadCollapsed",
  });
  // Each family's newest toggle; an older write's answer leaves it alone.
  const lastWrite = useRef(0);
  const newest = useRef(new Map<string, number>());
  const toggleThread = useCommittedEvent((threadId: string) => {
    const collapsed = !collapsedThreads.has(threadId);
    const write = ++lastWrite.current;
    newest.current.set(threadId, write);
    const answered = () => {
      setIntents((current) =>
        newest.current.get(threadId) === write
          ? new Map(current).set(threadId, { collapsed, pending: false })
          : current,
      );
      return undefined;
    };
    setIntents((current) => new Map(current).set(threadId, { collapsed, pending: true }));
    mutate({ threadId, collapsed }).then(answered, answered);
  });
  return { collapsedThreads, toggleThread };
}
