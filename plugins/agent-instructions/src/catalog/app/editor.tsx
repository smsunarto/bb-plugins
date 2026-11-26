import { MarkdownEditor } from "@bb-plugins/markdown-editor";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog.tsx";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import { Button, buttonVariants } from "../../../components/ui/button.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import { Input } from "../../../components/ui/input.tsx";
import { Label } from "../../../components/ui/label.tsx";
import { Skeleton } from "../../../components/ui/skeleton.tsx";
import { Switch } from "../../../components/ui/switch.tsx";
import { Textarea } from "../../../components/ui/textarea.tsx";
import { queryClient } from "../../app/query.ts";
import { queryKey, useRpcQuery } from "../../app/rpc.ts";
import type { CatalogChange, CatalogListing } from "../contract.ts";
import "../../prompts/app/prompt-editor.css";
import { errorsOf, PublishNotices, useCatalogChange, useFocusOnMount } from "./shared.tsx";
import {
  draftKey,
  dropSkillDrafts,
  isSaving,
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
        <output key={line}>
          <Alert variant={message.tone === "good" ? "success" : "warning"} role="none">
            <AlertDescription>{line}</AlertDescription>
          </Alert>
        </output>
      ))}
      <p className="pe-meta pe-wrap">
        bb gives every agent the enabled global instructions as one AGENTS.md, appends the rules
        that match its machine, provider, model, or project, and lists the enabled cross-project
        skills. Edit files here or directly in <code className="pe-mono">{listing.sourcePath}</code>
        . Keep repo-specific instructions and skills in that repository (AGENTS.md and
        .agents/skills/) on the Projects tab.
      </p>
      {listing.conflicts.length > 0 && (
        <Alert variant="warning" role="alert">
          <AlertDescription className="pe-wrap min-w-0">
            {listing.conflicts.length} sync conflict{listing.conflicts.length === 1 ? "" : "s"}{" "}
            saved under <code className="pe-mono">conflicts/</code> (not published to agents):{" "}
            {listing.conflicts.join(", ")}
          </AlertDescription>
        </Alert>
      )}
      {listing.published === null ? (
        <Alert variant="warning" role="none">
          <AlertDescription>
            Not published since bb started. Publishing runs at startup and after each change.
          </AlertDescription>
        </Alert>
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
      relativePath: `instructions/${doc.id}.md`,
      enabled: doc.enabled,
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
    relativePath: `skills/${skill.name}/${path}`,
    enabled: skill.enabled,
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
    const key = draftKey(selection);
    const updatesDocHeader = op.op === "renameDoc" || op.op === "setDocEnabled";
    if (updatesDocHeader) setSaving(key, "meta");
    const result = await change
      .mutateAsync(op)
      .catch(() => null)
      .finally(() => {
        if (updatesDocHeader) setSaving(key, undefined);
      });
    if (result?.outcome === "conflict") await refetch();
    if (updatesDocHeader && result?.outcome === "saved" && result.sha256) {
      // Frontmatter changed on disk due to our own toggle/rename: advance draft.baseSha & cached sha256
      // so the user's unsaved body edit does not trigger a false disk-conflict banner.
      const nextSha = result.sha256;
      updateDraft(key, (current) => (current ? { ...current, baseSha: nextSha } : undefined));
      client.setQueryData<LoadedFile | undefined>(queryKey("catalogFile", selection), (prev) =>
        prev ? { ...prev, sha256: nextSha } : prev,
      );
    }
    return result;
  };
  return { key: draftKey(selection), selection, loaded, draft, client, change, refetch, run };
}

type OpenFile = ReturnType<typeof useOpenFile>;

function EditorPlaceholder() {
  return (
    <div className="pe-editor" aria-busy="true">
      <Skeleton className="h-3 w-[30%]" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="min-h-60 flex-1" />
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
      <Input
        ref={input}
        className="h-8 w-auto flex-[1_1_160px]"
        aria-label="Doc name"
        maxLength={80}
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onDone();
        }}
      />
      <Button type="button" variant="ghost" size="sm" onClick={props.onDone}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={props.open.change.isPending}>
        Rename
      </Button>
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
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="pe-actions pe-wrap-actions">
        <Label className="inline-flex cursor-pointer items-center gap-2 font-normal">
          <Switch
            checked={f.enabled}
            disabled={busy}
            aria-label={`${f.name} on`}
            onCheckedChange={(next) => void open.run(f.toggle(next))}
          />
          <span className="pe-meta">{f.enabled ? "On" : "Off"}</span>
        </Label>
        {editable && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={open.draft === undefined || busy}
              onClick={() => updateDraft(open.key, () => undefined)}
            >
              Revert
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canSave || busy}
              aria-keyshortcuts="Control+S Meta+S"
              onClick={onSubmit}
            >
              {busy && isSave(open.change.variables?.op) ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

/** A button that asks once more, in a dialog, before it acts. */
function ConfirmButton(props: {
  label: string;
  confirm: string;
  description: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={props.disabled}>
          {props.label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.confirm}?</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={props.disabled}
            onClick={props.onConfirm}
          >
            {props.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DocToolbar({ doc, open, moved }: { doc: Doc; open: OpenFile; moved: boolean }) {
  const go = useGo();
  return (
    <div className="pe-toolbar">
      <ConfirmButton
        label="Delete doc"
        confirm="Delete doc"
        description={`${doc.name} moves to Recently deleted, where you can restore it.`}
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

function SkillToolbar(props: {
  skill: Skill;
  path: string;
  open: OpenFile;
  file: LoadedFile;
  moved: boolean;
}) {
  const { skill, path, open, file, moved } = props;
  const go = useGo();
  const busy = open.change.isPending;
  const isNewFile = file.sha256 === null && !moved;
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
          description={`This removes ${path} from ${skill.name}.`}
          disabled={busy}
          onConfirm={() => void deleteFile(file.sha256!)}
        />
      )}
      {isNewFile && open.draft !== undefined && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => updateDraft(open.key, () => undefined)}
        >
          Discard new file
        </Button>
      )}
      {path === "SKILL.md" && (
        <ConfirmButton
          label="Delete skill"
          confirm={`Delete ${skill.name}`}
          description={`${skill.name} and its files move to Recently deleted, where you can restore them.`}
          disabled={busy}
          onConfirm={() => void deleteSkill()}
        />
      )}
    </div>
  );
}

const SCRIPT = /\.(sh|py|js|ts|rb|pl)$/;

/** What is true of the file itself: off, shadowed, binary, or new. */
function StateNotices(props: {
  subject: EditorSubject;
  facts: Facts;
  file: LoadedFile;
  moved: boolean;
}) {
  const { subject, facts: f, file, moved } = props;
  const skill = subject.kind === "skill" ? subject : null;
  const isNewFile = file.sha256 === null && !moved;
  return (
    <>
      {!f.enabled && (
        <Alert role="none">
          <AlertDescription>
            Off: agents do not get {skill ? "this skill" : "this text"}.
          </AlertDescription>
        </Alert>
      )}
      {skill?.owner !== undefined && skill !== null && (
        <Alert variant="warning" role="none">
          <AlertDescription>
            bb also delivers a skill named {skill.skill.name} from {skill.owner}. Agents see only
            one of them.
          </AlertDescription>
        </Alert>
      )}
      {skill?.trouble && (
        <Alert variant="destructive" role="none">
          <AlertDescription>{skill.trouble}</AlertDescription>
        </Alert>
      )}
      {file.content === null && (
        <Alert role="none">
          <AlertDescription>
            This file is not editable text ({file.size.toLocaleString()} bytes). It is published as
            it is.
          </AlertDescription>
        </Alert>
      )}
      {file.content !== null && isNewFile && (
        <Alert role="none">
          <AlertDescription>
            New file. Save to add it to {f.name}.
            {skill && SCRIPT.test(skill.path) && " Start it with #! to make it executable."}
          </AlertDescription>
        </Alert>
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
        <Alert variant="warning" role="alert">
          <AlertDescription>
            {file.sha256 === null ? "This file was deleted" : "This file changed"} on disk after you
            started editing.
          </AlertDescription>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateDraft(open.key, () => undefined)}
            >
              Discard mine
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={change.isPending}
              onClick={onOverwrite}
            >
              Overwrite with mine
            </Button>
          </div>
        </Alert>
      )}
      {failed.length > 0 && !(result?.outcome === "conflict" && moved) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {failed.map((error) => (
              <p key={error}>{error}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      {change.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{change.error.message}</AlertDescription>
        </Alert>
      )}
      {result?.outcome === "saved" && fresh && (
        <>
          {result.warnings.map((warning) => (
            <Alert key={warning} variant="warning" role="none">
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
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
    <Textarea
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
  const savingNow = isSaving(key);
  const moved = draft !== undefined && !savingNow && draft.baseSha !== file.sha256;
  const footMeta = [
    !editable && `${file.size.toLocaleString()} bytes`,
    file.executable && "executable",
  ]
    .filter(Boolean)
    .join(" · ");

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
        <SkillToolbar
          skill={subject.skill}
          path={subject.path}
          open={open}
          file={file}
          moved={moved}
        />
      )}
      <StateNotices subject={subject} facts={f} file={file} moved={moved} />
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
        {footMeta.length > 0 && <span className="pe-meta">{footMeta}</span>}
        <span className="pe-meta pe-mono pe-wrap min-w-0">{f.relativePath}</span>
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
        <Alert variant="destructive" role="alert">
          <AlertDescription>{open.loaded.error?.message}</AlertDescription>
        </Alert>
      </div>
    );
  }
  return <LoadedEditor subject={subject} open={open} file={open.loaded.data} />;
}

function NewFileForm({ skill, onCreate }: { skill: Skill; onCreate: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        New file
      </Button>
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
  const takenId = useId();
  return (
    <form
      className="pe-actions"
      aria-label="New file"
      onSubmit={(event) => {
        event.preventDefault();
        if (usable) props.onCreate(trimmed);
      }}
    >
      <Input
        ref={input}
        className="pe-mono h-8 w-auto flex-[1_1_160px]"
        aria-label="New file path"
        aria-invalid={taken || undefined}
        aria-describedby={taken ? takenId : undefined}
        maxLength={512}
        value={path}
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onClose();
        }}
      />
      <Button type="button" variant="ghost" size="sm" onClick={props.onClose}>
        Cancel
      </Button>
      <Button type="submit" size="sm" disabled={!usable}>
        Open
      </Button>
      {taken && (
        <p id={takenId} className="pe-meta pe-wrap basis-full" data-tone="bad">
          {trimmed} already exists.
        </p>
      )}
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
            <Alert variant="destructive" role="alert">
              <AlertDescription>{listing.error.message}</AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="pe-editor" aria-busy="true">
            <Skeleton className="h-3 w-[30%]" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="min-h-60 flex-1" />
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
      <EmptyState
        message={`${what} is not in the catalog. It may have been deleted; check Recently deleted in the sidebar.`}
      />
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
