import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { narrowSource } from "../shared/source.ts";
import type { CanvasSource, HostLookup } from "../shared/source.ts";
import { buttonClass } from "./components.tsx";
import { MarkdownEditor } from "./markdown-editor.tsx";
import { rpc } from "./rpc.ts";

const pollIntervalMs = 1500;
const saveDelayMs = 700;
// An external write remounts the editor, which loads images and embeds again.
// A lease this close to expiry is renewed first.
const leaseRenewMs = 5 * 60 * 1000;

type Opened =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | {
      readonly status: "ready";
      readonly content: string;
      readonly previewBaseUrl: string;
      readonly previewPath: string;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EditorSession(props: { readonly source: CanvasSource }): ReactElement {
  // The opener keys each session by its source, so the first one is final.
  const [source] = useState(props.source);
  const client = rpc.useClient();
  const [opened, setOpened] = useState<Opened>({ status: "loading" });
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  // The editor's latest Markdown, the last content known to be on disk, and
  // that content's hash. Saves are compare-and-swap against the hash.
  const markdownRef = useRef("");
  const savedRef = useRef("");
  const shaRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const leaseExpiresRef = useRef(0);

  useEffect(() => {
    let active = true;
    // Reload discards the draft, so its pending autosave must not land.
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpened({ status: "loading" });
    setConflict(false);
    setSaveError(null);
    void (async () => {
      try {
        const [file, preview] = await Promise.all([
          client.file({ source, knownSha256: null }),
          client.preview({ source }),
        ]);
        if (!active) return;
        if (file.status !== "read") {
          setOpened({
            status: "failed",
            message: file.status === "unreadable" ? file.detail : "The file did not load.",
          });
          return;
        }
        markdownRef.current = file.content;
        savedRef.current = file.content;
        shaRef.current = file.sha256;
        leaseExpiresRef.current = preview.expiresAtMs;
        setOpened({
          status: "ready",
          content: file.content,
          previewBaseUrl: preview.baseUrl,
          previewPath: preview.path,
        });
      } catch (error) {
        if (active) setOpened({ status: "failed", message: messageOf(error) });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, source, reloadNonce]);

  const ready = opened.status === "ready";
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let pending = false;
    const timer = setInterval(async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const knownSha256 = shaRef.current;
      try {
        const file = await client.file({ source, knownSha256 });
        if (file.status !== "read") return;
        const lease =
          leaseExpiresRef.current - Date.now() < leaseRenewMs
            ? await client.preview({ source }).catch(() => null)
            : null;
        if (!active || shaRef.current !== knownSha256) return;
        // An external write only replaces a clean document. A pending draft
        // keeps its edits and asks the user to reload or overwrite.
        if (savingRef.current || markdownRef.current !== savedRef.current) {
          setConflict(true);
          return;
        }
        markdownRef.current = file.content;
        savedRef.current = file.content;
        shaRef.current = file.sha256;
        if (lease !== null) leaseExpiresRef.current = lease.expiresAtMs;
        const renewed =
          lease === null ? {} : { previewBaseUrl: lease.baseUrl, previewPath: lease.path };
        setOpened((previous) =>
          previous.status === "ready"
            ? { ...previous, ...renewed, content: file.content }
            : previous,
        );
      } catch {
        // Keep the editable document during a temporary host disconnect. The
        // next read retries, and a write still reports conflicts or failures.
      } finally {
        pending = false;
      }
    }, pollIntervalMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, source, ready]);

  const save = useCallback(
    async (force = false) => {
      if (savingRef.current) return;
      savingRef.current = true;
      try {
        // Edits made while a write is in flight have already spent their
        // debounce, so keep writing until the editor and disk agree.
        while (force || markdownRef.current !== savedRef.current) {
          const content = markdownRef.current;
          const expectedSha256 = force ? null : shaRef.current;
          force = false;
          setSaveError(null);
          const result = await client.save({
            source,
            content,
            ...(expectedSha256 === null ? {} : { expectedSha256 }),
          });
          if (result.outcome === "conflict") {
            setConflict(true);
            return;
          }
          savedRef.current = content;
          shaRef.current = result.sha256;
          setConflict(false);
        }
      } catch (error) {
        setSaveError(messageOf(error));
      } finally {
        savingRef.current = false;
      }
    },
    [client, source],
  );

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), saveDelayMs);
  }, [save]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      void save();
    },
    [save],
  );

  if (opened.status === "loading") return loadingView();
  if (opened.status === "failed") {
    return (
      <div className="m-3 rounded-md border border-border px-3 py-2 text-sm">
        <p className="m-0 font-medium text-foreground">The file could not be opened.</p>
        <p className="m-0 mt-1 text-muted-foreground">{opened.message}</p>
        <button
          type="button"
          className={`mt-2 ${buttonClass}`}
          onClick={() => setReloadNonce((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {conflict ? (
        <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-xs">
          Changed on disk.
          <button
            type="button"
            className={buttonClass}
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            Reload
          </button>
          <button type="button" className={buttonClass} onClick={() => void save(true)}>
            Overwrite
          </button>
        </div>
      ) : null}
      {saveError ? (
        <div role="alert" className="border-b border-border px-4 py-2 text-xs text-destructive">
          {saveError}
        </div>
      ) : null}
      <MarkdownEditor
        initialValue={opened.content}
        previewBaseUrl={opened.previewBaseUrl}
        notePath={opened.previewPath}
        canvasSource={source}
        onFirstRender={(markdown) => {
          markdownRef.current = markdown;
          savedRef.current = markdown;
        }}
        onProposalApplied={({ content, sha256 }) => {
          if (timerRef.current) clearTimeout(timerRef.current);
          markdownRef.current = content;
          savedRef.current = content;
          shaRef.current = sha256;
          setOpened((previous) =>
            previous.status === "ready" ? { ...previous, content } : previous,
          );
        }}
        onMarkdownChange={(markdown) => {
          markdownRef.current = markdown;
          scheduleSave();
        }}
      />
    </div>
  );
}

function loadingView(): ReactElement {
  return <p className="px-3 py-2 text-sm text-muted-foreground">Loading</p>;
}

// Every read, save, and preview needs the file's host. The environment's host
// is a database read, so it resolves even while that host is offline, and the
// read then reports the outage with a Retry.
function HostLookupSession(props: {
  readonly lookup: HostLookup;
  readonly Original: PluginFileOpenerProps["Original"];
}): ReactElement {
  // The opener keys each lookup by its owner and path, so the first one is final.
  const [lookup] = useState(props.lookup);
  const { Original } = props;
  const sdk = useSdk();
  const [hostId, setHostId] = useState<string | null | "failed">(null);
  useEffect(() => {
    let active = true;
    const { environmentId, threadId } = lookup.owner;
    const found =
      environmentId !== null
        ? sdk.environments.get({ environmentId })
        : sdk.threads.storageLocation({ threadId });
    found.then(
      (owner) => active && setHostId(owner.hostId),
      () => active && setHostId("failed"),
    );
    return () => {
      active = false;
    };
  }, [sdk, lookup]);
  if (hostId === "failed") return <Original />;
  if (hostId === null) return loadingView();
  const source: CanvasSource = { kind: "host", hostId, path: lookup.path };
  return <EditorSession key={JSON.stringify(source)} source={source} />;
}

// Opens .mdx and .canvas.mdx files in the MDX editor. A file Canvas cannot
// address (a project file without an environment) keeps bb's own preview.
export function MdxOpener({ path, source, Original }: PluginFileOpenerProps): ReactElement {
  const narrowed = narrowSource(source, path);
  if (!narrowed.ok) return <Original />;
  const { value } = narrowed;
  if (value.kind === "host-lookup") {
    return <HostLookupSession key={JSON.stringify(value)} lookup={value} Original={Original} />;
  }
  return <EditorSession key={JSON.stringify(value)} source={value} />;
}
