import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import type {
  InitiativeWorkspace,
  SharedDirectoryLocation,
  SharedDirectoryPreviewError,
  SharedDirectoryRepositoryPreview,
  SharedDirectoryWorkspacePreview,
} from "@/lib/initiative-types";
import { createLatestRequestGuard } from "@/lib/initiative-ui";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type SharedDirectorySelection = Omit<
  Extract<InitiativeWorkspace, { mode: "shared-directory" }>,
  "mode"
>;

export interface SharedDirectoryPreviewController {
  status: "idle" | "loading" | "ready" | "error";
  preview: SharedDirectoryWorkspacePreview | null;
  draftHostId: string;
  draftRootPath: string;
  dirty: boolean;
  requestError: string | null;
  confirmedDirectory: SharedDirectorySelection | null;
  setDraftHostId: (hostId: string) => void;
  setDraftRootPath: (rootPath: string) => void;
  validate: () => void;
}

interface PreviewCandidate {
  hostId?: string;
  rootPath?: string;
}

/**
 * Resolve and validate the shared directory on the backend. The request id
 * prevents a slow response for an earlier repository selection or edited path
 * from becoming the create confirmation.
 */
export function useSharedDirectoryPreview({
  workspaceProjectIds,
  enabled,
  initialDirectory = null,
  refreshKey = null,
}: {
  workspaceProjectIds: readonly string[];
  enabled: boolean;
  initialDirectory?: SharedDirectorySelection | null;
  /** Stable domain revision that should trigger a fresh read-only preview. */
  refreshKey?: string | number | null;
}): SharedDirectoryPreviewController {
  const rpc = useRpc<typeof initiativeRpcContract>();
  const [requestGuard] = useState(createLatestRequestGuard);
  const workspaceKey = workspaceProjectIds.join("\u0000");
  const initialHostId = initialDirectory?.hostId ?? null;
  const initialRootPath = initialDirectory?.rootPath ?? null;
  const [status, setStatus] = useState<SharedDirectoryPreviewController["status"]>("idle");
  const [preview, setPreview] = useState<SharedDirectoryWorkspacePreview | null>(null);
  const [resolvedWorkspaceKey, setResolvedWorkspaceKey] = useState<string | null>(null);
  const [draftHostId, setDraftHost] = useState(initialDirectory?.hostId ?? "");
  const [draftRootPath, setDraft] = useState(initialDirectory?.rootPath ?? "");
  const [dirty, setDirty] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const load = useCallback(
    (candidate: PreviewCandidate | null) => {
      const currentRequestId = requestGuard.begin();
      setStatus("loading");
      setRequestError(null);
      void rpc
        .call("previewInitiativeWorkspace", {
          workspaceProjectIds: workspaceKey === "" ? [] : workspaceKey.split("\u0000"),
          candidate,
        })
        .then((result) => {
          if (!requestGuard.isCurrent(currentRequestId)) return;
          const location = result.selection ?? result.suggested;
          setPreview(result);
          setResolvedWorkspaceKey(workspaceKey);
          setDraftHost(result.selection?.hostId ?? candidate?.hostId ?? location?.hostId ?? "");
          setDraft(result.selection?.rootPath ?? candidate?.rootPath ?? location?.rootPath ?? "");
          setDirty(false);
          setStatus("ready");
          return undefined;
        })
        .catch((error: unknown) => {
          if (!requestGuard.isCurrent(currentRequestId)) return;
          setStatus("error");
          setRequestError(
            error instanceof Error ? error.message : "Couldn’t validate the shared directory.",
          );
        });
    },
    [requestGuard, rpc, workspaceKey],
  );

  useEffect(() => {
    if (!enabled) {
      requestGuard.invalidate();
      setStatus("idle");
      setPreview(null);
      setResolvedWorkspaceKey(null);
      setDraftHost("");
      setDraft("");
      setDirty(false);
      setRequestError(null);
      return;
    }
    load(
      initialHostId === null || initialRootPath === null
        ? null
        : { hostId: initialHostId, rootPath: initialRootPath },
    );
    return () => requestGuard.invalidate();
  }, [enabled, initialHostId, initialRootPath, load, refreshKey, requestGuard]);

  const editDraft = useCallback(() => {
    requestGuard.invalidate();
    setDirty(true);
    setStatus((current) => (current === "loading" ? "ready" : current));
    setRequestError(null);
  }, [requestGuard]);

  const setDraftHostId = useCallback(
    (hostId: string) => {
      editDraft();
      setDraftHost(hostId);
    },
    [editDraft],
  );

  const setDraftRootPath = useCallback(
    (rootPath: string) => {
      editDraft();
      setDraft(rootPath);
    },
    [editDraft],
  );

  const validate = useCallback(() => {
    const hostId = draftHostId.trim();
    const rootPath = draftRootPath.trim();
    if (hostId === "") {
      setRequestError("Enter a machine ID to validate.");
      return;
    }
    if (rootPath === "") {
      setRequestError("Enter a directory to validate.");
      return;
    }
    load({ hostId, rootPath });
  }, [draftHostId, draftRootPath, load]);

  const confirmedDirectory =
    status === "ready" &&
    !dirty &&
    resolvedWorkspaceKey === workspaceKey &&
    preview?.eligible === true &&
    preview.selection !== null &&
    preview.errors.length === 0
      ? { hostId: preview.selection.hostId, rootPath: preview.selection.rootPath }
      : null;

  return {
    status,
    preview,
    draftHostId,
    draftRootPath,
    dirty,
    requestError,
    confirmedDirectory,
    setDraftHostId,
    setDraftRootPath,
    validate,
  };
}

export function SharedDirectoryPreview({
  controller,
  editable,
  fallbackDirectory = null,
}: {
  controller: SharedDirectoryPreviewController;
  editable: boolean;
  fallbackDirectory?: SharedDirectorySelection | null;
}) {
  const { preview } = controller;
  const resolvedLocation = preview?.selection ?? preview?.suggested;
  const location =
    resolvedLocation ??
    (fallbackDirectory === null
      ? null
      : { ...fallbackDirectory, hostName: fallbackDirectory.hostId });
  const errors = preview?.errors ?? [];

  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
      data-shared-directory-preview=""
      data-status={controller.status}
    >
      <p className="text-xs text-muted-foreground">
        The coordinator and every agent reuse this directory. Agents can access everything under it,
        not only the selected repositories.
      </p>

      <PreviewLocation
        location={location}
        resolved={resolvedLocation !== null && resolvedLocation !== undefined}
        editable={editable}
        controller={controller}
      />
      <ValidationPrompt controller={controller} editable={editable} preview={preview} />
      <RepositoryPaths repositories={preview?.repositories ?? []} />

      {controller.confirmedDirectory !== null ? (
        <p
          className="flex items-center gap-1.5 text-2xs text-muted-foreground"
          data-shared-directory-confirmed=""
        >
          <Icon name="Check" className="size-3 text-primary" aria-hidden />
          Directory validated for reuse.
        </p>
      ) : null}

      {controller.status === "loading" && preview === null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden />
          Finding a common directory…
        </p>
      ) : null}

      <PreviewErrors requestError={controller.requestError} errors={errors} />
    </div>
  );
}

function PreviewLocation({
  location,
  resolved,
  editable,
  controller,
}: {
  location: SharedDirectoryLocation | null;
  resolved: boolean;
  editable: boolean;
  controller: SharedDirectoryPreviewController;
}) {
  if (location === null && !editable) return null;
  const validatedMachineName =
    location !== null && controller.draftHostId.trim() === location.hostId
      ? location.hostName
      : null;
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
      <dt className="self-center text-muted-foreground">Machine</dt>
      <dd className="min-w-0">
        {editable ? (
          <div className="flex min-w-0 flex-col items-end gap-0.5">
            <input
              value={controller.draftHostId}
              onChange={(event) => controller.setDraftHostId(event.target.value)}
              aria-label="Shared directory machine ID"
              spellCheck={false}
              className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-2xs outline-none focus:border-ring"
            />
            <span className="max-w-full truncate text-2xs text-muted-foreground">
              {validatedMachineName ?? "Validate to identify this machine"}
            </span>
          </div>
        ) : (
          <span
            className="block min-w-0 truncate text-right"
            title={resolved ? `${location!.hostName} (${location!.hostId})` : location!.hostId}
          >
            {location!.hostName}
          </span>
        )}
      </dd>
      <dt className="self-center text-muted-foreground">Directory</dt>
      <dd className="min-w-0">
        {editable ? (
          <input
            value={controller.draftRootPath}
            onChange={(event) => controller.setDraftRootPath(event.target.value)}
            aria-label="Shared directory"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-2xs outline-none focus:border-ring"
          />
        ) : (
          <span
            className="block break-all text-right font-mono text-2xs"
            data-shared-directory-root=""
          >
            {location!.rootPath}
          </span>
        )}
      </dd>
    </dl>
  );
}

function ValidationPrompt({
  controller,
  editable,
  preview,
}: {
  controller: SharedDirectoryPreviewController;
  editable: boolean;
  preview: SharedDirectoryWorkspacePreview | null;
}) {
  const needsSuggestionConfirmation = preview?.suggested !== null && preview?.selection === null;
  if (!editable || (!controller.dirty && !needsSuggestionConfirmation)) return null;
  const loading = controller.status === "loading";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-2xs text-muted-foreground">
        {controller.dirty
          ? "Validate the edited directory before creating."
          : "Review and validate this directory before creating."}
      </span>
      <Button variant="outline" size="xs" disabled={loading} onClick={controller.validate}>
        <Icon
          name={loading ? "Loading" : "Check"}
          className={cn("size-3", loading && "animate-spin")}
          aria-hidden
        />
        Validate
      </Button>
    </div>
  );
}

function RepositoryPaths({
  repositories,
}: {
  repositories: readonly SharedDirectoryRepositoryPreview[];
}) {
  if (repositories.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-2xs font-medium text-muted-foreground">Selected repositories</p>
      <ul className="flex min-w-0 flex-col gap-1">
        {repositories.map((repository) => (
          <li key={repository.projectId} className="min-w-0 text-2xs">
            <span className="block truncate font-medium">{repository.name}</span>
            <span className="block break-all font-mono text-muted-foreground">
              {repository.path ?? "Checkout unavailable"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewErrors({
  requestError,
  errors,
}: {
  requestError: string | null;
  errors: readonly SharedDirectoryPreviewError[];
}) {
  if (requestError === null && errors.length === 0) return null;
  return (
    <div role="alert" className="text-xs text-destructive">
      {requestError === null ? null : <p>{requestError}</p>}
      {errors.length === 0 ? null : (
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {errors.map((error) => (
            <li key={`${error.code}:${error.projectId ?? ""}:${error.path ?? ""}:${error.message}`}>
              {error.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
