import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import {
  INITIATIVES_CHANNEL,
  type Initiative,
  type InitiativeContextDoc,
} from "@/lib/initiative-types";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import { eventTargetsDoc, eventTargetsInitiative, resolveDocRead } from "@/lib/initiative-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/**
 * The shared context tree + editor. Documents are server-authoritative rows
 * (`listContextDocs` returns the derived tree); a write carries the
 * `expectedRevision` CAS guard from the read, so a concurrent agent write
 * surfaces as a conflict instead of a silent overwrite.
 */
export function ContextDocs({ initiative }: { initiative: Initiative }) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [docs, setDocs] = useState<readonly InitiativeContextDoc[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Generation guard: switching initiatives must not let the previous
  // project's in-flight list read overwrite the new one's state.
  const generation = useRef(0);

  const reload = useCallback(() => {
    const gen = ++generation.current;
    rpc
      .call("listContextDocs", { initiativeId: initiative.id })
      .then((result) => {
        if (gen !== generation.current) return;
        setDocs(result.docs);
        setStatus("ready");
      })
      .catch(() => {
        if (gen !== generation.current) return;
        setStatus("error");
      });
  }, [initiative.id, rpc]);

  // Project switch: reset the selection and editor alongside the tree so a
  // stale path from another project can never open for editing.
  useEffect(() => {
    generation.current += 1;
    setDocs([]);
    setSelected(null);
    setCreating(false);
    setStatus("loading");
    reload();
  }, [reload, initiative.id]);

  // Agent writes publish on the initiatives channel — refresh the tree so
  // agent-created docs appear without a manual reload. Events naming another
  // initiative are not this tree's business.
  useRealtime(
    INITIATIVES_CHANNEL,
    useCallback(
      (payload: unknown) => {
        if (eventTargetsInitiative(payload, initiative.id)) reload();
      },
      [initiative.id, reload],
    ),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-context-docs="">
      <div className="flex items-center gap-1 px-1 pb-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Context
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="New context document"
          title="New document"
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh"
          onClick={reload}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="Refresh" className="size-3" aria-hidden />
        </button>
      </div>
      {status === "loading" ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
      ) : status === "error" ? (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">Couldn’t load context</span>
          <Button variant="ghost" size="xs" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : docs.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          No shared context yet. Documents here are visible to the coordinator and every agent.
        </p>
      ) : (
        <ul className="flex max-h-48 flex-col gap-px overflow-y-auto">
          {docs.map((doc) => (
            <DocNode
              key={doc.path}
              doc={doc}
              depth={0}
              selected={selected}
              onSelect={(path) => {
                setCreating(false);
                setSelected(path);
              }}
            />
          ))}
        </ul>
      )}
      {listError !== null ? (
        <p role="alert" className="px-2 pt-1 text-2xs text-destructive">
          {listError}
        </p>
      ) : null}
      <div className="mt-2 min-h-0 flex-1 border-t border-border pt-2">
        {creating ? (
          <NewDocForm
            initiative={initiative}
            onCreated={(path) => {
              setCreating(false);
              setSelected(path);
              reload();
            }}
            onCancel={() => setCreating(false)}
          />
        ) : selected !== null ? (
          <DocEditor
            key={`${initiative.id}:${selected}`}
            initiative={initiative}
            path={selected}
            onChanged={reload}
            onDeleted={() => {
              setSelected(null);
              reload();
            }}
            onError={setListError}
          />
        ) : (
          <p className="px-2 py-2 text-2xs text-muted-foreground">
            Select a document to read or edit.
          </p>
        )}
      </div>
    </div>
  );
}

function DocNode({
  doc,
  depth,
  selected,
  onSelect,
}: {
  doc: InitiativeContextDoc;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const name = doc.path.split("/").pop() ?? doc.path;
  if (doc.kind === "directory") {
    return (
      <li className="list-none">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <Icon name={open ? "FolderOpen" : "Folder"} className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{name}</span>
        </button>
        {open ? (
          <ul>
            {(doc.children ?? []).map((child) => (
              <DocNode
                key={child.path}
                doc={child}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => onSelect(doc.path)}
        aria-current={selected === doc.path}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-xs hover:bg-accent/50",
          selected === doc.path && "bg-accent/60",
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <Icon name="FileText" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{name}</span>
      </button>
    </li>
  );
}

function NewDocForm({
  initiative,
  onCreated,
  onCancel,
}: {
  initiative: Initiative;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^/\0]([^/\0]+\/)*[^/\0]+$/.test(path.trim());

  return (
    <div className="flex flex-col gap-2 px-1" data-context-new-doc="">
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Path</span>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="notes/plan.md"
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
          }}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={!valid || busy}
          onClick={() => {
            setBusy(true);
            // expectedRevision 0 = "create only if absent". Without it a
            // duplicate create would blank a document that already exists.
            rpc
              .call("writeContextDoc", {
                initiativeId: initiative.id,
                path: path.trim(),
                content: "",
                expectedRevision: 0,
              })
              .then((result) => {
                if (result.outcome === "written") onCreated(path.trim());
                else setError("A document already exists at that path.");
              })
              .catch((writeError: unknown) =>
                setError(writeError instanceof Error ? writeError.message : "Create failed"),
              )
              .finally(() => setBusy(false));
          }}
        >
          Create
        </Button>
      </div>
    </div>
  );
}

function DocEditor({
  initiative,
  path,
  onChanged,
  onDeleted,
  onError,
}: {
  initiative: Initiative;
  path: string;
  onChanged: () => void;
  /** The open document disappeared — parent clears the selection. */
  onDeleted: () => void;
  onError: (message: string | null) => void;
}) {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const deleted = useRef(false);
  const dirtyRef = useRef(false);

  const read = useCallback(
    (opts?: { force?: boolean }) => {
      const gen = ++generation.current;
      rpc
        .call("readContextDoc", { initiativeId: initiative.id, path })
        .then((result) => {
          const resolution = resolveDocRead({
            stale: gen !== generation.current,
            dirty: dirtyRef.current,
            deleted: deleted.current,
            force: opts?.force === true,
          });
          if (resolution === "ignore") return;
          if (resolution === "conflict") {
            // Typing began while this read was in flight. Keep the draft and
            // leave `revision` on the baseline — bumping it would let a later
            // save silently overwrite the newer server version.
            setConflict(true);
            return;
          }
          deleted.current = false;
          setContent(result.content);
          setDraft(result.content);
          setRevision(result.revision);
          setConflict(false);
          setError(null);
        })
        .catch((readError: unknown) => {
          if (gen !== generation.current) return;
          // A read that 404s after a delete is the delete landing, not an error.
          if (deleted.current) return;
          setError(readError instanceof Error ? readError.message : "Read failed");
        });
    },
    [initiative.id, path, rpc],
  );

  useEffect(() => {
    read();
  }, [read]);

  const dirty = content !== null && draft !== content;
  // Async reads must observe only committed editor state. Mutating the ref
  // during render can leak a concurrent render that React later abandons.
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Agent writes publish on the initiatives channel. A clean editor re-reads
  // and shows the new version; a dirty human draft is never clobbered — it
  // gets the "changed elsewhere" affordance instead.
  useRealtime(
    INITIATIVES_CHANNEL,
    useCallback(
      (payload: unknown) => {
        if (!eventTargetsInitiative(payload, initiative.id)) return;
        if (!eventTargetsDoc(payload, path)) return;
        if (dirtyRef.current) setConflict(true);
        else read();
      },
      [initiative.id, path, read],
    ),
  );

  const save = () => {
    setBusy(true);
    setError(null);
    rpc
      .call("writeContextDoc", {
        initiativeId: initiative.id,
        path,
        content: draft,
        expectedRevision: revision,
      })
      .then((result) => {
        if (result.outcome === "conflict") {
          // Another writer (agent or human) won the CAS. Keep the draft —
          // Reload shows their version, Save retries against it.
          setConflict(true);
          return;
        }
        setContent(draft);
        setRevision(result.revision);
        setConflict(false);
        onChanged();
      })
      .catch((writeError: unknown) =>
        setError(writeError instanceof Error ? writeError.message : "Save failed"),
      )
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    onError(null);
    rpc
      .call("deleteContextDoc", { initiativeId: initiative.id, path })
      .then(() => {
        deleted.current = true;
        onDeleted();
      })
      .catch((deleteError: unknown) =>
        onError(deleteError instanceof Error ? deleteError.message : "Delete failed"),
      )
      .finally(() => setBusy(false));
  };

  if (content === null && error === null) {
    return <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex h-full min-h-40 flex-col gap-1.5" data-context-editor={path}>
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate px-1 text-2xs text-muted-foreground" title={path}>
          {path}
        </span>
        <button
          type="button"
          aria-label={preview ? "Edit" : "Preview"}
          title={preview ? "Edit" : "Preview"}
          onClick={() => setPreview((value) => !value)}
          className={cn(
            "flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
            preview && "bg-accent text-foreground",
          )}
        >
          <Icon name="FileText" className="size-3" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Delete ${path}`}
          title="Delete document"
          onClick={remove}
          disabled={busy}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive-text"
        >
          <Icon name="Delete" className="size-3" aria-hidden />
        </button>
      </div>
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-background p-2 text-xs">
          <Markdown content={draft} />
        </div>
      ) : (
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={`Edit ${path}`}
          className="min-h-0 w-full flex-1 resize-none rounded-md border border-border bg-background p-2 font-mono text-2xs outline-none focus:border-ring"
        />
      )}
      {conflict ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-border bg-accent/40 px-2 py-1 text-2xs"
        >
          <span className="min-w-0 flex-1">
            Changed elsewhere — reload discards this draft and shows the newer version.
          </span>
          <Button variant="ghost" size="xs" onClick={() => read({ force: true })}>
            Reload
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        <span className="text-2xs text-muted-foreground">rev {revision}</span>
        <Button size="xs" disabled={!dirty || busy} onClick={save}>
          <Icon name="Save" className="size-3" aria-hidden />
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
