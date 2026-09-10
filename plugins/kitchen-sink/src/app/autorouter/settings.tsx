import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import { useId, useState } from "react";
import {
  DEFAULT_ENABLED_ROUTES,
  DEFAULT_GENERAL_RULE,
  DEFAULT_ROUTE,
  MODELS,
  ROUTES,
  enabledRouteIds,
  modelEnabledKey,
  projectIndexSchema,
  routeEnabledKey,
  ruleSettingKey,
} from "../../shared/autorouter/policy.ts";
import type { AutorouterSettingsRpcContract } from "../../shared/autorouter/settings-contract.ts";
import "./settings.css";

type Values = Record<string, string | number | boolean>;
type Save = (values: Record<string, string | boolean>) => Promise<boolean>;

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className="autorouter-settings-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function TextEditor({
  label,
  value,
  setting,
  save,
  busy,
  maxLength,
  defaultValue,
  validate,
}: {
  label: string;
  value: string;
  setting: string;
  save: Save;
  busy: boolean;
  maxLength: number;
  defaultValue?: string;
  validate?: (value: string) => string | null;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const text = draft ?? value;
  const dirty = text !== value;
  const error = validate?.(text);
  return (
    <div className="autorouter-settings-editor">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={text}
        maxLength={maxLength}
        rows={4}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setFeedback("");
        }}
      />
      {error && (
        <p id={`${id}-error`} className="autorouter-settings-error">
          {error}
        </p>
      )}
      <div className="autorouter-settings-editor-actions">
        <button
          type="button"
          className="autorouter-settings-primary"
          disabled={busy || !dirty || Boolean(error)}
          onClick={async () => {
            if (await save({ [setting]: text })) {
              setDraft((current) => (current === text ? null : current));
              setFeedback("Saved");
            } else setFeedback("Could not save. Your draft is kept.");
          }}
        >
          Save changes
        </button>
        {dirty && (
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>
            Cancel
          </button>
        )}
        {defaultValue !== undefined && text !== defaultValue && (
          <button
            type="button"
            className="autorouter-settings-quiet"
            disabled={busy}
            onClick={() => setDraft(defaultValue)}
          >
            Use default
          </button>
        )}
        {dirty && <span className="autorouter-settings-muted">Unsaved changes</span>}
        <output className="autorouter-settings-muted">{feedback}</output>
      </div>
    </div>
  );
}

function ModelSettings({
  model,
  values,
  save,
  busy,
}: {
  model: (typeof MODELS)[number];
  values: Values;
  save: Save;
  busy: boolean;
}) {
  const routes = ROUTES.filter((route) => route.key === model.key);
  const enabled = (values[modelEnabledKey(model.key)] ?? model.key !== "sol") === true;
  const count = routes.filter(
    (route) => (values[routeEnabledKey(route.id)] ?? DEFAULT_ENABLED_ROUTES.has(route.id)) === true,
  ).length;
  return (
    <div className="autorouter-settings-model">
      <details>
        <summary className="autorouter-settings-model-summary">
          <span className="autorouter-settings-model-name">{model.label}</span>
          <span className="autorouter-settings-muted">
            {model.providerId === "codex" ? "Codex" : "Claude Code"}
          </span>
          <span className="autorouter-settings-count">
            {enabled ? `${count} ${count === 1 ? "level" : "levels"}` : "Off"}
          </span>
        </summary>
        <div className="autorouter-settings-model-body">
          {!enabled && (
            <p className="autorouter-settings-muted">
              This model is off. Its reasoning levels and guidance are kept for when you enable it.
            </p>
          )}
          {enabled && count === 0 && (
            <p className="autorouter-settings-warning">
              Enable a reasoning level to include this model in routing.
            </p>
          )}
          {routes.map((route) => (
            <div key={route.id} className="autorouter-settings-route">
              <label className="autorouter-settings-level">
                <input
                  type="checkbox"
                  checked={
                    (values[routeEnabledKey(route.id)] ?? DEFAULT_ENABLED_ROUTES.has(route.id)) ===
                    true
                  }
                  disabled={busy}
                  aria-label={`Allow ${route.label}`}
                  onChange={(event) =>
                    void save({ [routeEnabledKey(route.id)]: event.target.checked })
                  }
                />
                {route.reasoningLevel === "ultracode" ? "ultra" : route.reasoningLevel}
              </label>
              <details className="autorouter-settings-guidance">
                <summary>
                  <span>Routing guidance</span>
                  <span className="autorouter-settings-rule-preview">
                    {String(values[ruleSettingKey(route.id)] ?? route.prompt)}
                  </span>
                </summary>
                <TextEditor
                  label={`When to use ${route.label}`}
                  value={String(values[ruleSettingKey(route.id)] ?? route.prompt)}
                  setting={ruleSettingKey(route.id)}
                  defaultValue={route.prompt}
                  maxLength={4_000}
                  save={save}
                  busy={busy}
                  validate={(text) => (text.trim() ? null : "Enter routing guidance.")}
                />
              </details>
            </div>
          ))}
        </div>
      </details>
      <div className="autorouter-settings-model-toggle">
        <Toggle
          label={`Enable ${model.label}`}
          checked={enabled}
          disabled={busy}
          onChange={(checked) => void save({ [modelEnabledKey(model.key)]: checked })}
        />
      </div>
    </div>
  );
}

function readProjectIndex(text: string) {
  try {
    return projectIndexSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

function ProjectSettings({ values, save, busy }: { values: Values; save: Save; busy: boolean }) {
  const text = String(values.autorouterProjectIndex ?? "[]");
  const parsed = readProjectIndex(text);
  const entries = parsed?.success ? parsed.data : [];
  return (
    <section className="autorouter-settings-section" aria-labelledby="autorouter-projects-heading">
      <div className="autorouter-settings-row">
        <div>
          <h3 id="autorouter-projects-heading">Project routing</h3>
          <p>Choose a project for new threads using repository summaries and example tasks.</p>
        </div>
        <Toggle
          label="Project routing"
          checked={values.autorouterProjectRouting !== false}
          disabled={busy}
          onChange={(checked) => void save({ autorouterProjectRouting: checked })}
        />
      </div>
      {entries.length > 0 ? (
        <div className="autorouter-settings-projects">
          <p className="autorouter-settings-caption">
            {entries.length} indexed {entries.length === 1 ? "repository" : "repositories"}
          </p>
          {entries.map((entry) => (
            <details className="autorouter-settings-project" key={`${entry.hostId}:${entry.path}`}>
              <summary>
                <strong>{entry.repository}</strong>
                <span>{entry.summary}</span>
              </summary>
              <div className="autorouter-settings-project-body">
                <p className="autorouter-settings-path">{entry.path}</p>
                <p className="autorouter-settings-muted">
                  {entry.projectId
                    ? "Linked to a BB project"
                    : "Not linked. Add a BB project ID in the advanced editor to use this repository for routing."}
                </p>
                <ul>
                  {entry.examples.map((example) => (
                    <li key={example}>{example}</li>
                  ))}
                </ul>
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="autorouter-settings-empty">
          <strong>
            {parsed?.success ? "No repositories indexed yet" : "Project index needs attention"}
          </strong>
          <p>
            {parsed?.success ? (
              <>
                Run <code>/index-projects</code> in a thread to index <code>~/git</code>. The router
                can still recognize known project names.
              </>
            ) : (
              "Open the advanced editor below to correct the project index."
            )}
          </p>
        </div>
      )}
      <details className="autorouter-settings-advanced">
        <summary>Advanced: edit project index</summary>
        <p>
          Each entry needs a repository, path, host ID, project ID (or null), a summary, and three
          distinct example tasks.
        </p>
        <TextEditor
          label="Project index JSON"
          value={text}
          setting="autorouterProjectIndex"
          save={save}
          busy={busy}
          maxLength={512_000}
          validate={(draft) => {
            const result = readProjectIndex(draft);
            if (!result) return "Enter a valid JSON array.";
            return result.success
              ? null
              : result.error.issues
                  .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                  .join(" ");
          }}
        />
      </details>
    </section>
  );
}

export function AutorouterSettings() {
  const settings = useSettings();
  const rpc = useRpc<AutorouterSettingsRpcContract>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const save: Save = async (values) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await rpc.call("updateAutorouterSettings", { values });
      setStatus("Changes saved");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (settings.isLoading) return <output>Loading autorouter settings…</output>;
  if (!settings.values)
    return <p role="alert">Autorouter settings are unavailable. Reload to try again.</p>;
  const values = settings.values;
  const enabled = values.autorouterEnabled === true;
  const routes = enabledRouteIds(values);
  const fallback = String(values.autorouterFallback ?? DEFAULT_ROUTE);
  return (
    <div className="autorouter-settings">
      <header className="autorouter-settings-header">
        <div className="autorouter-settings-row">
          <div>
            <h2>Autorouter</h2>
            <p>Match each task to the right model and project.</p>
          </div>
          <Toggle
            label="Autorouter"
            checked={enabled}
            disabled={busy}
            onChange={(checked) => void save({ autorouterEnabled: checked })}
          />
        </div>
        <div className="autorouter-settings-status">
          <span className={enabled ? "autorouter-settings-on" : ""}>{enabled ? "On" : "Off"}</span>
          <span>
            {enabled
              ? "Available in the composer. Pause it there for an individual prompt."
              : "Enable to show the autorouter in the composer. You can configure it below."}
          </span>
        </div>
      </header>
      <div className="autorouter-settings-save-status" aria-live="polite">
        {busy ? "Saving…" : status}
      </div>
      {error && (
        <p className="autorouter-settings-error" role="alert">
          {error}
        </p>
      )}
      <section className="autorouter-settings-section" aria-labelledby="autorouter-models-heading">
        <div className="autorouter-settings-row">
          <div>
            <h3 id="autorouter-models-heading">Model routing</h3>
            <p>Choose the models and reasoning levels the router may use.</p>
          </div>
          <Toggle
            label="Model routing"
            checked={values.autorouterModelRouting !== false}
            disabled={busy}
            onChange={(checked) => void save({ autorouterModelRouting: checked })}
          />
        </div>
        <div className="autorouter-settings-models">
          {MODELS.map((model) => (
            <ModelSettings key={model.key} model={model} values={values} save={save} busy={busy} />
          ))}
        </div>
        {routes.size === 0 && values.autorouterModelRouting !== false && (
          <p className="autorouter-settings-warning">
            No routes are enabled. Enable a model and at least one reasoning level to route tasks.
          </p>
        )}
        <div className="autorouter-settings-fallback">
          <label htmlFor="autorouter-fallback">Fallback</label>
          <select
            id="autorouter-fallback"
            value={fallback}
            disabled={busy || routes.size === 0}
            onChange={(event) => void save({ autorouterFallback: event.target.value })}
          >
            {ROUTES.filter((route) => routes.has(route.id) || route.id === fallback).map(
              (route) => (
                <option key={route.id} value={route.id} disabled={!routes.has(route.id)}>
                  {route.label}
                  {routes.has(route.id) ? "" : " (disabled)"}
                </option>
              ),
            )}
          </select>
          <p>
            Used for new threads when routing is uncertain. Follow-ups keep their current selection
            on failure.
          </p>
          {!routes.has(fallback) && routes.size > 0 && (
            <p className="autorouter-settings-warning">
              This fallback is disabled. The router will use another enabled route until you choose
              one.
            </p>
          )}
        </div>
        <details className="autorouter-settings-advanced">
          <summary>General routing guidance</summary>
          <p>
            Applies across all models. Individual reasoning levels have their own guidance above.
          </p>
          <TextEditor
            label="General routing rule"
            value={String(values.autorouterGeneralRule ?? DEFAULT_GENERAL_RULE)}
            setting="autorouterGeneralRule"
            maxLength={8_000}
            defaultValue={DEFAULT_GENERAL_RULE}
            save={save}
            busy={busy}
          />
        </details>
      </section>
      <ProjectSettings values={values} save={save} busy={busy} />
    </div>
  );
}

export function AutorouterSettingsPanel() {
  return (
    <div className="autorouter-settings-panel">
      <AutorouterSettings />
    </div>
  );
}
