import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { experimental_useSidebarThreadActions as useSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { Button } from "../ui/button";
import { usePortalScopeProps } from "../../lib/portal-scope";

export function RenameThreadDialog({
  threadId,
  initialTitle,
  onClose,
}: {
  threadId: string;
  initialTitle: string;
  onClose: () => void;
}) {
  const actions = useSidebarThreadActions();
  const scope = usePortalScopeProps();
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await actions.rename(threadId, title.trim());
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Failed to rename thread");
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay {...scope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          {...scope}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <Dialog.Title className="text-sm font-medium">Rename thread</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            Choose a new title for this thread.
          </Dialog.Description>
          <form onSubmit={rename}>
            <label className="mt-4 block text-xs">
              Thread title
              <input
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onFocus={(event) => event.target.select()}
                disabled={busy}
                required
              />
            </label>
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive-text">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="outline" disabled={busy || !title.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
