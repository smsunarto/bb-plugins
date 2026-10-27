import * as Dialog from "@radix-ui/react-dialog";
import { useId, useState, type RefObject } from "react";

import type { ProjectScript } from "../../shared/thread-details.ts";
import { PORTAL_SCOPE, cx } from "./rows.tsx";

export type ScriptDraft = Pick<ProjectScript, "name" | "command">;

const FIELD =
  "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";
const BUTTON =
  "inline-flex h-8 items-center justify-center rounded-lg px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/** Add or edit one project script. The parent owns saving; this form only collects the draft. */
export function ScriptDialog({
  script,
  projectName,
  pending,
  returnFocus,
  onSave,
  onDelete,
  onClose,
}: {
  /** The script being edited, or null to add one. */
  script: ProjectScript | null;
  projectName: string | null;
  pending: boolean;
  /** Where focus goes when the dialog closes; the card that opened it has already closed. */
  returnFocus: RefObject<HTMLElement | null>;
  onSave(draft: ScriptDraft): void;
  onDelete(): void;
  onClose(): void;
}) {
  const id = useId();
  const [name, setName] = useState(script?.name ?? "");
  const [command, setCommand] = useState(script?.command ?? "");
  const valid = name.trim().length > 0 && command.trim().length > 0;
  const submit = () => {
    if (valid && !pending) onSave({ name: name.trim(), command: command.trim() });
  };
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay {...PORTAL_SCOPE} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...PORTAL_SCOPE}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/70 bg-popover p-4 text-popover-foreground shadow-xl outline-none"
        >
          <Dialog.Title className="text-sm font-semibold">
            {script ? "Edit project script" : "Add project script"}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Runs in a terminal at the thread's checkout
            {projectName ? `. Saved for every thread in ${projectName}.` : "."}
          </Dialog.Description>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium" htmlFor={`${id}-name`}>
              Name
              <input
                id={`${id}-name`}
                className={FIELD}
                value={name}
                maxLength={80}
                placeholder="Dev server"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium" htmlFor={`${id}-command`}>
              Command
              <textarea
                id={`${id}-command`}
                className={cx(FIELD, "min-h-20 resize-y font-mono")}
                value={command}
                maxLength={4000}
                placeholder="bun run dev"
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
                }}
              />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {script ? (
                <button
                  type="button"
                  className={cx(BUTTON, "me-auto text-destructive hover:bg-destructive/10")}
                  disabled={pending}
                  onClick={onDelete}
                >
                  Delete
                </button>
              ) : null}
              <Dialog.Close asChild>
                <button type="button" className={cx(BUTTON, "hover:bg-foreground/[0.06]")}>
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className={cx(BUTTON, "bg-primary text-primary-foreground hover:bg-primary/85")}
                disabled={!valid || pending}
              >
                {pending ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
