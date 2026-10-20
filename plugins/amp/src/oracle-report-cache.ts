import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { isOracleReportId, type OracleReport } from "./oracle-directive.ts";
import { appended, useThreadChanges } from "./thread-changes.ts";
import type { rpcContract } from "../server.ts";

export type OracleState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; report: OracleReport };

/** Enough for every Oracle card on a long thread and a few neighbours. */
const MAX_CACHED_REPORTS = 64;

/**
 * The last report each card loaded, by report id, shared by every card.
 *
 * bb remounts timeline rows and message directives when its renderer map
 * changes, and every remount used to show "Loading Oracle response…" and ask
 * the thread's host again. A finished report never changes, so a cached one
 * renders with no request; a running one renders at once and revalidates.
 * Least recently used reports go first past the cap.
 */
const reports = new Map<string, OracleReport>();

function remember(report: OracleReport): void {
  reports.delete(report.id);
  reports.set(report.id, report);
  for (const id of reports.keys()) {
    if (reports.size <= MAX_CACHED_REPORTS) break;
    reports.delete(id);
  }
}

function initialState(reportId: string | undefined): OracleState {
  if (!isOracleReportId(reportId)) {
    return { kind: "error", message: "The Oracle report reference is invalid." };
  }
  const cached = reports.get(reportId);
  return cached === undefined ? { kind: "loading" } : { kind: "ready", report: cached };
}

function settled(state: OracleState): boolean {
  return state.kind === "error" || (state.kind === "ready" && state.report.status !== "running");
}

/** Appends that can finish a running report: the bridge writes the body
 *  before it closes the Oracle row, and a drained turn settles it. */
const SETTLING_EVENTS = ["item/completed", "turn/completed"];

/**
 * An Oracle card's report. A running report refreshes when its thread closes
 * an item, finishes a turn, or changes status, instead of on a timer; nothing
 * listens once it finishes.
 */
export function useOracleReport(reportId: string | undefined, threadId: string): OracleState {
  const rpc = useRpc<typeof rpcContract>();
  const [current, setCurrent] = useState(() => ({ reportId, state: initialState(reportId) }));
  const state = current.reportId === reportId ? current.state : initialState(reportId);
  const latest = useRef(state);
  latest.current = state;
  const sequence = useRef(0);

  const load = useCallback(() => {
    if (!isOracleReportId(reportId)) return;
    const seq = ++sequence.current;
    const apply = (next: OracleState) => {
      if (seq === sequence.current) setCurrent({ reportId, state: next });
    };
    // A running card keeps its last report through a miss or a failed
    // request; the next change or reconnect asks again.
    const running = () =>
      latest.current.kind === "ready" && latest.current.report.status === "running";
    void rpc
      .call("getOracleReport", { reportId, threadId })
      .then((result) => {
        if (result.report !== null) {
          remember(result.report);
          apply({ kind: "ready", report: result.report });
        } else if (!running()) {
          apply({ kind: "error", message: result.error ?? "The Oracle report is unavailable." });
        }
        return null;
      })
      .catch(() => {
        if (!running()) apply({ kind: "error", message: "The Oracle report request failed." });
      });
  }, [reportId, threadId, rpc]);

  useEffect(() => {
    const initial = initialState(reportId);
    if (initial.kind === "ready") remember(initial.report);
    if (!settled(initial)) load();
    return () => {
      sequence.current += 1;
    };
  }, [reportId, load]);

  // Listening starts with the first read: a report that finishes before that
  // read answers "running" is read again, and the newer answer wins.
  useThreadChanges(
    threadId,
    !settled(state),
    (event) => event.changes.includes("status-changed") || appended(event, SETTLING_EVENTS),
    load,
  );
  return state;
}
