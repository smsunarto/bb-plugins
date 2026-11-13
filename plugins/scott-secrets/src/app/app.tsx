import { definePluginApp, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useId, useMemo, useState, type ReactNode } from "react";

type SubmitEvent = { preventDefault(): void };
import { displayCommand } from "../shared/command.ts";
import { reconcileDotenv } from "../shared/dotenv.ts";
import {
  SECRET_REQUEST_RENDERER,
  SUDO_REQUEST_RENDERER,
  secretRequestPayloadSchema,
  secretRequestResponseSchema,
  sudoRequestPayloadSchema,
} from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";

type Busy = "submit" | "cancel" | null;

function InvalidRequest({ cancel, what }: { cancel: () => Promise<void>; what: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">This {what} request is invalid.</p>
      <Button variant="outline" onClick={() => void cancel().catch(() => {})}>
        Cancel
      </Button>
    </div>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p
      className="rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
      aria-live="polite"
    >
      {children}
    </p>
  );
}

function Actions({
  busy,
  submitLabel,
  cancelLabel,
  onCancel,
}: {
  busy: Busy;
  submitLabel: string;
  cancelLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="sticky -bottom-3 z-10 -mx-3 -mb-3 flex flex-col-reverse gap-2 border-t border-border bg-surface-recessed-solid px-3 pb-3 pt-4 @min-[24rem]/secrets:flex-row @min-[24rem]/secrets:items-center @min-[24rem]/secrets:justify-end">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full @min-[24rem]/secrets:w-auto"
        disabled={busy !== null}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      <Button
        type="submit"
        size="sm"
        className="w-full @min-[24rem]/secrets:w-auto"
        disabled={busy !== null}
      >
        {busy === "submit" ? "Working…" : submitLabel}
      </Button>
    </div>
  );
}

function SecretField(props: {
  id: string;
  name: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={props.id}
        name={props.name}
        type={visible ? "text" : "password"}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
        className="bg-card pr-16 font-mono"
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="absolute right-1 top-1/2 h-7 -translate-y-1/2 px-2 text-xs text-muted-foreground"
        aria-label={`${visible ? "Hide" : "Show"} ${props.name}`}
        aria-pressed={visible}
        onClick={() => setVisible((shown) => !shown)}
        disabled={props.disabled}
      >
        {visible ? "Hide" : "Show"}
      </Button>
    </div>
  );
}

/** The builtin Secrets form, unchanged in behaviour. */
function SecretRequestForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => secretRequestPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  if (!parsed.success) return <InvalidRequest cancel={cancel} what="secret" />;
  const request = parsed.data;

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    const checked = secretRequestResponseSchema.safeParse({ values });
    if (!checked.success) {
      setError("Every secret must be a non-empty single-line value no larger than 16 KiB.");
      return;
    }
    try {
      reconcileDotenv("", checked.data.values);
    } catch {
      setError("One value cannot be represented safely in a dotenv assignment.");
      return;
    }
    setError(null);
    setBusy("submit");
    try {
      await submit({ values });
    } catch {
      setBusy(null);
    }
  };
  const onCancel = async () => {
    setBusy("cancel");
    try {
      await cancel();
    } catch {
      setBusy(null);
    }
  };

  return (
    <form
      className="@container/secrets flex flex-col gap-4"
      onSubmit={(event) => void onSubmit(event)}
    >
      <div className="flex flex-col gap-2">
        {request.purpose ? (
          <p className="text-pretty text-sm leading-relaxed text-foreground">{request.purpose}</p>
        ) : null}
        <p className="min-w-0 text-xs text-muted-foreground">
          Secrets will be written directly to{" "}
          <code className="break-all rounded bg-surface-raised px-1.5 py-0.5 font-mono text-foreground">
            {request.destination.path}
          </code>
        </p>
      </div>
      <div className="flex flex-col gap-3.5">
        {request.fields.map((field) => {
          const id = `secret-${interaction.id}-${field.name}`;
          return (
            <div key={field.name} className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-col gap-0.5">
                <label
                  htmlFor={id}
                  className="font-mono text-xs font-semibold text-foreground"
                  translate="no"
                >
                  {field.name}
                </label>
                {field.description ? (
                  <p className="text-xs leading-snug text-muted-foreground">{field.description}</p>
                ) : null}
              </div>
              <SecretField
                id={id}
                name={field.name}
                value={values[field.name] ?? ""}
                disabled={busy !== null}
                onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              />
            </div>
          );
        })}
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Actions
        busy={busy}
        submitLabel="Add secrets"
        cancelLabel="Cancel"
        onCancel={() => void onCancel()}
      />
    </form>
  );
}

/**
 * Approve a root command by typing the sudo password. The thread then runs
 * further sudo commands without asking until the cache window ends.
 */
function SudoRequestForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => sudoRequestPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  if (!parsed.success) return <InvalidRequest cancel={cancel} what="sudo" />;
  const request = parsed.data;
  const command = displayCommand(request.argv);

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (password.length === 0 || /[\r\n\0]/u.test(password)) {
      setError("Enter the sudo password on one line.");
      return;
    }
    setError(null);
    setBusy("submit");
    try {
      await submit({ approved: true, password });
    } catch {
      setBusy(null);
    }
  };
  const onCancel = async () => {
    setBusy("cancel");
    try {
      await cancel();
    } catch {
      setBusy(null);
    }
  };

  return (
    <form
      className="@container/secrets flex flex-col gap-4"
      onSubmit={(event) => void onSubmit(event)}
    >
      <div className="flex flex-col gap-2">
        {request.purpose ? (
          <p className="text-pretty text-sm leading-relaxed text-foreground">{request.purpose}</p>
        ) : null}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised px-2 py-1.5 font-mono text-xs text-foreground">
          <span className="select-none text-muted-foreground"># </span>
          {command}
        </pre>
        <p className="min-w-0 text-xs text-muted-foreground">
          Runs as root in{" "}
          <code className="break-all rounded bg-surface-raised px-1.5 py-0.5 font-mono text-foreground">
            {request.cwd}
          </code>{" "}
          on <span className="font-medium text-foreground">{request.host}</span>.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={passwordId} className="text-xs font-semibold text-foreground">
          sudo password
        </label>
        <SecretField
          id={passwordId}
          name="sudo password"
          value={password}
          disabled={busy !== null}
          onChange={setPassword}
        />
        <p className="text-xs leading-snug text-muted-foreground">
          Kept only in memory on {request.host}, for this thread only, for {request.cacheMinutes}{" "}
          min. Until then, this thread runs sudo commands without asking again.
        </p>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Actions
        busy={busy}
        submitLabel="Run as root"
        cancelLabel="Deny"
        onCancel={() => void onCancel()}
      />
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: SECRET_REQUEST_RENDERER, component: SecretRequestForm });
  app.slots.pendingInteraction({ id: SUDO_REQUEST_RENDERER, component: SudoRequestForm });
});
