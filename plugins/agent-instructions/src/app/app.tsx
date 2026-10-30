import { MarkdownEditor } from "@bb-plugins/markdown-editor";
import { DocumentsPage, DocumentsTab } from "../documents/app.tsx";
import { definePluginApp, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PromptEditorPage, PluginsTab } from "../prompts/app/app.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { useId, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import {
  ANYWHERE,
  newRuleId,
  type Conditions,
  type Rule,
  type RulesState,
  MAX_INSTRUCTIONS_LENGTH,
} from "../shared/rules.ts";
import type { Target, Targets } from "../shared/targets.ts";
import { createRulesDraft } from "./draft.ts";
import { queryClient } from "./query.ts";
import { queryKey, useAgentInstructionsRpc, useRpcQuery } from "./rpc.ts";

const AUTOSAVE_DELAY_MS = 500;

type ListKey = "hosts" | "providers" | "projects";
const SCOPES: readonly { key: ListKey; label: string; any: string }[] = [
  { key: "hosts", label: "Machine", any: "Any machine" },
  { key: "providers", label: "Provider", any: "Any provider" },
  { key: "projects", label: "Project", any: "Any project" },
];

function nameOf(id: string, known: readonly Target[]) {
  return known.find((target) => target.id === id)?.name ?? id;
}

/** `Dev Mac · Codex · claude-opus-*`, or `Always` when nothing narrows the rule. */
export function scopeSummary(when: Conditions, targets: Targets): string {
  const parts = [
    ...SCOPES.flatMap(({ key }) =>
      when[key].length > 0 ? [when[key].map((id) => nameOf(id, targets[key])).join(" or ")] : [],
    ),
    ...(when.models.length > 0 ? [when.models.join(" or ")] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "Always";
}

function parseModels(text: string): string[] {
  return text
    .split(",")
    .map((glob) => glob.trim())
    .filter((glob) => glob.length > 0);
}

function ScopeEditor({
  when,
  targets,
  onChange,
}: {
  when: Conditions;
  targets: Targets;
  onChange: (when: Conditions) => void;
}) {
  // Keep the raw text so a trailing comma survives while the user types.
  const [models, setModels] = useState(when.models.join(", "));
  // Follow a change made elsewhere, such as loading the latest rules.
  if (parseModels(models).join(",") !== when.models.join(",")) setModels(when.models.join(", "));
  const modelsId = useId();
  return (
    <div className="space-y-2.5 rounded-md bg-muted/40 p-3">
      {SCOPES.map(({ key, label, any }) => {
        // Show saved ids bb no longer lists, so they can still be removed.
        const stale = when[key]
          .filter((id) => !targets[key].some((target) => target.id === id))
          .map((id) => ({ id, name: id }));
        return (
          <div key={key} className="flex flex-wrap items-center gap-1.5">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              aria-pressed={when[key].length === 0}
              onClick={() => onChange({ ...when, [key]: [] })}
            >
              {any}
            </Button>
            {[...targets[key], ...stale].map((target) => {
              const selected = when[key].includes(target.id);
              return (
                <Button
                  key={target.id}
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  aria-pressed={selected}
                  onClick={() =>
                    onChange({
                      ...when,
                      [key]: selected
                        ? when[key].filter((id) => id !== target.id)
                        : [...when[key], target.id],
                    })
                  }
                >
                  {target.name}
                </Button>
              );
            })}
          </div>
        );
      })}
      <div className="flex items-center gap-1.5">
        <label htmlFor={modelsId} className="w-16 shrink-0 text-xs text-muted-foreground">
          Model
        </label>
        <Input
          id={modelsId}
          value={models}
          placeholder="Any model, or globs like claude-opus-*, gpt-5*"
          className="h-7 font-mono text-xs"
          onChange={(event) => {
            setModels(event.target.value);
            onChange({ ...when, models: parseModels(event.target.value) });
          }}
        />
      </div>
    </div>
  );
}

export function RuleCard({
  rule,
  targets,
  initiallyOpen,
  onChange,
  onDelete,
}: {
  rule: Rule;
  targets: Targets;
  initiallyOpen: boolean;
  onChange: (rule: Rule) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const label = rule.name.trim() || "Untitled rule";
  return (
    <div
      data-rule={rule.id}
      className={`space-y-2.5 rounded-lg border border-border p-3 ${rule.enabled ? "" : "opacity-60"}`}
    >
      <div className="flex items-center gap-2">
        <Switch
          checked={rule.enabled}
          aria-label={`${label} enabled`}
          onCheckedChange={(enabled) => onChange({ ...rule, enabled })}
        />
        <Input
          value={rule.name}
          maxLength={80}
          aria-label="Rule name"
          placeholder="Untitled rule"
          className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-sm font-medium shadow-none hover:border-input"
          onChange={(event) => onChange({ ...rule, name: event.target.value })}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 max-w-[50%] gap-1 px-2 text-xs text-muted-foreground"
          aria-expanded={open}
          aria-label={`Scope: ${scopeSummary(rule.when, targets)}`}
          onClick={() => setOpen(!open)}
        >
          <Icon name="Filter" className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{scopeSummary(rule.when, targets)}</span>
          <Icon
            name="ChevronDown"
            className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0 text-muted-foreground hover:text-destructive"
          aria-label={`Delete ${label}`}
          onClick={onDelete}
        >
          <Icon name="Trash2" className="size-3.5" aria-hidden />
        </Button>
      </div>
      {open && (
        <ScopeEditor
          when={rule.when}
          targets={targets}
          onChange={(when) => onChange({ ...rule, when })}
        />
      )}
      <MarkdownEditor
        aria-label={`${label} instructions`}
        value={rule.instructions}
        maxLength={MAX_INSTRUCTIONS_LENGTH}
        placeholder="Instructions for agents this rule applies to…"
        className="min-h-24 resize-y bg-background text-sm"
        onChange={(instructions) => onChange({ ...rule, instructions })}
      />
    </div>
  );
}

const rulesDraft = createRulesDraft({
  delayMs: AUTOSAVE_DELAY_MS,
  // A late response must not replace a newer revision another writer stored.
  onStored: (stored) =>
    queryClient.setQueryData<RulesState>(queryKey("rules"), (cached) =>
      cached && cached.revision >= stored.revision ? cached : stored,
    ),
});

export function resetRulesDraftForTest() {
  rulesDraft.resetForTest();
}

function useRulesDraft(server: RulesState) {
  const client = useAgentInstructionsRpc();
  rulesDraft.connect((input) => client.call("saveRules", input));
  useLayoutEffect(() => rulesDraft.receive(server), [server]);
  const { draft, conflict, error, save } = useSyncExternalStore(rulesDraft.subscribe, () =>
    rulesDraft.snapshotFor(server),
  );
  return {
    draft,
    setDraft: rulesDraft.edit,
    error,
    conflict,
    status: save === "idle" ? "Saved" : "Saving…",
    takeTheirs: rulesDraft.takeTheirs,
    keepMine: rulesDraft.keepMine,
  };
}

function RulesEditor({ server, targets }: { server: RulesState; targets: Targets }) {
  const { draft, setDraft, error, conflict, status, takeTheirs, keepMine } = useRulesDraft(server);
  const [added, setAdded] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {draft.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No rules yet. A rule with no scope applies to every agent.
        </p>
      )}
      {draft.map((rule) => (
        <RuleCard
          key={rule.id}
          rule={rule}
          targets={targets}
          initiallyOpen={rule.id === added}
          onChange={(next) =>
            setDraft(draft.map((candidate) => (candidate.id === next.id ? next : candidate)))
          }
          onDelete={() => setDraft(draft.filter((candidate) => candidate.id !== rule.id))}
        />
      ))}
      {conflict !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 p-2.5 text-xs"
        >
          <span className="flex-1">Rules changed elsewhere since this page loaded.</span>
          <Button size="sm" variant="outline" onClick={takeTheirs}>
            Discard my edits
          </Button>
          <Button size="sm" variant="outline" onClick={keepMine}>
            Overwrite with mine
          </Button>
        </div>
      )}
      <div className="flex min-h-8 items-center justify-between gap-4">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            const rule: Rule = {
              id: newRuleId(),
              name: "",
              enabled: true,
              instructions: "",
              when: ANYWHERE,
            };
            setAdded(rule.id);
            setDraft([...draft, rule]);
          }}
        >
          <Icon name="Plus" className="size-3.5" aria-hidden />
          Add rule
        </Button>
        {error !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        ) : (
          conflict === null && <output className="text-xs text-muted-foreground">{status}</output>
        )}
      </div>
    </div>
  );
}

function Loaded() {
  // Refetches on every visit, so the editor starts from the stored rules.
  const rules = useRpcQuery("rules", null);
  const targets = useRpcQuery("targets", null);
  if (rules.isError || targets.isError) {
    return (
      <p className="text-xs text-destructive" role="alert">
        {(rules.error ?? targets.error)?.message}
      </p>
    );
  }
  if (!rules.data || !targets.data) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  return <RulesEditor server={rules.data} targets={targets.data} />;
}

function RulesPage() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <p className="text-sm text-muted-foreground">
            Rules appended to agent instructions. Scope a rule to a machine, provider, model, or
            project. Changes apply when a thread's agent session next starts.
          </p>
          <Loaded />
        </div>
      </div>
    </QueryClientProvider>
  );
}

function promptSubPath(subPath: string): string | null {
  return subPath === "prompts" ? "" : subPath.startsWith("prompts/") ? subPath.slice(8) : null;
}

function AgentInstructionsPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const prompts = promptSubPath(subPath);
  const documents = /^(global|projects)(?:\/|$)/.test(subPath);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <nav
        aria-label="Instruction editors"
        className="flex shrink-0 flex-wrap gap-1 border-b border-border px-4 py-2"
      >
        <Button
          variant={prompts === null && !documents ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={prompts === null && !documents}
          onClick={() => navigate.toPluginPanel("instructions")}
        >
          Rules
        </Button>
        <Button
          variant={subPath.startsWith("global") ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={subPath.startsWith("global")}
          onClick={() => navigate.toPluginPanel("instructions", { subPath: "global" })}
        >
          Global
        </Button>
        <Button
          variant={subPath.startsWith("projects") ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={subPath.startsWith("projects")}
          onClick={() => navigate.toPluginPanel("instructions", { subPath: "projects" })}
        >
          Projects
        </Button>
        <Button
          variant={prompts !== null ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={prompts !== null}
          onClick={() => navigate.toPluginPanel("instructions", { subPath: "prompts" })}
        >
          Plugin prompts
        </Button>
      </nav>
      <div className="min-h-0 min-w-0 flex-1">
        {documents ? (
          <DocumentsPage subPath={subPath} />
        ) : prompts === null ? (
          <RulesPage />
        ) : (
          <PromptEditorPage subPath={prompts} />
        )}
      </div>
    </div>
  );
}

function PromptPluginsTab({ subPath }: PluginNavPanelProps) {
  return <PluginsTab subPath={promptSubPath(subPath) ?? ""} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "agent-instructions",
    title: "Agent instructions",
    icon: "agent-instructions/plugin",
    path: "instructions",
    component: AgentInstructionsPage,
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "agent-instructions" },
    availability: "fixed",
    id: "files",
    title: "Files",
    icon: "FileText",
    component: DocumentsTab,
    useVisible: ({ subPath }) => /^(global|projects)(?:\/|$)/.test(subPath),
    layout: "flush",
  });
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "agent-instructions" },
    availability: "fixed",
    id: "plugins",
    title: "Plugins",
    icon: "Puzzle",
    component: PromptPluginsTab,
    useVisible: ({ subPath }) => promptSubPath(subPath) !== null,
    layout: "flush",
  });
});
