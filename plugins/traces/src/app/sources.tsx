import { useId, useState } from "react";
import type { FormEvent } from "react";
import type { SourceRoot, TraceStatus } from "../shared/schema.ts";
import { useTracesRpc } from "./rpc.ts";
import { providerLabel } from "./controls.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Field, FieldError, FieldLabel } from "./components/ui/field.tsx";
import { Input } from "./components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "./components/ui/item.tsx";
import { Label } from "./components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";

export function Sources({
  hostId,
  status,
  onClose,
  onSaved,
  onVerify,
  scanning,
}: {
  hostId: string;
  status: TraceStatus;
  onClose: () => void;
  onSaved: () => void;
  onVerify: () => void;
  scanning: boolean;
}) {
  const formId = useId();
  const client = useTracesRpc();
  const [roots, setRoots] = useState<SourceRoot[]>(
    status.roots.map(({ provider, path, enabled }) => ({ provider, path, enabled })),
  );
  const [provider, setProvider] = useState(status.providers[0]?.id ?? "claude-code");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function add(event: FormEvent) {
    event.preventDefault();
    const normalized = path.trim();
    if (!normalized.startsWith("/")) {
      setError("Use an absolute path on the selected host.");
      return;
    }
    if (roots.some((root) => root.path === normalized && root.provider === provider)) {
      setError("That source is already listed.");
      return;
    }
    setRoots([...roots, { provider, path: normalized, enabled: true }]);
    setPath("");
    setError("");
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await client.call("configureSources", { hostId, roots });
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save sources.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="tr-dialog max-h-[85vh] overflow-y-auto sm:max-w-xl"
        // A stray click outside must not discard source edits that are not saved yet.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Trace sources</DialogTitle>
          <DialogDescription>
            Read Claude Code and Codex session files on this host. Source files are never modified.
          </DialogDescription>
        </DialogHeader>
        <div className="tr-source-list">
          {roots.map((root) => {
            const current = status.roots.find(
              (item) => item.path === root.path && item.provider === root.provider,
            );
            const id = `${formId}-${root.provider}:${root.path}`;
            const state = current?.state;
            return (
              <Item
                variant="outline"
                size="sm"
                className="my-3"
                key={`${root.provider}:${root.path}`}
              >
                <ItemMedia>
                  <Checkbox
                    id={id}
                    checked={root.enabled}
                    onCheckedChange={(checked) =>
                      setRoots(
                        roots.map((item) =>
                          item === root ? { ...item, enabled: checked === true } : item,
                        ),
                      )
                    }
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    <Label htmlFor={id}>{providerLabel(root.provider)}</Label>
                  </ItemTitle>
                  <code className="text-xs break-all">{root.path}</code>
                  {current?.message && (
                    <small className="text-xs text-muted-foreground">{current.message}</small>
                  )}
                </ItemContent>
                <ItemActions>
                  <Badge variant={state === "missing" || state === "error" ? "warning" : "outline"}>
                    {state ?? "New"}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRoots(roots.filter((item) => item !== root))}
                  >
                    Remove source
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
        </div>
        <form onSubmit={add} className="tr-source-add">
          <Field className="flex-1 gap-1">
            <FieldLabel htmlFor={`${formId}-provider`}>Provider</FieldLabel>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger id={`${formId}-provider`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {status.providers.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="min-w-60 flex-1 gap-1">
            <FieldLabel htmlFor={`${formId}-path`}>Folder or JSONL file</FieldLabel>
            <Input
              id={`${formId}-path`}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/absolute/path/to/sessions"
              required
            />
          </Field>
          <Button type="submit" variant="outline" disabled={roots.length >= 32}>
            Add source
          </Button>
        </form>
        <FieldError>{error}</FieldError>
        <DialogFooter className="items-center">
          <span className="tr-index-count">
            {status.sessions.toLocaleString()} sessions · {status.events.toLocaleString()} events
            indexed
          </span>
          <Button variant="ghost" size="sm" disabled={scanning} onClick={onVerify}>
            {scanning ? "Verifying…" : "Verify sources"}
          </Button>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save sources"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
