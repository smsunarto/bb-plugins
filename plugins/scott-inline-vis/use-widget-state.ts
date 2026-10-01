import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_STATE_BYTES,
  type stateContract,
  type WidgetIdentity,
  type WidgetStateSnapshot,
} from "./state-contract.ts";
import { TWEAK_LIMITS, type TweakGroup } from "./tweak-contract.ts";

// A collapsed preview unmounts. Its queued writes must finish before a new
// instance restores the same widget, otherwise initial controls overwrite edits.
const pendingWrites = new Map<string, Promise<WidgetStateSnapshot>>();

function hasSavedContext(snapshot: WidgetStateSnapshot) {
  if (snapshot.hasWidgetState === true) return true;
  const tweaks: unknown = JSON.parse(snapshot.tweaks ?? "[]");
  return Array.isArray(tweaks) && tweaks.length > 0;
}

async function waitForWrites(key: string) {
  let result: WidgetStateSnapshot | undefined;
  while (pendingWrites.has(key)) result = await pendingWrites.get(key);
  return result;
}

function mergeTweaks(savedTweaks: string | null, groups: TweakGroup[], reset?: string | null) {
  const entries = savedTweaks ? JSON.parse(savedTweaks) : [];
  const retained = Array.isArray(entries)
    ? entries.filter(
        (entry) =>
          entry &&
          typeof entry.groupId === "string" &&
          typeof entry.controlId === "string" &&
          reset !== null &&
          entry.groupId !== reset,
      )
    : [];
  const merged = new Map<string, Record<string, unknown>>(
    retained.map((entry) => [JSON.stringify([entry.groupId, entry.controlId]), entry]),
  );
  for (const { group, control } of groups.flatMap((group) =>
    group.controls.map((control) => ({ group, control })),
  )) {
    const controlKey = JSON.stringify([group.id, control.id]);
    // Originals come from the artifact. Only user adjustments need restoring.
    // Reinsert active controls last so retention favors the current frame.
    merged.delete(controlKey);
    if (control.value === control.initialValue) continue;
    merged.set(controlKey, {
      groupId: group.id,
      groupTitle: group.title,
      variant: group.variant,
      controlId: control.id,
      label: control.label,
      type: control.type,
      value: control.value,
      initialValue: control.initialValue,
      ...(control.reference ? { reference: control.reference } : {}),
      ...(control.type === "slider" && control.unit ? { unit: control.unit } : {}),
    });
  }
  return JSON.stringify([...merged.values()].slice(-TWEAK_LIMITS.groups * TWEAK_LIMITS.controls));
}

export function useWidgetState(identity: WidgetIdentity, pluginId: string) {
  const { threadId, messageId, file } = identity;
  const key = JSON.stringify([pluginId, threadId, messageId, file]);
  const legacyKey = `${pluginId}.widget-state:${threadId}:${messageId}:${file}`;
  const rpc = useRpc<typeof stateContract>();
  const composer = useComposer();
  const composerRef = useRef(composer);
  useLayoutEffect(() => {
    composerRef.current = composer;
  }, [composer]);
  const saved = useRef({
    state: "null",
    modelContent: null as string | null,
    tweaks: null as string | null,
  });
  const mentionId = useRef<string | null>(null);
  const readOnly = useRef(false);
  const dirty = useRef(new Set<"state" | "tweaks">());
  const [readError, setReadError] = useState<string | null>(null);
  const [hasSavedState, setHasSavedState] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const writeCount = useRef(0);
  const failedWrites = useRef(new Map<"state" | "tweaks" | "context", string>());

  const persist = useCallback(
    (fields: ("state" | "tweaks")[] = [], ifMissing = false, invalidate = true) => {
      if (readOnly.current)
        return Promise.reject(new Error("Saved state is unavailable. Retry loading it first."));
      const input = {
        threadId,
        messageId,
        file,
        ...(ifMissing
          ? saved.current
          : {
              ...(fields.includes("state")
                ? { state: saved.current.state, modelContent: saved.current.modelContent }
                : {}),
              ...(fields.includes("tweaks") ? { tweaks: saved.current.tweaks } : {}),
            }),
      };
      const attempts = fields.length ? fields : (["context"] as const);
      // An edit invalidates an attached context chip until the user adds the
      // current selection again. Inserting automatically would steal panel focus.
      if (invalidate && mentionId.current)
        composerRef.current.experimental_removeMention({
          provider: "widget-state",
          id: mentionId.current,
        });
      writeCount.current++;
      setSaving(true);
      const write = (pendingWrites.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() => {
          if (input.tweaks && new TextEncoder().encode(input.tweaks).length > MAX_STATE_BYTES)
            throw new Error(
              "Tweak changes exceed 16 KiB. Reduce or reset adjustments before saving.",
            );
          return rpc.call("saveState", { ...input, fields, ...(ifMissing ? { ifMissing } : {}) });
        });
      pendingWrites.set(key, write);
      void write
        .then(
          (snapshot) => {
            for (const field of fields) {
              if (
                field === "state"
                  ? saved.current.state === input.state &&
                    saved.current.modelContent === input.modelContent
                  : saved.current.tweaks === input.tweaks
              )
                dirty.current.delete(field);
            }
            mentionId.current = snapshot.mentionId;
            setHasSavedState(hasSavedContext(snapshot) || dirty.current.size > 0);
            for (const field of attempts) failedWrites.current.delete(field);
            failedWrites.current.delete("context");
            setSaveError([...failedWrites.current.values()].at(-1) ?? null);
            return snapshot;
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            for (const field of attempts) failedWrites.current.set(field, message);
            setSaveError(message);
            return null;
          },
        )
        .finally(() => {
          if (pendingWrites.get(key) === write) pendingWrites.delete(key);
          writeCount.current--;
          if (!writeCount.current) setSaving(false);
        });
      return write;
    },
    [rpc, key, threadId, messageId, file],
  );

  const restore = useCallback(
    async (signal: AbortSignal) => {
      await waitForWrites(key).catch(() => {});
      signal.throwIfAborted();
      let legacy: string | null = null;
      try {
        legacy = window.localStorage.getItem(legacyKey);
        if (legacy !== null) JSON.parse(legacy);
      } catch {
        legacy = null;
      }
      let snapshot: WidgetStateSnapshot | null;
      try {
        snapshot = await rpc.call("readState", { threadId, messageId, file });
      } catch (error) {
        signal.throwIfAborted();
        // A known legacy snapshot still needs migration before author code runs.
        if (legacy !== null) throw error;
        readOnly.current = true;
        setReadError(error instanceof Error ? error.message : String(error));
        setHasSavedState(false);
        return { state: "null", modelContent: null, tweaks: null };
      }
      signal.throwIfAborted();
      readOnly.current = false;
      setReadError(null);
      if ((!snapshot || snapshot.hasWidgetState === false) && legacy !== null) {
        saved.current = { state: legacy, modelContent: null, tweaks: snapshot?.tweaks ?? null };
        // If migration fails, do not start a fresh frame that could replace it.
        snapshot = await persist([], true, false);
      }
      if (snapshot?.hasWidgetState && legacy !== null) {
        try {
          window.localStorage.removeItem(legacyKey);
        } catch {
          /* Server owns the successfully read or migrated snapshot. */
        }
      }
      saved.current = snapshot
        ? { state: snapshot.state, modelContent: snapshot.modelContent, tweaks: snapshot.tweaks }
        : { state: "null", modelContent: null, tweaks: null };
      mentionId.current = snapshot?.mentionId ?? null;
      setHasSavedState(snapshot !== null && hasSavedContext(snapshot));
      return saved.current;
    },
    [rpc, key, threadId, messageId, file, legacyKey, persist],
  );

  const addContext = useCallback(
    async (prompt?: string, beforeFocus?: () => void) => {
      // A storage outage must not swallow an explicit follow-up request.
      if (prompt) {
        beforeFocus?.();
        composerRef.current.updateText((current) =>
          current.trim() ? `${current.trimEnd()}\n\n${prompt}` : prompt,
        );
        composerRef.current.focus();
      }
      try {
        if (!hasSavedState && !dirty.current.size) return;
        const result = await persist([...dirty.current]);
        const snapshot = (await waitForWrites(key)) ?? result;
        if (!prompt) beforeFocus?.();
        composerRef.current.experimental_removeMention({
          provider: "widget-state",
          id: snapshot.mentionId,
        });
        composerRef.current.insertMention({
          provider: "widget-state",
          id: snapshot.mentionId,
          label: `State: ${file.split(/[\\/]/u).pop() ?? file}`,
        });
        composerRef.current.focus();
      } catch {
        /* The visible save error leaves the draft free of stale context. */
      }
    },
    [persist, key, file, hasSavedState],
  );

  const updateState = useCallback(
    (state: string, modelContent: string | null) => {
      if (readOnly.current) return;
      if (
        hasSavedState &&
        saved.current.state === state &&
        saved.current.modelContent === modelContent
      )
        return;
      saved.current.state = state;
      saved.current.modelContent = modelContent;
      setHasSavedState(true);
      dirty.current.add("state");
      void persist(["state"]).catch(() => {});
    },
    [persist, hasSavedState],
  );
  const updateTweaks = useCallback(
    (groups: TweakGroup[], changed: boolean, reset?: string | null) => {
      if (readOnly.current || (groups.length === 0 && reset === undefined)) return;
      // Registration can happen after fetch/import or only when a tab opens.
      // Preserve saved controls that have not registered in this frame yet.
      const next = mergeTweaks(saved.current.tweaks, groups, reset);
      if (saved.current.tweaks === next || (saved.current.tweaks === null && next === "[]")) return;
      saved.current.tweaks = next;
      dirty.current.add("tweaks");
      void persist(["tweaks"], false, changed).catch(() => {});
    },
    [persist],
  );

  return {
    hasSavedState,
    saving,
    saveError,
    readError,
    restore,
    addContext,
    updateState,
    updateTweaks,
  };
}
