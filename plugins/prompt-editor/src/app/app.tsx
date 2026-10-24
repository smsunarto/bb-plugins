import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type {
  AgentFile,
  FileContent,
  FileKind,
  Plugin,
  SaveResult,
  Tool,
} from "../shared/schema.ts";
import { rpc } from "./rpc.ts";
import "./prompt-editor.css";

const PANEL_PATH = "prompt-editor";

/** What the editor shows: a file, or a tool whose text lives in code. */
type Selection = { pluginId: string; path: string } | { pluginId: string; tool: string };

/**
 * The URL is the selection, so the page and its Plugins tab agree:
 * `<pluginId>/file/<path>` or `<pluginId>/tool/<name>`. bb encodes and decodes
 * each segment, so these stay raw.
 */
function selectionSubPath(selection: Selection): string {
  return "path" in selection
    ? `${selection.pluginId}/file/${selection.path}`
    : `${selection.pluginId}/tool/${selection.tool}`;
}

function parseSelection(subPath: string): Selection | null {
  const [pluginId, kind, ...rest] = subPath.split("/");
  if (!pluginId || rest.length === 0) return null;
  if (kind === "file") return { pluginId, path: rest.join("/") };
  if (kind === "tool" && rest.length === 1) return { pluginId, tool: rest[0]! };
  return null;
}

function useSelect(): (selection: Selection) => void {
  const navigate = useBbNavigate();
  return (selection) =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: selectionSubPath(selection) });
}

const KIND_LABEL: Record<FileKind, string> = {
  "tool-description": "Tool description",
  "tool-instructions": "Tool thread snippet",
  prompt: "Prompt",
  skill: "Skill",
};

const draftKey = (pluginId: string, path: string) => `${pluginId}\u0000${path}`;

/**
 * Unsaved text and the file content it was typed over. Saving sends `base`
 * as the expected disk content, so a refetch never hides a conflict.
 */
type Draft = { base: string; text: string };
type DraftUpdate = (draft: Draft | undefined) => Draft | undefined;

/**
 * Unsaved edits, keyed by `draftKey`. The page edits them and the Plugins tab
 * marks them, so they live outside both components, for the app session.
 */
let drafts: ReadonlyMap<string, Draft> = new Map();
const draftListeners = new Set<() => void>();

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

  const fileRow = (file: AgentFile, label: string, nested = false) => {
    const entry = { pluginId: plugin.id, path: file.path };
    return (
      <button
        key={file.path}
        type="button"
        className="pe-row"
        data-nested={nested || undefined}
        aria-current={isSelected(entry) || undefined}
        onClick={() => onSelect(entry)}
      >
        <span className="pe-row-label">{label}</span>
        {dirty.has(draftKey(plugin.id, file.path)) && <span className="pe-dot" title="Unsaved" />}
      </button>
    );
  };

  return (
    <section className="pe-group">
      <button
        type="button"
        className="pe-plugin"
        aria-expanded={open}
        onClick={() => first && onSelect(first)}
      >
        <span className="pe-plugin-name">{plugin.name}</span>
        <span className="pe-meta">
          {plugin.readOnly !== null ? "read-only" : countLabel(plugin)}
        </span>
      </button>
      {open && (
        <div className="pe-files">
          {plugin.tools.length > 0 && <h3 className="pe-label">Tools</h3>}
          {plugin.tools.map((tool) => {
            const entry = toolSelection(plugin.id, tool);
            const snippet = snippets.get(tool.name);
            return (
              <div key={tool.name}>
                <button
                  type="button"
                  className="pe-row"
                  aria-current={isSelected(entry) || undefined}
                  onClick={() => onSelect(entry)}
                >
                  <span className="pe-row-label pe-mono">{tool.name}</span>
                  {tool.file === null && <span className="pe-tag">code</span>}
                  {tool.drift && (
                    <span className="pe-tag" data-tone="warn">
                      stale
                    </span>
                  )}
                  {tool.file !== null && dirty.has(draftKey(plugin.id, tool.file)) && (
                    <span className="pe-dot" title="Unsaved" />
                  )}
                </button>
                {snippet && fileRow(snippet, "thread snippet", true)}
              </div>
            );
          })}
          {prompts.length > 0 && <h3 className="pe-label">Prompts</h3>}
          {prompts.map((file) => fileRow(file, file.path.replace(/^instructions\//, "")))}
          {skills.length > 0 && <h3 className="pe-label">Skills</h3>}
          {skills.map((file) => fileRow(file, file.path.replace(/^skills\//, "")))}
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
      <p className="pe-notice">
        This description is defined in the plugin's code, so it is shown read-only. Move it to{" "}
        <code>instructions/tools/{props.tool.name}.md</code> to edit it here.
      </p>
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
      {plugin.readOnly !== null && <p className="pe-notice">{plugin.readOnly}</p>}
      {stale && (
        <p className="pe-notice" data-tone="warn">
          The agent still sees the previous description. Reload {plugin.name} to apply this file.
        </p>
      )}
      {moved !== null && (
        <p className="pe-notice" data-tone="warn">
          {moved} changed on disk after you started editing. Revert to load the new text, or copy
          your edit first.
        </p>
      )}
      {error !== null && (
        <p className="pe-notice" data-tone="bad">
          {error}
        </p>
      )}
      {result !== null && result.reloadError !== null && (
        <p className="pe-notice" data-tone="warn">
          Saved, but {plugin.name} did not reload: {result.reloadError}
        </p>
      )}
      {result !== null && result.reloadError === null && !changed && (
        <p className="pe-notice" data-tone="good">
          Saved. {plugin.name} reloaded with the new text.
        </p>
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
        <span className="pe-chips" title="The plugin's code fills these. Keep each one.">
          {loaded.placeholders.map((key) => (
            <code key={key} className="pe-chip">{`{{${key}}}`}</code>
          ))}
        </span>
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
  const loaded = rpc.file.useQuery(ref);
  const queryClient = useQueryClient();
  const save = rpc.save.useMutation({
    onSuccess: async (result, input) => {
      // Keep anything typed while the plugin reloaded, now based on the saved file.
      onDraft((current) =>
        current === undefined || current.text === input.content
          ? undefined
          : { base: result.content, text: current.text },
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: rpc.file.queryKey(ref) }),
        queryClient.invalidateQueries({ queryKey: rpc.plugins.queryKey() }),
      ]);
    },
  });
  const tool = plugin.tools.find((t) => t.file === file.path);
  const readOnly = plugin.readOnly;

  if (loaded.isPending) return <div className="pe-editor pe-empty">Loading {file.path}…</div>;
  if (loaded.isError) {
    return (
      <div className="pe-editor pe-notice" data-tone="bad">
        {loaded.error.message}
      </div>
    );
  }
  const original = draft?.base ?? loaded.data.content;
  const value = draft?.text ?? original;
  const changed = value.trim() !== original.trim();
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
          <button
            type="button"
            className="pe-button"
            disabled={!changed || save.isPending}
            onClick={() => onDraft(() => undefined)}
          >
            Revert
          </button>
          <button
            type="button"
            className="pe-button"
            data-primary
            disabled={!changed || over || readOnly !== null || save.isPending}
            onClick={submit}
          >
            {save.isPending ? "Saving…" : "Save & reload"}
          </button>
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
      <textarea
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
      <Footer chars={chars} over={over} loaded={loaded.data} />
    </div>
  );
}

/** The Plugins tab in the page's right panel: every plugin's tools, prompts, and skills. */
function PluginsTabBody({ subPath }: { subPath: string }) {
  const plugins = rpc.plugins.useQuery();
  const dirty = useDrafts();
  const select = useSelect();
  if (plugins.isPending) return <p className="pe-panel pe-tab-state pe-meta">Loading plugins…</p>;
  if (plugins.isError) {
    return (
      <div className="pe-panel pe-tab-state">
        <p className="pe-notice" data-tone="bad">
          {plugins.error.message}
        </p>
      </div>
    );
  }
  return (
    <div className="pe-panel">
      <PluginList
        plugins={plugins.data.plugins}
        selection={parseSelection(subPath)}
        dirty={new Set(dirty.keys())}
        onSelect={select}
      />
    </div>
  );
}

function PromptEditor({ subPath }: { subPath: string }) {
  const plugins = rpc.plugins.useQuery();
  const drafts = useDrafts();

  if (plugins.isPending) return <main className="pe-panel pe-empty">Loading plugins…</main>;
  if (plugins.isError) {
    return (
      <main className="pe-panel">
        <p className="pe-notice" data-tone="bad">
          {plugins.error.message}
        </p>
      </main>
    );
  }

  const selection = parseSelection(subPath);
  const plugin = plugins.data.plugins.find((p) => p.id === selection?.pluginId);

  let body = (
    <div className="pe-editor pe-empty">Pick a tool, prompt, or skill in the Plugins tab.</div>
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

function PromptEditorPage({ subPath }: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <PromptEditor subPath={subPath} />
    </PluginQueryBoundary>
  );
}

function PluginsTab({ subPath }: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <PluginsTabBody subPath={subPath} />
    </PluginQueryBoundary>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "prompt-editor",
    title: "Prompt Editor",
    icon: "EditFile",
    path: PANEL_PATH,
    component: PromptEditorPage,
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "prompt-editor" },
    availability: "fixed",
    id: "plugins",
    title: "Plugins",
    icon: "Puzzle",
    component: PluginsTab,
    layout: "flush",
  });
});
