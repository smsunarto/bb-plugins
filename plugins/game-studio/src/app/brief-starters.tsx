import { useEffect, useRef, useState } from "react";
import type { NodeKind } from "../shared/schema.ts";
import { Icon } from "./icons.tsx";
import { rpc } from "./rpc.ts";

/** Menu in the node's brief editor that inserts or appends a structured brief starter. */
export function BriefStarters({
  kind,
  hasDraft,
  onInsert,
}: {
  kind: NodeKind;
  hasDraft: boolean;
  onInsert: (text: string) => void;
}) {
  const templates = rpc.briefTemplates.useQuery({ kind }, { staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as globalThis.Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  if (templates.data && !templates.data.templates.length) return null;
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Escape closes the menu it contains.
    <div
      className="gs-brief-starters"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        root.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      }}
    >
      <button
        type="button"
        className="gs-brief-starters-trigger"
        title="Brief starters"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={templates.isPending}
        onClick={() => setOpen(!open)}
      >
        <Icon name="LayoutTemplate" />
        Starters
      </button>
      {open && (
        <div className="gs-brief-starters-menu" role="menu" aria-label="Brief starters">
          <small>{hasDraft ? "Append to the brief" : "Start the brief from"}</small>
          {templates.error ? (
            <button type="button" role="menuitem" onClick={() => void templates.refetch()}>
              Retry loading starters
            </button>
          ) : (
            templates.data?.templates.map((template) => (
              <button
                key={template.id}
                type="button"
                role="menuitem"
                title={template.text}
                onClick={() => {
                  onInsert(template.text);
                  setOpen(false);
                }}
              >
                {template.label}
              </button>
            ))
          )}
          <small>Fill in the [brackets], then connect references.</small>
        </div>
      )}
    </div>
  );
}
