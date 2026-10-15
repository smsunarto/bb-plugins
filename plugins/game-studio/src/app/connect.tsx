import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "./icons.tsx";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalProviderModelPickerValue,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { Game } from "../shared/schema.ts";
import { rpc } from "./rpc.ts";

type Location = { hostId: string; rootPath: string };
type Host = { id: string; name: string; online: boolean };
type Mode = "connect" | "new";
type Validation = {
  kind: "offline" | "empty" | "checking" | "invalid" | "verified";
  message: string;
};
type Inspection = {
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  data: { version: string | null } | undefined;
};

function projectValidation(
  online: boolean,
  path: string,
  current: boolean,
  inspection: Inspection,
): Validation {
  if (!online)
    return { kind: "offline", message: "Select an online machine to check the project." };
  if (!path) return { kind: "empty", message: "Enter the Unity project’s absolute folder path." };
  if (!current || inspection.isPending || inspection.isFetching)
    return { kind: "checking", message: "Checking Unity project…" };
  if (inspection.isError)
    return {
      kind: "invalid",
      message: `Cannot read this project: ${inspection.error?.message ?? "Check the machine connection."}`,
    };
  if (inspection.data?.version)
    return { kind: "verified", message: `Unity ${inspection.data.version} · Project verified` };
  return {
    kind: "invalid",
    message:
      "Not a Unity project. Choose a folder containing ProjectSettings/ProjectVersion.txt and Assets.",
  };
}

function submitLabel(
  busy: boolean,
  existing: Game | undefined,
  mode: Mode,
  recovering: boolean,
): string {
  if (busy) return mode === "new" ? "Creating…" : "Connecting…";
  if (recovering) return "Finish connecting";
  if (existing) return "Open project";
  return mode === "connect" ? "Connect project" : "Create Unity project";
}

function folderName(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
}

function comparisonPath(path: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) {
    return path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.replace(/\/+$/, "");
}

function sameLocation(a: Location, b: Location): boolean {
  return a.hostId === b.hostId && comparisonPath(a.rootPath) === comparisonPath(b.rootPath);
}

function useConnection(hosts: Host[], onCreated: (game: Game) => void, initialMode: Mode) {
  const client = rpc.useClient();
  const sdk = useSdk();
  const registry = rpc.overview.useQuery({}, { staleTime: 0 });
  const [name, updateName] = useState("");
  const nameEdited = useRef(false);
  const [hostId, setHost] = useState(() => hosts.find((host) => host.online)?.id ?? "");
  const [rootPath, updatePath] = useState("");
  const [mode, setMode] = useState<Mode>(initialMode);
  const [versionMode, setVersionMode] = useState("hub");
  const [version, setVersion] = useState("");
  const [template, setTemplate] = useState<"3d-urp" | "2d-urp" | "empty">("3d-urp");
  const [firstPrompt, setFirstPrompt] = useState("");
  const [agent, setAgent] = useState<ExperimentalProviderModelPickerValue>({
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "high",
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [createdGame, setCreatedGame] = useState<Game | null>(null);
  const [dispatchUncertain, setDispatchUncertain] = useState(false);
  // Keep the successful dispatch when linking or recording fails. Retrying must never spawn twice.
  const pending = useRef<{
    game: Game;
    prepared?: Awaited<ReturnType<typeof client.prompt>>;
    threadId?: string;
    dispatchAttempted?: boolean;
  } | null>(null);
  const [returnedExisting, setReturnedExisting] = useState<{
    game: Game;
    location: Location;
  } | null>(null);
  const [settled, setSettled] = useState<Location>({ hostId: "", rootPath: "" });
  const location = { hostId, rootPath: rootPath.trim() };
  const hostOnline = hosts.some((host) => host.id === hostId && host.online);
  const locationReady = !!location.rootPath && hostOnline;
  const isCurrent = settled.hostId === hostId && settled.rootPath === location.rootPath;

  function setName(value: string) {
    nameEdited.current = true;
    updateName(value);
  }
  function setPath(value: string) {
    updatePath(value);
    if (!nameEdited.current) updateName(folderName(value));
  }

  useEffect(() => {
    const timer = setTimeout(() => setSettled({ hostId, rootPath: rootPath.trim() }), 350);
    return () => clearTimeout(timer);
  }, [hostId, rootPath]);

  const inspection = rpc.inspectUnity.useQuery(settled, {
    enabled: mode === "connect" && locationReady && isCurrent,
    retry: false,
    staleTime: 0,
  });
  const existing =
    returnedExisting && sameLocation(returnedExisting.location, location)
      ? returnedExisting.game
      : registry.data?.games.find((game) => sameLocation(game, location));
  const validation = projectValidation(hostOnline, location.rootPath, isCurrent, inspection);
  const canSubmit =
    !dispatchUncertain &&
    (!!createdGame ||
      (locationReady &&
        (!!existing ||
          (!!name.trim() &&
            (mode === "new" || validation.kind === "verified") &&
            (mode !== "new" || versionMode === "hub" || !!version.trim())))));
  const key = JSON.stringify([
    mode,
    hostId,
    location.rootPath,
    name,
    version,
    template,
    firstPrompt,
  ]);
  const error = failure?.key === key ? failure.message : "";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !canSubmit) return;
    if (existing && !pending.current) {
      onCreated(existing);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (!pending.current) {
        // Recheck the host immediately before registering, even if the debounced result was valid.
        const [inspected, before] = await Promise.all([
          mode === "connect" ? client.inspectUnity(location) : Promise.resolve(null),
          client.overview({}),
        ]);
        if (mode === "connect" && !inspected?.version) {
          throw new Error("Not a Unity project: ProjectSettings/ProjectVersion.txt was not found.");
        }
        const game = await client.create({
          name: name.trim(),
          ...location,
          kind: "unity",
          ...(mode === "new"
            ? {
                unitySetup: {
                  version: versionMode === "exact" ? version.trim() : null,
                  template,
                },
              }
            : {}),
        });
        if (before.games.some(({ id }) => id === game.id)) {
          setReturnedExisting({ game, location });
          return;
        }
        pending.current = { game };
        setCreatedGame(game);
      }
      const current = pending.current;
      if (mode === "connect" && !firstPrompt.trim()) {
        onCreated(current.game);
        return;
      }
      current.prepared ??= await client.prompt({
        gameId: current.game.id,
        action: mode === "new" ? "new-unity" : "build",
      });
      if (!current.threadId) {
        if (current.dispatchAttempted) {
          throw new Error(
            "Thread creation is uncertain. Open this project and check its BB threads before sending another request.",
          );
        }
        current.dispatchAttempted = true;
        try {
          const thread = await sdk.threads.spawn({
            ...agent,
            projectId: current.game.projectId,
            environment: {
              type: "host",
              hostId: current.game.hostId,
              workspace: { type: "unmanaged", path: current.game.rootPath },
            },
            input: [
              { type: "text", text: current.prepared.context, mentions: [] },
              { type: "text", text: current.prepared.prompt, mentions: [] },
              ...(firstPrompt.trim()
                ? [{ type: "text" as const, text: firstPrompt.trim(), mentions: [] }]
                : []),
            ],
            title: `${current.game.name} · Unity`,
            pluginMetadata: { gameId: current.game.id, requestId: current.prepared.request.id },
          });
          current.threadId = thread.id;
        } catch (cause) {
          setDispatchUncertain(true);
          throw new Error(
            `Could not confirm the agent thread. Check BB before retrying: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }
      const linked = await client.updateGame({
        gameId: current.game.id,
        threadId: current.threadId,
      });
      await client.recordRequest({
        gameId: current.game.id,
        request: current.prepared.request,
        threadId: current.threadId,
        status: "running",
      });
      onCreated(linked);
    } catch (cause) {
      setFailure({ key, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  }

  return {
    name,
    setName,
    hostId,
    setHost,
    rootPath,
    setPath,
    mode,
    setMode,
    versionMode,
    setVersionMode,
    version,
    setVersion,
    template,
    setTemplate,
    firstPrompt,
    setFirstPrompt,
    agent,
    setAgent,
    hostOnline,
    busy,
    error,
    existing,
    validation,
    canSubmit,
    submit,
    createdGame,
    dispatchUncertain,
  };
}

type UnitySetupFieldsProps = Pick<
  ReturnType<typeof useConnection>,
  "versionMode" | "setVersionMode" | "version" | "setVersion" | "template" | "setTemplate"
> & { disabled: boolean };

function UnitySetupFields({
  versionMode,
  setVersionMode,
  version,
  setVersion,
  template,
  setTemplate,
  disabled,
}: UnitySetupFieldsProps) {
  return (
    <>
      <label>
        Unity version
        <select
          value={versionMode}
          onChange={(event) => setVersionMode(event.target.value)}
          disabled={disabled}
        >
          <option value="hub">Agent chooses via Hub</option>
          <option value="exact">Specify version…</option>
        </select>
      </label>
      {versionMode === "exact" && (
        <label>
          Exact Unity version
          <input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="6000.0.32f1"
            required
            disabled={disabled}
            maxLength={100}
          />
        </label>
      )}
      <label>
        Template
        <select
          value={template}
          onChange={(event) => setTemplate(event.target.value as typeof template)}
          disabled={disabled}
        >
          <option value="3d-urp">3D URP</option>
          <option value="2d-urp">2D URP</option>
          <option value="empty">Empty</option>
        </select>
      </label>
    </>
  );
}

export function ConnectDialog({
  onClose,
  onCreated,
  hosts,
  initialMode = "connect",
}: {
  onClose: () => void;
  onCreated: (game: Game) => void;
  hosts: Host[];
  initialMode?: Mode;
}) {
  const {
    name,
    setName,
    hostId,
    setHost,
    rootPath,
    setPath,
    mode,
    setMode,
    hostOnline,
    busy,
    error,
    existing,
    validation,
    canSubmit,
    submit,
    createdGame,
    dispatchUncertain,
    versionMode,
    setVersionMode,
    version,
    setVersion,
    template,
    setTemplate,
    firstPrompt,
    setFirstPrompt,
    agent,
    setAgent,
  } = useConnection(hosts, onCreated, initialMode);
  const locked = busy || !!createdGame;

  return (
    <dialog
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      className="gs-dialog"
      aria-labelledby="gs-connect-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <header>
          <h2 id="gs-connect-title">
            {mode === "connect" ? "Connect Unity project" : "New Unity project"}
          </h2>
          <button
            type="button"
            className="gs-icon"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="X" />
          </button>
        </header>
        <div className="gs-segment">
          <button
            type="button"
            aria-pressed={mode === "connect"}
            onClick={() => {
              setMode("connect");
            }}
            disabled={locked}
          >
            Existing project
          </button>
          <button
            type="button"
            aria-pressed={mode === "new"}
            onClick={() => {
              setMode("new");
            }}
            disabled={locked}
          >
            New project
          </button>
        </div>
        <label>
          Project folder
          <input
            autoFocus
            value={rootPath}
            onChange={(event) => {
              setPath(event.target.value);
            }}
            placeholder="/absolute/path/to/unity-project"
            required
            disabled={locked}
            aria-describedby={mode === "connect" ? "gs-project-validation" : undefined}
            aria-invalid={mode === "connect" && validation.kind === "invalid" && !existing}
          />
        </label>
        {mode === "connect" && (
          <output
            id="gs-project-validation"
            aria-live="polite"
            className={
              validation.kind === "verified"
                ? "gs-success"
                : validation.kind === "invalid"
                  ? "gs-danger"
                  : "gs-muted"
            }
          >
            {validation.kind === "invalid" && <span aria-hidden="true">✕ </span>}
            {validation.message}
          </output>
        )}
        {existing && (
          <p className="gs-muted">This folder is already in Game Studio as “{existing.name}”.</p>
        )}
        <label>
          Machine
          <select
            value={hostId}
            onChange={(event) => {
              setHost(event.target.value);
            }}
            required
            disabled={locked}
          >
            {hosts.map((host) => (
              <option key={host.id} value={host.id} disabled={!host.online}>
                {host.name}
                {!host.online ? " · Offline" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project name
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="My Unity Game"
            required={!existing}
            maxLength={120}
            disabled={locked}
          />
        </label>
        {mode === "new" && (
          <UnitySetupFields
            versionMode={versionMode}
            setVersionMode={setVersionMode}
            version={version}
            setVersion={setVersion}
            template={template}
            setTemplate={setTemplate}
            disabled={locked}
          />
        )}
        <div className="gs-connect-agent">
          <span>Agent</span>
          <ProviderModelPicker
            value={agent}
            onChange={setAgent}
            routing={{ kind: "host", hostId }}
            disabled={locked || !hostOnline}
          />
        </div>
        <label>
          First prompt <span className="gs-muted">Optional</span>
          <textarea
            value={firstPrompt}
            onChange={(event) => setFirstPrompt(event.target.value)}
            placeholder="Describe the game you want to make…"
            rows={3}
            disabled={locked}
            maxLength={12000}
          />
        </label>
        <p className="gs-muted">
          {mode === "connect"
            ? "Design files and uploads stay in canvas/. The agent imports assets under the Editor’s authoring claim."
            : "Creates canvas/ and sends the Unity project request to your selected agent. The agent uses Hub with your chosen version and template."}
        </p>
        {error && (
          <div className="gs-notice" role="alert">
            {error}
          </div>
        )}
        {dispatchUncertain && createdGame && (
          <button type="button" onClick={() => onCreated(createdGame)}>
            Open project to check agent threads
          </button>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="gs-primary" disabled={busy || !canSubmit}>
            {submitLabel(busy, existing, mode, !!createdGame)}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
