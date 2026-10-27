import { parseReasoningLevel } from "./lib/reasoning";
// The Magic Compose settings page: the sections under BB's own card, which
// holds the API keys. They are laid out by the question Jev answers, with each
// question's instructions beside the list it chooses from.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  type PluginAppBuilder,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DecisionSummary, rpcContract, ScopeOptions } from "./server";
import type { RotationEntry } from "./lib/router";
import {
  DEFAULT_PREFERENCES,
  INSTRUCTIONS_MAX,
  PERMISSION_MODES,
  type Preferences,
} from "@/lib/preferences";
import { REASONING_LEVELS, type ReasoningLevel } from "@/lib/reasoning";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface Status {
  hasApiKey: boolean;
  rotationSize: number;
  gateways: string[];
  last: { at: number; latencyMs: number | null; error: string | null } | null;
}
interface Machine {
  id: string;
  name: string;
  description: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The preferences, saved as they change. Each section saves only the fields it owns. */
function usePreferences() {
  const rpc = useRpc<typeof rpcContract>();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("preferencesGet").then(
      (result) => setPreferences(result.preferences),
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc]);

  const save = useCallback(
    (patch: Partial<Preferences>) => {
      setPreferences((current) => (current === null ? current : { ...current, ...patch }));
      rpc.call("preferencesSet", { preferences: patch }).then(
        // The server has the last word, as when it drops effort along with model.
        (result) => {
          setPreferences(result.preferences);
          setError(null);
        },
        (cause) => setError(errorMessage(cause)),
      );
    },
    [rpc],
  );
  return { preferences, error, save };
}

/** Which projects, environments, and effort levels Magic Compose may use, saved as they change. */
function useScope() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ScopeOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("scopeGet").then(setState, (cause) => setError(errorMessage(cause)));
  }, [rpc]);

  const save = useCallback(
    (scope: Partial<ScopeOptions["scope"]>) => {
      setState((current) =>
        current === null ? current : { ...current, scope: { ...current.scope, ...scope } },
      );
      rpc.call("scopeSet", { scope }).then(
        () => setError(null),
        (cause) => setError(errorMessage(cause)),
      );
    },
    [rpc],
  );
  return { state, error, save };
}

function Loading({ error }: { error: string | null }) {
  return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
}

function Problem({ error }: { error: string | null }) {
  return error === null ? null : <p className="text-sm text-destructive">{error}</p>;
}

/** One choice among several that can each be on or off. */
function Chip({
  on,
  disabled,
  title,
  onClick,
  children,
}: {
  on: boolean;
  disabled?: boolean;
  title?: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      aria-description={title}
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? "border-transparent bg-state-active text-foreground"
          : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** A row of a settings card: what it is on the left, its control on the right. */
function Row({ name, detail, children }: { name: string; detail?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <div className="min-w-48 flex-1">
        <div className="text-sm font-medium text-foreground">{name}</div>
        {detail !== undefined && <div className="text-xs text-muted-foreground">{detail}</div>}
      </div>
      {children}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border rounded-md border border-border px-3">{children}</div>
  );
}

const COLLAPSED_ROWS = 7;

/**
 * Plain-English instructions for one of Jev's questions. Empty, it is a line
 * offering to add some, not a box of nothing. Long, it shows its opening and
 * offers the rest. Saved when the field is left.
 */
function Instructions({
  what,
  placeholder,
  value,
  onSave,
}: {
  what: string;
  placeholder: string;
  value: string;
  onSave(next: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => setDraft(value), [value]);

  if (value === "" && draft === "" && !open) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Icon name="Plus" className="size-4" />
        Add {what}
      </Button>
    );
  }
  const lines = draft
    .split("\n")
    .reduce((count, line) => count + 1 + Math.floor(line.length / 96), 0);
  const long = lines > COLLAPSED_ROWS;
  return (
    <div className="space-y-1">
      <Textarea
        value={draft}
        rows={all ? lines + 1 : Math.min(Math.max(lines, 2), COLLAPSED_ROWS)}
        maxLength={INSTRUCTIONS_MAX}
        placeholder={placeholder}
        aria-label={what}
        autoFocus={open && value === ""}
        className="font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          setOpen(false);
          if (draft !== value) onSave(draft);
        }}
      />
      {long && (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={() => setAll((shown) => !shown)}
        >
          {all ? "Show less" : `Show all ${draft.length.toLocaleString()} characters`}
        </Button>
      )}
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="pt-2 text-xs text-muted-foreground">{children}</div>;
}

// ---------------------------------------------------------------------------
// Try it
// ---------------------------------------------------------------------------

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function statusLine(status: Status): { tone: "ok" | "idle" | "bad"; text: string } {
  if (!status.hasApiKey)
    return { tone: "bad", text: "Add an API key above to connect Magic Compose to Jev." };
  if (status.rotationSize === 0) {
    return {
      tone: "bad",
      text: "Add a model under Models and effort: Magic Compose needs one to choose.",
    };
  }
  const through = status.gateways.join(", then ");
  if (status.last === null) {
    return {
      tone: "idle",
      text: `Set up to reach Jev through ${through}. Route a prompt to check.`,
    };
  }
  if (status.last.error !== null) {
    return {
      tone: "bad",
      text: `The last question failed, ${ago(status.last.at)}: ${status.last.error}`,
    };
  }
  return {
    tone: "ok",
    text: `Reached Jev through ${through} · last decision ${status.last.latencyMs ?? "?"} ms, ${ago(status.last.at)}`,
  };
}

function percent(value: number | null): string {
  return value === null ? "" : `${Math.round(value * 100)}%`;
}

function Pick({ title, pick }: { title: string; pick: DecisionSummary["reasoning"] }) {
  const others = pick.alternatives
    .filter((alternative) => alternative.probability >= 0.05)
    .map((other) => `${other.label} ${percent(other.probability)}`);
  return (
    <div className="rounded-md border border-border px-2.5 py-1 text-xs">
      <span className="text-muted-foreground">{title}</span>{" "}
      <span className="font-medium text-foreground">{pick.label}</span>{" "}
      <span className="text-muted-foreground">
        {pick.source === "only-option"
          ? "only option"
          : `${percent(pick.probability)}${pick.source === "fallback" ? " fallback" : ""}`}
      </span>
      {others.length > 0 && <div className="text-muted-foreground">also {others.join(", ")}</div>}
    </div>
  );
}

function TrySection() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<DecisionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    rpc.call("status").then(setStatus, () => {});
  }, [rpc]);
  useEffect(refresh, [refresh]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setDecision((await rpc.call("preview", { text })).decision);
    } catch (cause) {
      setDecision(null);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const line = status === null ? null : statusLine(status);
  return (
    <div className="space-y-2.5">
      {line !== null && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground" role="status">
          <span
            className={cn(
              "mt-1 size-1.5 shrink-0 rounded-full",
              line.tone === "ok"
                ? "bg-success"
                : line.tone === "bad"
                  ? "bg-destructive"
                  : "bg-muted-foreground",
            )}
          />
          {line.text}
        </div>
      )}
      <div className="flex items-start gap-2">
        <Textarea
          value={text}
          rows={1}
          placeholder="Fix the crash when the iOS app opens a deep link…"
          aria-label="Prompt to route"
          className="min-h-9"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !busy && text.trim() !== "") {
              event.preventDefault();
              void run();
            }
          }}
        />
        <Button disabled={busy || text.trim() === ""} onClick={() => void run()}>
          {busy ? "Routing…" : "Route it"}
        </Button>
      </div>
      <Problem error={error} />
      {decision !== null && (
        <div className="flex flex-wrap gap-1.5">
          <Pick title="Project" pick={decision.project} />
          <Pick title="Machine" pick={decision.machine} />
          <Pick title="Environment" pick={decision.environment} />
          <Pick title="Model" pick={decision.model} />
          <Pick title="Effort" pick={decision.reasoning} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// In the composer
// ---------------------------------------------------------------------------

const MAY_SET: { key: keyof Preferences["maySet"]; label: string }[] = [
  { key: "project", label: "Project" },
  { key: "placement", label: "Machine & environment" },
  { key: "model", label: "Model" },
  { key: "effort", label: "Effort" },
];

function ComposerSection() {
  const { preferences, error, save } = usePreferences();
  if (preferences === null) return <Loading error={error} />;
  const { maySet } = preferences;
  return (
    <div className="space-y-2">
      <Card>
        <Row name="Magic Compose may set" detail="Switch one off and that picker is always yours.">
          <div className="flex flex-wrap gap-1.5">
            {MAY_SET.map(({ key, label }) => (
              <Chip
                key={key}
                on={maySet[key]}
                // Jev chooses the effort for the model it chose.
                disabled={key === "effort" && !maySet.model}
                title={
                  key === "effort"
                    ? "Needs Model: Jev chooses the effort for the model it chose."
                    : undefined
                }
                onClick={() => save({ maySet: { ...maySet, [key]: !maySet[key] } })}
              >
                {label}
              </Chip>
            ))}
          </div>
        </Row>
        <Row
          name="Hold send until Magic Compose has decided"
          detail="Off, send is never held, and a draft may go before the pickers catch up with it."
        >
          <Switch
            checked={preferences.holdSend}
            onCheckedChange={(holdSend) => save({ holdSend })}
            aria-label="Hold send until Magic Compose has decided"
          />
        </Row>
        <Row
          name="Ask Jev"
          detail="“When I pause” sends far fewer drafts to TypeSafe, and the pickers move less."
        >
          <div className="flex gap-1.5">
            <Chip on={preferences.pace === "typing"} onClick={() => save({ pace: "typing" })}>
              As I type
            </Chip>
            <Chip on={preferences.pace === "pause"} onClick={() => save({ pace: "pause" })}>
              When I pause
            </Chip>
          </div>
        </Row>
      </Card>
      <Problem error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// About you
// ---------------------------------------------------------------------------

function AboutSection() {
  const { preferences, error, save } = usePreferences();
  if (preferences === null) return <Loading error={error} />;
  return (
    <div className="space-y-2">
      <Instructions
        what="general instructions"
        placeholder="I'm a solo developer. My main repo is bb."
        value={preferences.generalInstructions}
        onSave={(generalInstructions) => save({ generalInstructions })}
      />
      <Problem error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const ADD_RESULTS = 8;

function ProjectsSection() {
  const { state, error, save } = useScope();
  const preferences = usePreferences();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  if (state === null) return <Loading error={error} />;
  const { scope, projects } = state;
  const picked = new Set(scope.projectIds);
  const chosen = projects.filter((project) => picked.has(project.id));
  const needle = query.trim().toLowerCase();
  // The list arrives with "No project" first, and it stays there.
  const offered = projects
    .filter((project) => !picked.has(project.id))
    .filter(
      (project) =>
        needle === "" ||
        project.name.toLowerCase().includes(needle) ||
        project.detail.toLowerCase().includes(needle),
    );
  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Switch
          checked={scope.allProjects}
          onCheckedChange={(allProjects) => save({ allProjects })}
          aria-label="All projects"
        />
        <span className="font-medium text-foreground">All projects</span>
        <span className="text-muted-foreground">
          and “No project”, including ones you add later
        </span>
      </label>
      {!scope.allProjects && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {chosen.map((project) => (
              <Chip
                key={project.id}
                on
                title={`Remove ${project.name}`}
                onClick={() =>
                  save({ projectIds: scope.projectIds.filter((id) => id !== project.id) })
                }
              >
                {project.name}
                <Icon name="X" className="size-3 text-muted-foreground" />
              </Chip>
            ))}
            <Chip on={adding} onClick={() => setAdding((open) => !open)}>
              <Icon name="Plus" className="size-3" />
              Add project…
            </Chip>
          </div>
          {adding && (
            <div className="rounded-md border border-border">
              <Input
                autoFocus
                value={query}
                placeholder={`Search ${projects.length - chosen.length} projects`}
                aria-label="Search projects to add"
                className="rounded-b-none border-0 border-b border-border"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setAdding(false);
                }}
              />
              <ul className="max-h-64 overflow-y-auto">
                {offered.slice(0, needle === "" ? ADD_RESULTS : undefined).map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer flex-col items-start px-3 py-1.5 text-left hover:bg-state-hover"
                      onClick={() => {
                        save({ projectIds: [...scope.projectIds, project.id] });
                        setQuery("");
                      }}
                    >
                      <span className="text-sm font-medium text-foreground">{project.name}</span>
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {project.detail}
                      </span>
                    </button>
                  </li>
                ))}
                {offered.length === 0 && (
                  <li className="px-3 py-2 text-sm text-muted-foreground">
                    {needle === "" ? "Every project is already in." : "No project matches."}
                  </li>
                )}
                {needle === "" && offered.length > ADD_RESULTS && (
                  <li className="px-3 py-1.5 text-xs text-muted-foreground">
                    and {offered.length - ADD_RESULTS} more: search to find them
                  </li>
                )}
              </ul>
            </div>
          )}
          {chosen.length === 0 && (
            <p className="text-sm text-destructive">
              Pick at least one project for Magic Compose to use.
            </p>
          )}
        </>
      )}
      <Label>How to choose a project</Label>
      {preferences.preferences === null ? (
        <Loading error={preferences.error} />
      ) : (
        <Instructions
          what="project instructions"
          placeholder="Anything about the iOS app goes to the mobile project."
          value={preferences.preferences.projectInstructions}
          onSave={(projectInstructions) => preferences.save({ projectInstructions })}
        />
      )}
      <Problem error={error ?? preferences.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

function MachinesSection() {
  const rpc = useRpc<typeof rpcContract>();
  const { preferences, error, save } = usePreferences();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machinesError, setMachinesError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("machines").then(
      (result) => setMachines(result.machines),
      (cause) => setMachinesError(errorMessage(cause)),
    );
  }, [rpc]);

  return (
    <div className="space-y-2">
      {machines === null ? (
        <Loading error={machinesError} />
      ) : machines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No machine is connected.</p>
      ) : (
        <dl className="divide-y divide-border">
          {machines.map((machine) => (
            <div
              key={machine.id}
              className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[11rem_minmax(0,1fr)]"
            >
              <dt className="text-sm font-medium text-foreground">{machine.name}</dt>
              <dd className="text-xs text-muted-foreground">{machine.description}</dd>
            </div>
          ))}
        </dl>
      )}
      <Label>How to choose a machine</Label>
      {preferences === null ? (
        <Loading error={error} />
      ) : (
        <Instructions
          what="machine instructions"
          placeholder="iOS and macOS work must run on the MacBook. Prefer the Linux server otherwise."
          value={preferences.machineInstructions}
          onSave={(machineInstructions) => save({ machineInstructions })}
        />
      )}
      <Problem error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

function EnvironmentsSection() {
  const { state, error, save } = useScope();
  const preferences = usePreferences();
  if (state === null) return <Loading error={error} />;
  const { scope, environments } = state;
  const picked = new Set(scope.environmentIds);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {environments.map((environment) => (
          <Chip
            key={environment.id}
            on={picked.has(environment.id)}
            // Magic Compose always needs somewhere to run.
            disabled={picked.has(environment.id) && picked.size === 1}
            title={environment.detail === "" ? undefined : environment.detail}
            onClick={() =>
              save({
                // Kept in the order listed, which is the order of preference.
                environmentIds: environments
                  .map((entry) => entry.id)
                  .filter((id) => (id === environment.id ? !picked.has(id) : picked.has(id))),
              })
            }
          >
            {picked.has(environment.id) && <Icon name="Check" className="size-3" />}
            {environment.name}
          </Chip>
        ))}
      </div>
      <Label>How to choose an environment</Label>
      {preferences.preferences === null ? (
        <Loading error={preferences.error} />
      ) : (
        <Instructions
          what="environment instructions"
          placeholder="Use a worktree for anything that changes code, the project checkout for questions."
          value={preferences.preferences.environmentInstructions}
          onSave={(environmentInstructions) => preferences.save({ environmentInstructions })}
        />
      )}
      <Problem error={error ?? preferences.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Models and effort
// ---------------------------------------------------------------------------

const COSTLY: ReadonlySet<ReasoningLevel> = new Set(["ultra", "ultracode"]);

function RotationRow({
  entry,
  onChange,
  onRemove,
}: {
  entry: RotationEntry;
  onChange(next: RotationEntry): void;
  onRemove(): void;
}) {
  // Typing saves on blur, so a half-written note never reaches the server.
  const [note, setNote] = useState(entry.note);
  useEffect(() => setNote(entry.note), [entry.note]);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <ProviderModelPicker
        value={{
          providerId: entry.providerId,
          model: entry.model,
          reasoningLevel: entry.reasoningLevel,
        }}
        onChange={(value) =>
          onChange({
            ...entry,
            providerId: value.providerId,
            model: value.model,
            reasoningLevel: parseReasoningLevel(value.reasoningLevel) ?? "medium",
          })
        }
      />
      <Input
        className="min-w-48 flex-1"
        value={note}
        maxLength={600}
        placeholder="When to use it, e.g. “UI design and planning”"
        aria-label="When to use this model"
        onChange={(event) => setNote(event.target.value)}
        onBlur={() => {
          if (note !== entry.note) onChange({ ...entry, note });
        }}
      />
      <Button variant="ghost" size="icon" aria-label="Remove model" onClick={onRemove}>
        <Icon name="Trash2" className="size-4" />
      </Button>
    </li>
  );
}

function ModelsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const scope = useScope();
  const preferences = usePreferences();
  const [entries, setEntries] = useState<RotationEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("rotationGet").then(
      (result) => setEntries(result.entries),
      (cause) => setError(errorMessage(cause)),
    );
  }, [rpc]);

  const save = useCallback(
    (next: RotationEntry[]) => {
      setEntries(next);
      rpc.call("rotationSet", { entries: next }).then(
        () => setError(null),
        (cause) => setError(errorMessage(cause)),
      );
    },
    [rpc],
  );

  const add = useCallback(async () => {
    try {
      const { seed } = await rpc.call("rotationSeed");
      if (seed === null) {
        setError("No agent provider is available to pick a model from.");
        return;
      }
      save([...(entries ?? []), seed]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [rpc, entries, save]);

  if (entries === null) return <Loading error={error} />;
  const levels = new Set(scope.state?.scope.reasoningLevels ?? []);
  return (
    <div className="space-y-2">
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No models yet. Magic Compose needs at least one to choose from.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry, index) => (
            <RotationRow
              key={index}
              entry={entry}
              onChange={(next) => save(entries.map((current, i) => (i === index ? next : current)))}
              onRemove={() => save(entries.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={() => void add()}>
        <Icon name="Plus" className="size-4" />
        Add model
      </Button>
      <p className="text-xs text-muted-foreground">
        The effort on a row is only a fallback, for a model that offers no choice of effort.
      </p>

      <Label>Effort Magic Compose may use</Label>
      {scope.state === null ? (
        <Loading error={scope.error} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {REASONING_LEVELS.map((level) => (
            <Chip
              key={level}
              on={levels.has(level)}
              // Magic Compose always needs some effort to run at.
              disabled={levels.has(level) && levels.size === 1}
              title={
                COSTLY.has(level)
                  ? "A special run mode. Costs far more than a reasoning level."
                  : undefined
              }
              onClick={() =>
                scope.save({
                  reasoningLevels: REASONING_LEVELS.filter((entry) =>
                    entry === level ? !levels.has(entry) : levels.has(entry),
                  ),
                })
              }
            >
              {level}
              {COSTLY.has(level) && <span className="text-muted-foreground">$$</span>}
            </Chip>
          ))}
        </div>
      )}

      <Label>How to choose a model and effort</Label>
      {preferences.preferences === null ? (
        <Loading error={preferences.error} />
      ) : (
        <Instructions
          what="model instructions"
          placeholder="Use Fable for UI design and planning, Opus for most other tasks, Sonnet for simple tasks."
          value={preferences.preferences.modelInstructions}
          onSave={(modelInstructions) => preferences.save({ modelInstructions })}
        />
      )}
      <Problem error={error ?? scope.error ?? preferences.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permission mode, and Advanced
// ---------------------------------------------------------------------------

function Fold({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <details className="group border-t border-border py-3 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-sm font-medium text-foreground">
        <Icon
          name="ChevronRight"
          className="size-3.5 self-center text-muted-foreground transition-transform group-open:rotate-90"
        />
        {title}
        {aside !== undefined && (
          <span className="text-xs font-normal text-muted-foreground">{aside}</span>
        )}
      </summary>
      <div className="pt-2">{children}</div>
    </details>
  );
}

/** A one-line setting that is saved when the field is left, and put back if the server refuses it. */
function ModelIdField({
  label,
  value,
  fallback,
  onSave,
}: {
  label: string;
  value: string;
  fallback: string;
  onSave(next: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Row name={label}>
      <Input
        className="w-56 font-mono text-xs"
        value={draft}
        maxLength={200}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim() === "" ? fallback : draft.trim();
          setDraft(next);
          if (next !== value) onSave(next);
        }}
      />
    </Row>
  );
}

function MoreSection() {
  const { preferences, error, save } = usePreferences();
  if (preferences === null) return <Loading error={error} />;
  return (
    <div>
      <Fold title="Permission mode" aside={preferences.permissionMode}>
        <div className="space-y-2">
          <div className="flex gap-1.5">
            {PERMISSION_MODES.map((mode) => (
              <Chip
                key={mode}
                on={preferences.permissionMode === mode}
                onClick={() => save({ permissionMode: mode })}
              >
                {mode}
              </Chip>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            For threads started with <code>bb magic-compose spawn</code>, lowered where a machine or
            provider allows less. In the composer, the permission picker is yours.
          </p>
        </div>
      </Fold>
      <Fold title="Advanced">
        <Card>
          <ModelIdField
            label="Jev model id on OpenRouter"
            value={preferences.openRouterJevModel}
            fallback={DEFAULT_PREFERENCES.openRouterJevModel}
            onSave={(openRouterJevModel) => save({ openRouterJevModel })}
          />
          <ModelIdField
            label="Jev model id on Vercel"
            value={preferences.jevModel}
            fallback={DEFAULT_PREFERENCES.jevModel}
            onSave={(jevModel) => save({ jevModel })}
          />
        </Card>
      </Fold>
      <Problem error={error} />
    </div>
  );
}

/** The plugin's sections, in the order they are read. BB's card with the API keys comes first. */
export function registerSettings(app: PluginAppBuilder): void {
  app.slots.settingsSection({
    id: "try",
    title: "Try it",
    description:
      "See where a prompt would go. Nothing is started. It is also the quickest check that Magic Compose can reach Jev.",
    component: TrySection,
  });
  app.slots.settingsSection({
    id: "composer",
    title: "In the composer",
    description: "What Magic Compose does while it is on: the wand beside the send button.",
    component: ComposerSection,
  });
  app.slots.settingsSection({
    id: "about",
    title: "About you",
    description:
      "Sent with every question: who you are, what your setup is, anything Jev should always know.",
    component: AboutSection,
  });
  app.slots.settingsSection({
    id: "projects",
    title: "Projects",
    description: "Which projects Magic Compose may choose between, and how to choose.",
    component: ProjectsSection,
  });
  app.slots.settingsSection({
    id: "machines",
    title: "Machines",
    description:
      "What Jev is told about each connected machine, word for word, and how to choose between them.",
    component: MachinesSection,
  });
  app.slots.settingsSection({
    id: "environments",
    title: "Environments",
    description:
      "Where a thread works. With one on, Magic Compose always uses it; with several, Jev picks per prompt. A project none of them can serve, such as one that is not a git repository, falls back to Project checkout.",
    component: EnvironmentsSection,
  });
  app.slots.settingsSection({
    id: "models",
    title: "Models and effort",
    description:
      "The models Magic Compose may pick, each with a note on when to use it, and how hard they may think. Jev picks the effort for each prompt from the levels the model supports and you allow.",
    component: ModelsSection,
  });
  app.slots.settingsSection({ id: "more", component: MoreSection });
}
