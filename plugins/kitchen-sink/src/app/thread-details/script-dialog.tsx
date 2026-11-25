import { useId, useState, type RefObject } from "react";

import type { ProjectScript } from "../../shared/thread-details.ts";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { Textarea } from "../components/ui/textarea.tsx";

export type ScriptDraft = Pick<ProjectScript, "name" | "command">;

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
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        // The card that opened it has already closed, so focus returns to its menu trigger.
        onCloseAutoFocus={(event) => event.preventDefault()}
        onAfterCloseAutoFocus={() => returnFocus.current?.focus()}
        className="w-[min(28rem,calc(100vw-2rem))] gap-3 p-4"
      >
        <DialogHeader>
          <DialogTitle>{script ? "Edit project script" : "Add project script"}</DialogTitle>
          <DialogDescription>
            Runs in a terminal at the thread's checkout
            {projectName ? `. Saved for every thread in ${projectName}.` : "."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field className="gap-1">
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={80}
              placeholder="Dev server"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field className="gap-1">
            <FieldLabel htmlFor={`${id}-command`}>Command</FieldLabel>
            <Textarea
              id={`${id}-command`}
              className="min-h-20 resize-y font-mono"
              value={command}
              maxLength={4000}
              placeholder="bun run dev"
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {script ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="me-auto"
                disabled={pending}
                onClick={onDelete}
              >
                Delete
              </Button>
            ) : null}
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!valid || pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
