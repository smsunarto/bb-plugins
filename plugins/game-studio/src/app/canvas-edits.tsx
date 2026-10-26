import { useState } from "react";
import type { BoardEdit, EditSummary } from "../shared/schema.ts";
import { Icon } from "./icons.tsx";
import { ago } from "./time.ts";

/*
 * What the agent changed on the board since the person last looked, with a way back. An
 * edit can be undone while it is still the board's latest content; undoing leaves its own
 * record, which can be redone the same way. The newest record's id is remembered per board
 * once dismissed, so the banner returns only for something new.
 */

/** One line per thing an edit changed, in the terms a person reads. */
export function editLines(summary: EditSummary): string[] {
  const name = (node: { title: string; type: string }) => `“${node.title}” (${node.type})`;
  return [
    ...summary.added.map((node) => `Added ${name(node)}`),
    ...summary.removed.map((node) => `Removed ${name(node)}`),
    ...summary.updated.map((node) => `Changed ${name(node)}: ${node.fields.join(", ")}`),
    ...summary.connected.map((wire) => `Connected ${wire.source} → ${wire.target}`),
    ...summary.disconnected.map((wire) => `Disconnected ${wire.source} → ${wire.target}`),
  ];
}
const byAgent = (edit: BoardEdit) => edit.threadId !== null && !edit.undoOf;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, id: string) {
  try {
    localStorage.setItem(key, id);
  } catch {
    /* Storage may be unavailable. */
  }
}

export function AgentEdits({
  edits,
  dirty,
  storageKey,
  onUndo,
}: {
  /** The board's edits, newest first. */
  edits: BoardEdit[];
  /** The canvas holds unsaved changes; an undo would save over them. */
  dirty: boolean;
  storageKey: string;
  onUndo?: (editId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => remembered(storageKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const newest = edits[0];
  // The newest record is the one to act on: an agent edit to undo, or an undo to redo.
  const quick = newest?.undoable ? newest : edits.find((edit) => byAgent(edit) && edit.undoable);
  if (!newest || newest.id === seen || !(byAgent(newest) || quick)) return null;
  const dismiss = () => {
    remember(storageKey, newest.id);
    setSeen(newest.id);
    setOpen(false);
  };
  const undo = async (editId: string) => {
    setBusy(true);
    setError("");
    try {
      await onUndo?.(editId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const why = (edit: BoardEdit) =>
    !onUndo
      ? "Undo is unavailable here."
      : !edit.undoable
        ? (edit.blocker ?? "The board has changed since this edit.")
        : dirty
          ? "Save your changes first."
          : undefined;
  const count = edits.filter(byAgent).length;
  return (
    <section className="gs-canvas-edits gs-notice" aria-label="Agent edits">
      <div className="gs-canvas-edits-row">
        <Icon name="Bot" />
        <span>
          {newest.undoOf
            ? "An agent edit was undone."
            : `The agent made ${count === 1 ? "an edit" : `${count} edits`} to this board.`}
        </span>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
        {quick && !open && (
          <button
            type="button"
            disabled={busy || !!why(quick)}
            title={why(quick)}
            onClick={() => void undo(quick.id)}
          >
            {quick.undoOf ? "Redo" : "Undo"}
          </button>
        )}
        <button type="button" className="gs-icon" aria-label="Dismiss" onClick={dismiss}>
          <Icon name="X" />
        </button>
      </div>
      {error && (
        <p className="gs-canvas-edits-error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <ol className="gs-canvas-edits-list">
          {edits.map((edit) => (
            <li key={edit.id} data-undo={edit.undoOf ? true : undefined}>
              <header>
                <span>{byAgent(edit) ? "Agent" : edit.undoOf ? "Undone" : "Studio"}</span>
                <time dateTime={new Date(edit.at).toISOString()}>{ago(edit.at)}</time>
                <button
                  type="button"
                  disabled={busy || !!why(edit)}
                  title={why(edit)}
                  onClick={() => void undo(edit.id)}
                >
                  {edit.undoOf ? "Redo" : "Undo"}
                </button>
              </header>
              <ul>
                {editLines(edit.summary).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
