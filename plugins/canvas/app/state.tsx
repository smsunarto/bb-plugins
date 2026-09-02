import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import type { CanvasState, JsonValue } from "../shared/document.ts";
import { fileNameOf, stateChannel, stateKeyOf } from "../shared/source.ts";
import type { CanvasSource, StateSignal } from "../shared/source.ts";
import { rpc } from "./rpc.ts";

export type CanvasViewMode = "canvas" | "source";

export interface CanvasContextValue {
  readonly source: CanvasSource;
  readonly path: string;
  readonly fileName: string;
  readonly target: ExperimentalLiveFileTarget | null;
  readonly view: CanvasViewMode;
  readonly setView: (view: CanvasViewMode) => void;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function targetOf(source: CanvasSource, path: string): ExperimentalLiveFileTarget | null {
  switch (source.kind) {
    case "workspace":
      return { kind: "workspace", environmentId: source.environmentId, path };
    case "thread-storage":
      return { kind: "thread-storage", threadId: source.threadId, path };
    case "host":
      return source.hostId === null ? null : { kind: "host", hostId: source.hostId, path };
  }
}

export function CanvasProvider(props: {
  readonly source: CanvasSource;
  readonly path: string;
  readonly children: ReactNode;
}): ReactElement {
  const { source, path } = props;
  const [view, setView] = useState<CanvasViewMode>("canvas");
  const value = useMemo<CanvasContextValue>(
    () => ({
      source,
      path,
      fileName: fileNameOf(path),
      target: targetOf(source, path),
      view,
      setView,
    }),
    [source, path, view],
  );
  return <CanvasContext.Provider value={value}>{props.children}</CanvasContext.Provider>;
}

export function useCanvas(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (value === null) throw new Error("useCanvas must run inside CanvasProvider");
  return value;
}

export interface CanvasStateValue {
  readonly values: Readonly<Record<string, JsonValue>>;
  readonly loaded: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  set(key: string, value: JsonValue): void;
  reset(): void;
  retry(): void;
}

const StateContext = createContext<CanvasStateValue | null>(null);

function isSignal(payload: unknown): payload is StateSignal {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { stateKey?: unknown }).stateKey === "string" &&
    typeof (payload as { revision?: unknown }).revision === "number"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CanvasStateProvider(props: { readonly children: ReactNode }): ReactElement {
  const { source } = useCanvas();
  const queryClient = useQueryClient();
  const stateKey = stateKeyOf(source);
  const queryKey = rpc.state.queryKey({ source });
  const query = rpc.state.useQuery({ source }, { staleTime: Number.POSITIVE_INFINITY });
  const [local, setLocal] = useState<Readonly<Record<string, JsonValue>>>({});
  const [failed, setFailed] = useState<{ key: string; value: JsonValue; message: string } | null>(
    null,
  );
  const revision = useRef(0);
  revision.current = query.data?.revision ?? 0;

  const applyState = useCallback(
    (state: CanvasState) => {
      queryClient.setQueryData(queryKey, state);
    },
    [queryClient, queryKey],
  );

  const mutation = rpc.setState.useMutation({
    onSuccess(data, variables) {
      applyState(data);
      setLocal((current) => {
        if (JSON.stringify(current[variables.key]) !== JSON.stringify(variables.value)) {
          return current;
        }
        const { [variables.key]: _dropped, ...rest } = current;
        return rest;
      });
    },
    onError(error, variables) {
      setFailed({ key: variables.key, value: variables.value, message: errorMessage(error) });
    },
  });
  const resetMutation = rpc.resetState.useMutation({
    onSuccess(data) {
      applyState(data);
      setLocal({});
      setFailed(null);
    },
    onError(error) {
      setFailed({ key: "", value: null, message: errorMessage(error) });
    },
  });

  useRealtime(stateChannel, (payload) => {
    if (!isSignal(payload) || payload.stateKey !== stateKey) return;
    if (payload.revision === revision.current) return;
    void queryClient.invalidateQueries({ queryKey });
  });

  const { mutate } = mutation;
  const { mutate: mutateReset } = resetMutation;
  const set = useCallback(
    (key: string, value: JsonValue) => {
      setLocal((current) => ({ ...current, [key]: value }));
      setFailed(null);
      mutate({ source, key, value });
    },
    [mutate, source],
  );
  const reset = useCallback(() => {
    mutateReset({ source });
  }, [mutateReset, source]);
  const retry = useCallback(() => {
    if (failed === null) return;
    if (failed.key === "") {
      mutateReset({ source });
      return;
    }
    setFailed(null);
    mutate({ source, key: failed.key, value: failed.value });
  }, [failed, mutate, mutateReset, source]);

  const values = useMemo(() => ({ ...query.data?.values, ...local }), [query.data, local]);
  const value = useMemo<CanvasStateValue>(
    () => ({
      values,
      loaded: query.data !== undefined,
      pending: mutation.isPending || resetMutation.isPending,
      error: failed?.message ?? (query.error === null ? null : errorMessage(query.error)),
      set,
      reset,
      retry,
    }),
    [
      values,
      query.data,
      query.error,
      mutation.isPending,
      resetMutation.isPending,
      failed,
      set,
      reset,
      retry,
    ],
  );
  return <StateContext.Provider value={value}>{props.children}</StateContext.Provider>;
}

export function useCanvasState(): CanvasStateValue {
  const value = useContext(StateContext);
  if (value === null) throw new Error("useCanvasState must run inside CanvasStateProvider");
  return value;
}
