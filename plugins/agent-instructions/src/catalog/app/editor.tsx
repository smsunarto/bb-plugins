import { MarkdownEditor } from "@bb-plugins/markdown-editor";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Switch } from "../../../components/ui/switch.tsx";
import { queryClient } from "../../app/query.ts";
import { queryKey, useRpcQuery } from "../../app/rpc.ts";
import type { CatalogChange, CatalogListing } from "../contract.ts";
import "../../prompts/app/prompt-editor.css";
import { errorsOf, PublishNotices, useCatalogChange, useFocusOnMount } from "./shared.tsx";
import {
  draftKey,
  dropSkillDrafts,
  parseCatalogRoute,
  publishTrouble,
  setFlash,
  setSaving,
  takeFlash,
  typed,
  updateDraft,
  useDrafts,
  useGo,
  type CatalogSelection,
  type Doc,
  type Skill,
} from "./state.ts";

/** The Global tab's page: an overview, or the editor for one doc or skill file. */

function Overview({ listing }: { listing: CatalogListing }) {
  const [message] = useState(takeFlash);
  return (
    <div className="pe-editor">
      <header className="pe-editor-head">
        <div>
          <p className="pe-label">Global</p>
          <h2>Instructions and skills for every agent</h2>
        </div>
      </header>
      {message?.lines.map((line) => (
        <output key={line} className="pe-notice" data-tone={message.tone}>
          {line}
        </output>
      ))}
      <p className="pe-meta pe-wrap">
        bb gives every agent the enabled global instructions as one AGENTS.md, and lists the enabled
        skills. Pick a doc or skill in the sidebar to edit it.
      </p>
      {listing.published === null ? (
        <p className="pe-notice" data-tone="warn">
          Not published since bb started. Publishing runs at startup and after each change.
        </p>
      ) : (
        <PublishNotices outcome={listing.published} verb={null} />
      )}
    </div>
  );
}

type EditorSubject =
  | { kind: "doc"; doc: Doc }
  | {
      kind: "skill";
      skill: Skill;
      path: string;
      owner: string | undefined;
      trouble: string | null;
    };

type LoadedFile = {
  content: string | null;
  sha256: string | null;
  size: number;
  executable: boolean;
};

const isSave = (op: CatalogChange["op"] | undefined) => op === "saveFile" || op === "saveDoc";

/** What differs between a doc and a skill file, so the editor parts need not branch. */
function facts(subject: EditorSubject) {
  if (subject.kind === "doc") {
    const { doc } = subject;
    return {
      selection: { doc: doc.id } as CatalogSelection,
      name: doc.name,
      title: doc.name,
      kicker: "Global instructions",
      enabled: doc.enabled,
      origin: doc.origin,
      markdown: true,
      toggle: (enabled: boolean): CatalogChange => ({ op: "setDocEnabled", id: doc.id, enabled }),
      saveOp: (text: string, expected: string | null): CatalogChange => ({
        op: "saveDoc",
        id: doc.id,
        body: text,
        expectedSha256: expected ?? "",
      }),
    };
  }
  const { skill, path } = subject;
  return {
    selection: { skill: skill.name, path } as CatalogSelection,
    name: skill.name,
    title: path,
    kicker: `Skill · ${skill.name}`,
    enabled: skill.enabled,
    origin: skill.origin,
    markdown: /\.(md|markdown)$/i.test(path),
    toggle: (enabled: boolean): CatalogChange => ({
      op: "setSkillEnabled",
      name: skill.name,
      enabled,
    }),
    saveOp: (text: string, expected: string | null): CatalogChange => ({
      op: "saveFile",
      skill: skill.name,
      path,
      content: text,
      expectedSha256: expected,
    }),
  };
}

type Facts = ReturnType<typeof facts>;

/** One open file: its loaded text, its draft, and the change that edits it. */
function useOpenFile(selection: CatalogSelection) {
  const loaded = useRpcQuery("catalogFile", selection);
  const draft = useDrafts().get(draftKey(selection));
  const client = useQueryClient();
  const change = useCatalogChange();
  const refetch = () => client.invalidateQueries({ queryKey: queryKey("catalogFile", selection) });
  /** Runs a change; a conflict reloads the file so the editor shows what changed. */
  const run = async (op: CatalogChange) => {
    const result = await change.mutateAsync(op).catch(() => null);
    if (result?.outcome === "conflict") await refetch();
    return result;
  };
  return { key: draftKey(selection), selection, loaded, draft, client, change, refetch, run };
}

type OpenFile = ReturnType<typeof useOpenFile>;

function EditorPlaceholder() {
  return (
    <div className="pe-editor" aria-busy="true">
      <span className="pe-shimmer" style={{ width: "30%" }} />
      <span className="pe-shimmer" style={{ width: "50%", height: 18 }} />
      <div className="pe-textarea pe-placeholder" />
    </div>
  );
}

function RenameForm(props: { open: OpenFile; doc: Doc; onDone: () => void }) {
  const [name, setName] = useState(props.doc.name);
  const input = useFocusOnMount<HTMLInputElement>();
  return (
    <form
      className="pe-actions"
      aria-label="Rename doc"
      onSubmit={async (event) => {
        event.preventDefault();
        const done = await props.open.run({ op: "renameDoc", id: props.doc.id, name });
        if (done?.outcome === "saved") props.onDone();
      }}
    >
      <input
        ref={input}
        className="pe-input"
        aria-label="Doc name"
        maxLength={80}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onDone();
        }}
      />
      <button type="button" className="pe-button" onClick={props.onDone}>
        Cancel
      </button>
      <button
        type="submit"
        className="pe-button"
        data-primary
        disabled={props.open.change.isPending}
      >
        Rename
      </button>
    </form>
  );
}

function EditorHeader(props: {
  subject: EditorSubject;
  facts: Facts;
  open: OpenFile;
  editable: boolean;
  canSave: boolean;
  onSubmit: () => void;
}) {
  const { subject, facts: f, open, editable, canSave, onSubmit } = props;
  const [renaming, setRenaming] = useState(false);
  const busy = open.change.isPending;
  return (
    <header className="pe-editor-head">
      <div className="pe-head-title">
        <p className="pe-label">{f.kicker}</p>
        {renaming && subject.kind === "doc" ? (
          <RenameForm open={open} doc={subject.doc} onDone={() => setRenaming(false)} />
        ) : (
          <div className="pe-status-row">
            <h2 className={subject.kind === "skill" ? "pe-mono" : undefined}>{f.title}</h2>
            {subject.kind === "doc" && (
              <button type="button" className="pe-link" onClick={() => setRenaming(true)}>
                Rename
              </button>
            )}
          </div>
        )}
      </div>
      <div className="pe-actions pe-wrap-actions">
        <label className="pe-switch">
          <Switch
            checked={f.enabled}
            disabled={busy}
            aria-label={`${f.name} on`}
            onCheckedChange={(next) => void open.run(f.toggle(next))}
          />
          <span className="pe-meta">{f.enabled ? "On" : "Off"}</span>
        </label>
        {editable && (
          <>
            <button
              type="button"
              className="pe-button"
              disabled={open.draft === undefined || busy}
              onClick={() => updateDraft(open.key, () => undefined)}
            >
              Revert
            </button>
            <button
              type="button"
              className="pe-button"
              data-primary
              disabled={!canSave || busy}
              aria-keyshortcuts="Control+S Meta+S"
              onClick={onSubmit}
            >
              {busy && isSave(open.change.variables?.op) ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>
    </header>
  );
}

/** A button that asks once more before it acts. */
function ConfirmButton(props: {
  label: string;
  confirm: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        className="pe-button"
        disabled={props.disabled}
        onClick={() => setAsking(true)}
      >
        {props.label}
      </button>
    );
  }
  return (
    <span className="pe-actions">
      <button type="button" className="pe-button" onClick={() => setAsking(false)}>
        Cancel
      </button>
      <button
        type="button"
        className="pe-button"
        data-destructive
        disabled={props.disabled}
        onClick={() => {
          setAsking(false);
          props.onConfirm();
        }}
      >
        {props.confirm}
      </button>
    </span>
  );
}

function DocToolbar({ doc, open, moved }: { doc: Doc; open: OpenFile; moved: boolean }) {
  const go = useGo();
  return (
    <div className="pe-toolbar">
      <ConfirmButton
        label="Delete doc"
        confirm="Delete doc"
        disabled={open.change.isPending || moved}
        onConfirm={async () => {
          const done = await open.run({ op: "deleteDoc", id: doc.id, expectedSha256: doc.sha256 });
          if (done?.outcome !== "saved") return;
          updateDraft(open.key, () => undefined);
          setFlash({
            tone: "good",
            lines: [`Deleted ${doc.name}. Restore it from Recently deleted.`],
          });
          go(null);
        }}
      />
    </div>
  );
}

function SkillToolbar(props: { skill: Skill; path: string; open: OpenFile; file: LoadedFile }) {
  const { skill, path, open, file } = props;
  const go = useGo();
  const busy = open.change.isPending;
  const deleteFile = async (expectedSha256: string) => {
    const done = await open.run({ op: "deleteFile", skill: skill.name, path, expectedSha256 });
    if (done?.outcome !== "saved") return;
    updateDraft(open.key, () => undefined);
    go({ skill: skill.name, path: "SKILL.md" });
  };
  const deleteSkill = async () => {
    const done = await open.run({
      op: "deleteSkill",
      name: skill.name,
      expectedTreeSha: skill.treeSha,
    });
    if (done?.outcome !== "saved") return;
    dropSkillDrafts(skill.name);
    setFlash({
      tone: done.warnings.length > 0 ? "warn" : "good",
      lines: [`Deleted ${skill.name}. Restore it from Recently deleted.`, ...done.warnings],
    });
    go(null);
  };
  return (
    <div className="pe-toolbar">
      <NewFileForm skill={skill} onCreate={(next) => go({ skill: skill.name, path: next })} />
      {path !== "SKILL.md" && file.sha256 !== null && (
        <ConfirmButton
          label="Delete file"
          confirm="Delete file"
          disabled={busy}
          onConfirm={() => void deleteFile(file.sha256!)}
        />
      )}
      {file.sha256 === null && open.draft !== undefined && (
        <button
          type="button"
          className="pe-button"
          onClick={() => updateDraft(open.key, () => undefined)}
        >
          Discard new file
        </button>
      )}
      {path === "SKILL.md" && (
        <ConfirmButton
          label="Delete skill"
          confirm={`Delete ${skill.name}`}
          disabled={busy}
          onConfirm={() => void deleteSkill()}
        />
      )}
    </div>
  );
}

const SCRIPT = /\.(sh|py|js|ts|rb|pl)$/;

/** What is true of the file itself: off, shadowed, binary, new, or imported. */
function StateNotices(props: {
  subject: EditorSubject;
  facts: Facts;
  file: LoadedFile;
  changed: boolean;
}) {
  const { subject, facts: f, file, changed } = props;
  const skill = subject.kind === "skill" ? subject : null;
  return (
    <>
      {!f.enabled && (
        <p className="pe-notice">Off: agents do not get {skill ? "this skill" : "this text"}.</p>
      )}
      {skill?.owner !== undefined && skill !== null && (
        <p className="pe-notice" data-tone="warn">
          bb also delivers a skill named {skill.skill.name} from {skill.owner}. Agents see only one
          of them.
        </p>
      )}
      {skill?.trouble && (
        <p className="pe-notice" data-tone="bad">
          {skill.trouble}
        </p>
      )}
      {file.content === null && (
        <p className="pe-notice">
          This file is not editable text ({file.size.toLocaleString()} bytes). It is published as it
          is.
        </p>
      )}
      {file.content !== null && file.sha256 === null && (
        <p className="pe-notice">
          New file. Save to add it to {f.name}.
          {skill && SCRIPT.test(skill.path) && " Start it with #! to make it executable."}
        </p>
      )}
      {f.origin.kind === "imported" && changed && (
        <p className="pe-notice">
          Imported from {f.origin.from}. Saving makes it yours: later imports keep your version.
        </p>
      )}
    </>
  );
}

function verbFor(change: CatalogChange | undefined): string {
  if (change?.op === "setSkillEnabled" || change?.op === "setDocEnabled")
    return change.enabled ? "Turned on" : "Turned off";
  return change?.op === "renameDoc" ? "Renamed" : "Saved";
}

/** What the last change did: a conflict to settle, refusals, or the publish that followed. */
function ResultNotices(props: {
  open: OpenFile;
  file: LoadedFile;
  moved: boolean;
  onOverwrite: () => void;
}) {
  const { open, file, moved, onOverwrite } = props;
  const { change } = open;
  const result = change.data;
  const failed = result && result.outcome !== "saved" ? errorsOf(result) : [];
  // A save's result is stale once the text is edited again; other changes stay shown.
  const fresh = !(isSave(change.variables?.op) && open.draft !== undefined);
  return (
    <>
      {moved && (
        <div className="pe-notice pe-notice-row" data-tone="warn" role="alert">
          <span>
            {file.sha256 === null ? "This file was deleted" : "This file changed"} in bb after you
            started editing.
          </span>
          <button
            type="button"
            className="pe-button"
            onClick={() => updateDraft(open.key, () => undefined)}
          >
            Discard mine
          </button>
          <button
            type="button"
            className="pe-button"
            disabled={change.isPending}
            onClick={onOverwrite}
          >
            Overwrite with mine
          </button>
        </div>
      )}
      {failed.length > 0 && !(result?.outcome === "conflict" && moved) && (
        <div className="pe-notice" data-tone="bad" role="alert">
          {failed.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {change.isError && (
        <p className="pe-notice" data-tone="bad" role="alert">
          {change.error.message}
        </p>
      )}
      {result?.outcome === "saved" && fresh && (
        <>
          {result.warnings.map((warning) => (
            <p key={warning} className="pe-notice" data-tone="warn">
              {warning}
            </p>
          ))}
          <PublishNotices
            key={result.published.at}
            outcome={result.published}
            verb={verbFor(change.variables)}
          />
        </>
      )}
      {open.loaded.isError && (
        <output className="pe-meta" data-tone="warn">
          Showing the last loaded text; refresh failed: {open.loaded.error.message}
        </output>
      )}
    </>
  );
}

function TextEditor(props: {
  markdown: boolean;
  label: string;
  value: string;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const { markdown, label, value, onChange, onSave } = props;
  return markdown ? (
    <MarkdownEditor
      className="pe-textarea"
      aria-label={label}
      aria-keyshortcuts="Control+S Meta+S"
      value={value}
      onChange={onChange}
      onSave={onSave}
    />
  ) : (
    <textarea
      className="pe-textarea"
      aria-label={label}
      aria-keyshortcuts="Control+S Meta+S"
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "s") {
          event.preventDefault();
          onSave();
        }
      }}
    />
  );
}

function LoadedEditor(props: { subject: EditorSubject; open: OpenFile; file: LoadedFile }) {
  const { subject, open, file } = props;
  const f = facts(subject);
  const { draft, key } = open;
  const editable = file.content !== null;
  const value = draft?.text ?? file.content ?? "";
  const moved = draft !== undefined && draft.baseSha !== file.sha256;

  const save = async (expected: string | null, text: string) => {
    setSaving(key, text);
    const result = await open
      .run(f.saveOp(text, expected))
      .finally(() => setSaving(key, undefined));
    if (result?.outcome !== "saved") {
      // An edit back to the saved text during a failed save is no longer unsaved.
      updateDraft(key, (current) => (current?.text === current?.base ? undefined : current));
      return;
    }
    // Keep anything typed while the save ran, now based on the saved version.
    updateDraft(key, (current) =>
      current === undefined || current.text === text
        ? undefined
        : { base: text, baseSha: result.sha256 ?? null, text: current.text },
    );
    open.client.setQueryData(queryKey("catalogFile", open.selection), {
      ...file,
      content: text,
      sha256: result.sha256 ?? null,
    });
    await open.refetch();
  };
  const submit = () => {
    if (draft === undefined || moved || open.change.isPending || !editable) return;
    void save(draft.baseSha, draft.text);
  };
  const edit = (text: string) =>
    updateDraft(key, (current) =>
      typed(
        key,
        text,
        current?.base ?? file.content ?? "",
        current ? current.baseSha : file.sha256,
      ),
    );

  return (
    <div className="pe-editor">
      <EditorHeader
        subject={subject}
        facts={f}
        open={open}
        editable={editable}
        canSave={draft !== undefined && !moved}
        onSubmit={submit}
      />
      {subject.kind === "doc" ? (
        <DocToolbar doc={subject.doc} open={open} moved={moved} />
      ) : (
        <SkillToolbar skill={subject.skill} path={subject.path} open={open} file={file} />
      )}
      <StateNotices subject={subject} facts={f} file={file} changed={draft !== undefined} />
      <ResultNotices
        open={open}
        file={file}
        moved={moved}
        onOverwrite={() => draft && void save(file.sha256, draft.text)}
      />
      {editable && (
        <TextEditor
          markdown={f.markdown}
          label={f.title}
          value={value}
          onChange={edit}
          onSave={submit}
        />
      )}
      <footer className="pe-editor-foot">
        <span className="pe-meta">
          {editable
            ? `${value.length.toLocaleString()} chars`
            : `${file.size.toLocaleString()} bytes`}
          {file.executable && " · executable"}
        </span>
        <span className="pe-meta">
          {f.origin.kind === "imported" ? `Imported from ${f.origin.from}` : "Edited in bb"}
        </span>
      </footer>
    </div>
  );
}

function CatalogEditor({ subject }: { subject: EditorSubject }) {
  const open = useOpenFile(facts(subject).selection);
  if (open.loaded.isPending) return <EditorPlaceholder />;
  if (!open.loaded.data) {
    return (
      <div className="pe-editor">
        <p className="pe-notice" data-tone="bad" role="alert">
          {open.loaded.error?.message}
        </p>
      </div>
    );
  }
  return <LoadedEditor subject={subject} open={open} file={open.loaded.data} />;
}

function NewFileForm({ skill, onCreate }: { skill: Skill; onCreate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="pe-button" onClick={() => setOpen(true)}>
        New file
      </button>
    );
  }
  return (
    <NewFilePath
      skill={skill}
      onClose={() => setOpen(false)}
      onCreate={(path) => {
        setOpen(false);
        onCreate(path);
      }}
    />
  );
}

/** Opens an empty editor at a path; saving there creates the file. */
function NewFilePath(props: {
  skill: Skill;
  onClose: () => void;
  onCreate: (path: string) => void;
}) {
  const [path, setPath] = useState("references/");
  const input = useFocusOnMount<HTMLInputElement>();
  const trimmed = path.trim().replace(/^\/+/, "");
  const taken = props.skill.files.some((file) => file.path === trimmed);
  const usable = trimmed !== "" && !trimmed.endsWith("/") && !taken;
  return (
    <form
      className="pe-actions"
      aria-label="New file"
      onSubmit={(event) => {
        event.preventDefault();
        if (usable) props.onCreate(trimmed);
      }}
    >
      <input
        ref={input}
        className="pe-input pe-mono"
        aria-label="New file path"
        maxLength={512}
        value={path}
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      />
      <button type="button" className="pe-button" onClick={props.onClose}>
        Cancel
      </button>
      <button
        type="submit"
        className="pe-button"
        data-primary
        disabled={!usable}
        title={taken ? `${trimmed} already exists` : undefined}
      >
        Open
      </button>
    </form>
  );
}

function CatalogPageBody({ subPath }: { subPath: string }) {
  const listing = useRpcQuery("catalog", null);
  const shadows = useRpcQuery("catalogShadows", null, { staleTime: 5 * 60_000 });
  if (!listing.data) {
    return (
      <main className="pe-panel">
        {listing.isError ? (
          <div className="pe-editor">
            <p className="pe-notice" data-tone="bad" role="alert">
              {listing.error.message}
            </p>
          </div>
        ) : (
          <div className="pe-editor" aria-busy="true">
            <span className="pe-shimmer" style={{ width: "30%" }} />
            <span className="pe-shimmer" style={{ width: "50%", height: 18 }} />
            <div className="pe-textarea pe-placeholder" />
          </div>
        )}
      </main>
    );
  }
  const selection = parseCatalogRoute(subPath);
  let body: ReactNode = <Overview listing={listing.data} />;
  if (selection !== null && "doc" in selection) {
    const doc = listing.data.docs.find((d) => d.id === selection.doc);
    body = doc ? (
      <CatalogEditor key={draftKey(selection)} subject={{ kind: "doc", doc }} />
    ) : (
      <Missing what="This doc" />
    );
  } else if (selection !== null) {
    const skill = listing.data.skills.find((s) => s.name === selection.skill);
    const owner = shadows.data?.checked
      ? shadows.data.shadows.find((s) => s.name === selection.skill)?.owner
      : undefined;
    body = skill ? (
      <CatalogEditor
        key={draftKey(selection)}
        subject={{
          kind: "skill",
          skill,
          path: selection.path,
          owner,
          trouble: publishTrouble(listing.data.published, skill.name),
        }}
      />
    ) : (
      <Missing what={`The ${selection.skill} skill`} />
    );
  }
  return <main className="pe-panel">{body}</main>;
}

function Missing({ what }: { what: string }) {
  return (
    <div className="pe-editor pe-empty">
      {what} is not in the catalog. It may have been deleted; check Recently deleted in the sidebar.
    </div>
  );
}

export function CatalogPage({ subPath }: { subPath: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CatalogPageBody subPath={subPath} />
    </QueryClientProvider>
  );
}
