import { MarkdownEditor } from "@bb-plugins/markdown-editor";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type {
  AgentFile,
  FileContent,
  FileKind,
  Plugin,
  SaveResult,
  Tool,
} from "../shared/schema.ts";
import { Alert, AlertDescription } from "../../../components/ui/alert.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import { Item, ItemActions, ItemContent, ItemTitle } from "../../../components/ui/item.tsx";
import { Textarea } from "../../../components/ui/textarea.tsx";
import { TooltipProvider } from "../../../components/ui/tooltip.tsx";
import { Hint, UnsavedDot } from "../../app/hint.tsx";
import { queryClient } from "./query.ts";
import { queryKey, useRpcMutation, useRpcQuery } from "./rpc.ts";
import "./prompt-editor.css";

const PANEL_PATH = "instructions";

/** What the editor shows: a file, or a tool whose text lives in code. */
type Selection = { pluginId: string; path: string } | { pluginId: string; tool: string };

/**
 * The URL is the selection, so the page and its sidebar Plugins list agree:
 * `<pluginId>/file/<path>` or `<pluginId>/tool/<name>`. bb encodes and decodes
 * each segment, so these stay raw.
 */
function selectionSubPath(selection: Selection): string {
  return "path" in selection
    ? `${selection.pluginId}/file/${selection.path}`
    : `${selection.pluginId}/tool/${selection.tool}`;
}

export function parsePromptSelection(subPath: string): Selection | null {
  const [pluginId, kind, ...rest] = subPath.split("/");
  if (!pluginId || rest.length === 0) return null;
  if (kind === "file") return { pluginId, path: rest.join("/") };
  if (kind === "tool" && rest.length === 1) return { pluginId, tool: rest[0]! };
  return null;
}

function useSelect(): (selection: Selection) => void {
  const navigate = useBbNavigate();
  return (selection) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: `prompts/${selectionSubPath(selection)}` });
}

const KIND_LABEL: Record<FileKind, string> = {
  "tool-description": "Tool description",
  "tool-instructions": "Tool thread snippet",
  prompt: "Prompt",
  skill: "Skill",
  reference: "Reference file",
};

const draftKey = (pluginId: string, path: string) => `${pluginId}\u0000${path}`;

/**
 * Unsaved text and the file content it was typed over. Saving sends `base`
 * as the expected disk content, so a refetch never hides a conflict.
 */
type Draft = { base: string; text: string };
type DraftUpdate = (draft: Draft | undefined) => Draft | undefined;

/**
 * Unsaved edits, keyed by `draftKey`. The page edits them and the sidebar Plugins list
 * marks them, so they live outside both components, for the app session.
 */
let drafts: ReadonlyMap<string, Draft> = new Map();
const draftListeners = new Set<() => void>();

/** Start an isolated preview without unsaved edits from a previous fixture. */
export function clearDraftsForTest(): void {
  drafts = new Map();
  for (const listener of draftListeners) listener();
}

function subscribeDrafts(listener: () => void) {
  draftListeners.add(listener);
  return () => void draftListeners.delete(listener);
}

function useDrafts(): ReadonlyMap<string, Draft> {
  return useSyncExternalStore(subscribeDrafts, () => drafts);
}

function updateDraft(key: string, update: DraftUpdate) {
  const current = drafts.get(key);
  const draft = update(current);
  if (draft === current) return;
  const next = new Map(drafts);
  if (draft === undefined) next.delete(key);
  else next.set(key, draft);
  drafts = next;
  for (const listener of draftListeners) listener();
}

function PluginList(props: {
  plugins: Plugin[];
  selection: Selection | null;
  dirty: ReadonlySet<string>;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <nav className="pe-list" aria-label="Plugins">
      {props.plugins.map((plugin) => (
        <PluginGroup key={plugin.id} plugin={plugin} {...props} />
      ))}
    </nav>
  );
}

function SkillGroup({
  path,
  selectedPath,
  dirty,
  children,
}: {
  path: string;
  selectedPath: string | null;
  dirty: boolean;
  children: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => {
    // Reveal a newly selected file without overriding manual collapse on refetch.
    if (selectedPath && disclosure.current) disclosure.current.open = true;
  }, [selectedPath]);
  const label = path.replace(/^skills\//, "");
  return (
    <details ref={disclosure} className="pe-skill" aria-label={label}>
      <summary className="pe-skill-summary">
        {label.replace(/\/?SKILL\.md$/, "") || "Skills"}
        {dirty && <UnsavedDot />}
      </summary>
      {children}
    </details>
  );
}

function PluginGroup(props: {
  plugin: Plugin;
  selection: Selection | null;
  dirty: ReadonlySet<string>;
  onSelect: (selection: Selection) => void;
}) {
  const { plugin, selection, dirty, onSelect } = props;
  const open = selection?.pluginId === plugin.id;
  const snippets = new Map(
    plugin.files.filter((f) => f.kind === "tool-instructions").map((f) => [f.tool, f]),
  );
  const prompts = plugin.files.filter((f) => f.kind === "prompt");
  const skills = plugin.files.filter((f) => f.kind === "skill");
  const skillGroups = skills.map((skill) => ({
    skill,
    directory: skill.path.slice(0, -"SKILL.md".length),
    references: new Array<AgentFile>(),
  }));
  const references: AgentFile[] = [];
  for (const file of plugin.files.filter((f) => f.kind === "reference")) {
    // The nearest SKILL.md owns a reference, including nested skills.
    const owner = skillGroups.reduce<(typeof skillGroups)[number] | undefined>(
      (nearest, group) =>
        file.path.startsWith(group.directory) &&
        (!nearest || group.directory.length > nearest.directory.length)
          ? group
          : nearest,
      undefined,
    );
    (owner?.references ?? references).push(file);
  }
  const isSelected = (entry: Selection) =>
    selection !== null &&
    selection.pluginId === entry.pluginId &&
    ("path" in selection && "path" in entry
      ? selection.path === entry.path
      : "tool" in selection && "tool" in entry && selection.tool === entry.tool);
  const first: Selection | null = plugin.tools[0]
    ? toolSelection(plugin.id, plugin.tools[0])
    : plugin.files[0]
      ? { pluginId: plugin.id, path: plugin.files[0].path }
      : null;

  const fileRow = (file: AgentFile, label: string) => {
    const entry = { pluginId: plugin.id, path: file.path };
    return (
      <Item key={file.path} asChild size="row" className="relative">
        <button
          type="button"
          aria-current={isSelected(entry) || undefined}
          onClick={() => onSelect(entry)}
        >
          <ItemContent>
            <ItemTitle>{label}</ItemTitle>
          </ItemContent>
          {dirty.has(draftKey(plugin.id, file.path)) && (
            <ItemActions>
              <UnsavedDot />
            </ItemActions>
          )}
        </button>
      </Item>
    );
  };

  return (
    <section className="pe-group">
      <Item asChild size="row" className="relative">
        <button type="button" aria-expanded={open} onClick={() => first && onSelect(first)}>
          <ItemTitle className="min-w-0 flex-1">{plugin.name}</ItemTitle>
          <ItemActions>
            <span className="pe-meta">
              {plugin.readOnly !== null ? "read-only" : countLabel(plugin)}
            </span>
          </ItemActions>
        </button>
      </Item>
      {open && (
        <div className="pe-files">
          {plugin.tools.length > 0 && <h3 className="pe-label">Tools</h3>}
          {plugin.tools.map((tool) => {
            const entry = toolSelection(plugin.id, tool);
            const snippet = snippets.get(tool.name);
            return (
              <div key={tool.name}>
                <Item asChild size="row" className="relative">
                  <button
                    type="button"
                    aria-current={isSelected(entry) || undefined}
                    onClick={() => onSelect(entry)}
                  >
                    <ItemContent>
                      <ItemTitle className="font-mono">{tool.name}</ItemTitle>
                    </ItemContent>
                    {(tool.file === null ||
                      tool.drift ||
                      (tool.file !== null && dirty.has(draftKey(plugin.id, tool.file)))) && (
                      <ItemActions className="gap-1">
                        {tool.file === null && (
                          <Badge variant="outline" className="py-0">
                            code
                          </Badge>
                        )}
                        {tool.drift && (
                          <Badge variant="warning" className="py-0">
                            stale
                          </Badge>
                        )}
                        {tool.file !== null && dirty.has(draftKey(plugin.id, tool.file)) && (
                          <UnsavedDot />
                        )}
                      </ItemActions>
                    )}
                  </button>
                </Item>
                {snippet && <div className="ps-3">{fileRow(snippet, "thread snippet")}</div>}
              </div>
            );
          })}
          {prompts.length > 0 && <h3 className="pe-label">Prompts</h3>}
          {prompts.map((file) => fileRow(file, file.path.replace(/^instructions\//, "")))}
          {skills.length > 0 && <h3 className="pe-label">Skills</h3>}
          {skillGroups.map(({ skill, directory, references }) => (
            <SkillGroup
              key={skill.path}
              path={skill.path}
              selectedPath={
                selection?.pluginId === plugin.id &&
                "path" in selection &&
                [skill, ...references].some((file) => file.path === selection.path)
                  ? selection.path
                  : null
              }
              dirty={[skill, ...references].some((file) =>
                dirty.has(draftKey(plugin.id, file.path)),
              )}
            >
              <div className="ps-3">
                {fileRow(skill, "SKILL.md")}
                {references.map((file) => fileRow(file, file.path.slice(directory.length)))}
              </div>
            </SkillGroup>
          ))}
          {references.length > 0 && <h3 className="pe-label">Reference files</h3>}
          {references.map((file) => fileRow(file, file.path.replace(/^skills\//, "")))}
        </div>
      )}
    </section>
  );
}

function toolSelection(pluginId: string, tool: Tool): Selection {
  return tool.file === null ? { pluginId, tool: tool.name } : { pluginId, path: tool.file };
}

function countLabel(plugin: Plugin): string {
  const parts = [
    plugin.tools.length > 0 && `${plugin.tools.length} tool${plugin.tools.length === 1 ? "" : "s"}`,
    plugin.files.length > 0 && `${plugin.files.length} file${plugin.files.length === 1 ? "" : "s"}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** A tool whose description is a string in the plugin's code. */
function CodeTool(props: { plugin: Plugin; tool: Tool }) {
  return (
    <div className="pe-editor">
      <header className="pe-editor-head">
        <div>
          <p className="pe-label">Tool description · {props.plugin.name}</p>
          <h2 className="pe-mono">{props.tool.name}</h2>
        </div>
      </header>
      <Alert role="none">
        <AlertDescription>
          This description is defined in the plugin's code, so it is shown read-only. Move it to{" "}
          <code>instructions/tools/{props.tool.name}.md</code> to edit it here.
        </AlertDescription>
      </Alert>
      <pre className="pe-readonly">{props.tool.live ?? "bb reports no description."}</pre>
    </div>
  );
}

function Notices(props: {
  plugin: Plugin;
  stale: boolean;
  changed: boolean;
  error: string | null;
  result: SaveResult | null;
  /** The file's path when it changed on disk under a draft. */
  moved: string | null;
}) {
  const { plugin, stale, changed, error, result, moved } = props;
  return (
    <>
      {plugin.readOnly !== null && (
        <Alert role="none">
          <AlertDescription>{plugin.readOnly}</AlertDescription>
        </Alert>
      )}
      {stale && (
        <Alert variant="warning" role="none">
          <AlertDescription>
            The agent still sees the previous description. Reload {plugin.name} to apply this file.
          </AlertDescription>
        </Alert>
      )}
      {moved !== null && (
        <Alert variant="warning" role="none">
          <AlertDescription>
            {moved} changed on disk after you started editing. Revert to load the new text, or copy
            your edit first.
          </AlertDescription>
        </Alert>
      )}
      {error !== null && (
        <Alert variant="destructive" role="none">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result !== null && result.reloadError !== null && (
        <Alert variant="warning" role="none">
          <AlertDescription>
            Saved, but {plugin.name} did not reload: {result.reloadError}
          </AlertDescription>
        </Alert>
      )}
      {result !== null && result.reloadError === null && !changed && (
        <Alert variant="success" role="none">
          <AlertDescription>Saved. {plugin.name} reloaded with the new text.</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function Footer(props: { chars: number; over: boolean; loaded: FileContent }) {
  const { chars, over, loaded } = props;
  return (
    <footer className="pe-editor-foot">
      <span className="pe-meta" data-tone={over ? "bad" : undefined}>
        {chars.toLocaleString()}
        {loaded.maxChars !== null && ` / ${loaded.maxChars.toLocaleString()}`} chars
      </span>
      {loaded.placeholders.length > 0 && (
        <Hint label="The plugin's code fills these. Keep each one.">
          <span className="pe-chips">
            {loaded.placeholders.map((key) => (
              <Badge key={key} variant="secondary" className="font-mono">{`{{${key}}}`}</Badge>
            ))}
          </span>
        </Hint>
      )}
    </footer>
  );
}

function FileEditor(props: {
  plugin: Plugin;
  file: AgentFile;
  draft: Draft | undefined;
  onDraft: (update: DraftUpdate) => void;
}) {
  const { plugin, file, draft, onDraft } = props;
  const ref = { pluginId: plugin.id, path: file.path };
  const loaded = useRpcQuery("file", ref);
  const queryClient = useQueryClient();
  const save = useRpcMutation("save", {
    onSuccess: async (result, input) => {
      // Keep anything typed while the plugin reloaded, now based on the saved file.
      onDraft((current) =>
        current === undefined || current.text === input.content
          ? undefined
          : { base: result.content, text: current.text },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKey("file", ref) }),
        queryClient.invalidateQueries({ queryKey: queryKey("plugins") }),
      ]);
    },
  });
  const tool = plugin.tools.find((t) => t.file === file.path);
  const readOnly = plugin.readOnly;

  if (loaded.isPending) return <div className="pe-editor pe-empty">Loading {file.path}…</div>;
  if (loaded.isError) {
    return (
      <div className="pe-editor">
        <Alert variant="destructive" role="none">
          <AlertDescription>{loaded.error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }
  const original = draft?.base ?? loaded.data.content;
  const value = draft?.text ?? original;
  const changed = file.kind === "reference" ? value !== original : value.trim() !== original.trim();
  const moved = draft !== undefined && draft.base !== loaded.data.content;
  const chars = value.trim().length;
  const over = loaded.data.maxChars !== null && chars > loaded.data.maxChars;
  const submit = () => {
    if (!changed || readOnly !== null || save.isPending) return;
    save.mutate({ ...ref, previous: original, content: value });
  };

  return (
    <div className="pe-editor">
      <header className="pe-editor-head">
        <div>
          <p className="pe-label">
            {KIND_LABEL[file.kind]} · {plugin.name}
          </p>
          <h2 className="pe-mono">{file.path}</h2>
        </div>
        <div className="pe-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!changed || save.isPending}
            onClick={() => onDraft(() => undefined)}
          >
            Revert
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!changed || over || readOnly !== null || save.isPending}
            onClick={submit}
          >
            {save.isPending ? "Saving…" : "Save & reload"}
          </Button>
        </div>
      </header>
      <Notices
        plugin={plugin}
        stale={tool?.drift === true && !changed}
        changed={changed}
        error={save.isError ? save.error.message : null}
        result={save.data ?? null}
        moved={moved ? file.path : null}
      />
      {/\.(md|markdown)$/i.test(file.path) ? (
        <MarkdownEditor
          className="pe-textarea"
          aria-label={file.path}
          readOnly={readOnly !== null}
          value={value}
          onChange={(text) => {
            onDraft((current) => {
              const base = current?.base ?? loaded.data.content;
              return text === base ? undefined : { base, text };
            });
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              submit();
            }
          }}
        />
      ) : (
        <Textarea
          className="pe-textarea"
          aria-label={file.path}
          spellCheck={false}
          readOnly={readOnly !== null}
          value={value}
          onChange={(event) => {
            const text = event.target.value;
            onDraft((current) => {
              const base = current?.base ?? loaded.data.content;
              return text === base ? undefined : { base, text };
            });
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              submit();
            }
          }}
        />
      )}
      <Footer chars={chars} over={over} loaded={loaded.data} />
    </div>
  );
}

/** The Plugins list in the page's left sidebar: every plugin's tools, prompts, and skills. */
function PluginsTabBody({ subPath }: { subPath: string }) {
  const plugins = useRpcQuery("plugins", null);
  const dirty = useDrafts();
  const select = useSelect();
  if (plugins.isPending)
    return <p className="pe-panel pe-sidebar pe-tab-state pe-meta">Loading plugins…</p>;
  if (plugins.isError) {
    return (
      <div className="pe-panel pe-sidebar pe-tab-state">
        <Alert variant="destructive" role="none">
          <AlertDescription>{plugins.error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <div className="pe-panel pe-sidebar">
      <PluginList
        plugins={plugins.data.plugins}
        selection={parsePromptSelection(subPath)}
        dirty={new Set(dirty.keys())}
        onSelect={select}
      />
    </div>
  );
}

function PromptEditor({ subPath }: { subPath: string }) {
  const plugins = useRpcQuery("plugins", null);
  const drafts = useDrafts();

  if (plugins.isPending) return <main className="pe-panel pe-empty">Loading plugins…</main>;
  if (plugins.isError) {
    return (
      <main className="pe-panel">
        <Alert variant="destructive" role="none">
          <AlertDescription>{plugins.error.message}</AlertDescription>
        </Alert>
      </main>
    );
  }

  const selection = parsePromptSelection(subPath);
  const plugin = plugins.data.plugins.find((p) => p.id === selection?.pluginId);

  let body = (
    <div className="pe-editor pe-empty">
      <EmptyState message="Pick a tool, prompt, or skill in the sidebar." />
    </div>
  );
  if (plugin && selection && "tool" in selection) {
    const tool = plugin.tools.find((t) => t.name === selection.tool);
    if (tool) body = <CodeTool plugin={plugin} tool={tool} />;
  } else if (plugin && selection && "path" in selection) {
    const file = plugin.files.find((f) => f.path === selection.path);
    const key = draftKey(plugin.id, selection.path);
    if (file) {
      body = (
        <FileEditor
          key={key}
          plugin={plugin}
          file={file}
          draft={drafts.get(key)}
          onDraft={(update) => updateDraft(key, update)}
        />
      );
    }
  }

  return <main className="pe-panel">{body}</main>;
}

export function PromptEditorPage({ subPath }: PluginNavPanelProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PromptEditor subPath={subPath} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export function PluginsTab({ subPath }: PluginNavPanelProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PluginsTabBody subPath={subPath} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
