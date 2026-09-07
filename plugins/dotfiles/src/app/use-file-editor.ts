import { useCallback, useEffect, useRef, useState } from "react";
import { dotfilesQueryClient } from "./query-client.ts";
import { rpc, type RPCOutput } from "./rpc.ts";
import type { RepoPath } from "./route.ts";
import { errorMessage, markRenderStale } from "./tasks.ts";

type ReadFileResult = RPCOutput<"readFile">;

export type FileEditor =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string; readonly retry: () => void }
  | ReadyFileEditor;

export interface ReadyFileEditor {
  readonly status: "ready";
  readonly content: string;
  readonly setContent: (next: string) => void;
  readonly headContent: string | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly saveError: string | null;
  readonly flush: () => void;
  readonly reload: () => void;
  readonly overwrite: () => void;
}

function commitWritten(
  path: RepoPath,
  content: string,
  result: { readonly sha256: string; readonly renderHint: boolean },
): void {
  if (result.renderHint) markRenderStale();
  const key = rpc.readFile.queryKey({ path });
  const cached = dotfilesQueryClient.getQueryData<ReadFileResult>(key);
  if (cached !== undefined) {
    dotfilesQueryClient.setQueryData<ReadFileResult>(key, {
      ...cached,
      content,
      sha256: result.sha256,
    });
  }
  void dotfilesQueryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() });
}

export function useFileEditor(path: RepoPath): FileEditor {
  // staleTime Infinity: the draft, not the cache, is live while editing.
  const file = rpc.readFile.useQuery({ path }, { staleTime: Number.POSITIVE_INFINITY });
  const client = rpc.useClient();

  const draftRef = useRef<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const shaRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const conflictRef = useRef(false);

  const [content, setContentState] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const data = file.data;
    if (data === undefined) return;
    if (shaRef.current === null) {
      draftRef.current = data.content;
      savedRef.current = data.content;
      shaRef.current = data.sha256;
      setContentState(data.content);
      return;
    }
    if (data.sha256 === shaRef.current) return;
    if (draftRef.current === savedRef.current) {
      draftRef.current = data.content;
      savedRef.current = data.content;
      shaRef.current = data.sha256;
      setContentState(data.content);
    } else {
      conflictRef.current = true;
      setConflict(true);
    }
  }, [file.data]);

  const save = useCallback(
    async (force = false): Promise<void> => {
      if (savingRef.current) return;
      if (conflictRef.current && !force) return;
      if (draftRef.current === null || shaRef.current === null) return;
      if (draftRef.current === savedRef.current && !force) return;
      savingRef.current = true;
      setSaving(true);
      try {
        let unconditional = force;
        for (;;) {
          const submitted: string | null = draftRef.current;
          if (submitted === null) return;
          const result = await client.saveFile({
            path,
            content: submitted,
            ...(unconditional ? {} : { expectedSha256: shaRef.current }),
          });
          if (result.outcome === "conflict") {
            conflictRef.current = true;
            setConflict(true);
            return;
          }
          savedRef.current = submitted;
          shaRef.current = result.sha256;
          conflictRef.current = false;
          setConflict(false);
          setSaveError(null);
          commitWritten(path, submitted, result);
          if (draftRef.current === submitted) return;
          unconditional = false;
        }
      } catch (error) {
        setSaveError(errorMessage(error));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [client, path],
  );

  useEffect(() => {
    return () => {
      if (savingRef.current || conflictRef.current) return;
      const draft = draftRef.current;
      const sha = shaRef.current;
      if (draft === null || sha === null || draft === savedRef.current) return;
      const flushOnUnmount = async (): Promise<void> => {
        const result = await client.saveFile({ path, content: draft, expectedSha256: sha });
        if (result.outcome === "written") commitWritten(path, draft, result);
      };
      void flushOnUnmount().catch(() => {});
    };
  }, [client, path]);

  if (file.isError) {
    return {
      status: "error",
      message: errorMessage(file.error),
      retry: () => void file.refetch(),
    };
  }
  if (content === null) {
    return { status: "loading" };
  }
  return {
    status: "ready",
    content,
    setContent(next) {
      draftRef.current = next;
      setContentState(next);
    },
    headContent: file.data?.headContent ?? null,
    dirty: draftRef.current !== savedRef.current,
    saving,
    conflict,
    saveError,
    flush() {
      void save();
    },
    reload() {
      const saved = savedRef.current;
      if (saved !== null) {
        draftRef.current = saved;
        setContentState(saved);
      }
      conflictRef.current = false;
      setConflict(false);
      setSaveError(null);
      void file.refetch();
    },
    overwrite() {
      void save(true);
    },
  };
}
