import { useMemo, useRef, useState } from "react";
import { useCommittedEvent } from "./use-committed-event";

interface Queue<Entry, Result> {
  /** Boxed so a repeated entry is still its own write. */
  unsettled: readonly { entry: Entry }[];
  answer: Result | undefined;
}

export interface OrderedWrites<Entry, Result> {
  /** Sends once every earlier write has settled. */
  write(entry: Entry): Promise<Result>;
  /** Writes not answered yet, sent or waiting their turn, oldest first. */
  unsettled: readonly Entry[];
  /** The newest successful answer. */
  answer: Result | undefined;
}

/**
 * One window's writes, sent one at a time in click order. Each is its own
 * request, and separate requests can reach the backend out of order, so an
 * Undo sent beside its snooze could land first. bb predicts a write only once
 * it is sent, and only over a loaded read, so callers draw `unsettled` over
 * the read themselves; bb's prediction then holds the result until a read
 * taken after the write lands.
 */
export function useOrderedWrites<Entry, Result>(
  send: (entry: Entry) => Promise<Result>,
): OrderedWrites<Entry, Result> {
  const sendLatest = useCommittedEvent(send);
  const [queue, setQueue] = useState<Queue<Entry, Result>>({ unsettled: [], answer: undefined });
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const write = useCommittedEvent((entry: Entry): Promise<Result> => {
    const box = { entry };
    setQueue((current) => ({ ...current, unsettled: [...current.unsettled, box] }));
    const result = tail.current.then(() => sendLatest(entry));
    const settle = (answer?: { value: Result }) =>
      setQueue((current) => ({
        unsettled: current.unsettled.filter((other) => other !== box),
        answer: answer === undefined ? current.answer : answer.value,
      }));
    tail.current = result.then(
      (value) => settle({ value }),
      () => settle(),
    );
    return result;
  });
  const unsettled = useMemo(() => queue.unsettled.map(({ entry }) => entry), [queue.unsettled]);
  return { write, unsettled, answer: queue.answer };
}
