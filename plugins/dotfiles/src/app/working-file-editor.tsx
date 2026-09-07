import { useEffect, useRef, useState, type ReactElement } from "react";
import * as pluginSdkApp from "@get-bb/plugin-sdk/app";
import type { PluginCodeThemeState } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { RepoPath } from "./route.ts";
import { rpc } from "./rpc.ts";
import {
  createMonacoBinding,
  type MonacoBinding,
  type MonacoBindingInput,
} from "./monaco/binding.ts";
import { monacoRuntime, type MonacoAcquisition } from "./monaco/runtime.ts";

export interface WorkingFileEditorProps {
  readonly path: RepoPath;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
}

type EditorStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "error"; readonly message: string };

function documentColorMode(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function useLegacyCodeTheme(): PluginCodeThemeState {
  const [mode, setMode] = useState(documentColorMode);

  useEffect(() => {
    const observer = new MutationObserver(() => setMode(documentColorMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return { mode, name: `bb-${mode}`, theme: null };
}

const useCodeTheme =
  typeof pluginSdkApp.experimental_useCodeTheme === "function"
    ? pluginSdkApp.experimental_useCodeTheme
    : useLegacyCodeTheme;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown loading error";
}

// A screenful is enough to hide the Monaco boot, and a cap keeps a long file
// from paying for DOM the editor discards a moment later.
const PLACEHOLDER_LINE_LIMIT = 200;

// Monaco arrives a few hundred milliseconds after the file does. Painting the
// text in the editor's own metrics keeps the pane from flashing empty, so the
// swap reads as syntax colour arriving rather than content arriving.
function EditorPlaceholder({ value }: { readonly value: string }): ReactElement {
  const lines = value.split("\n", PLACEHOLDER_LINE_LIMIT);
  const gutterCh = `${String(lines.length).length}ch`;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 flex overflow-hidden font-mono text-xs leading-5"
    >
      <div
        style={{ minWidth: gutterCh }}
        className="select-none whitespace-pre pl-5 pr-[42px] text-right text-muted-foreground"
      >
        {lines.map((_line, index) => `${index + 1}`).join("\n")}
      </div>
      <div className="whitespace-pre text-foreground">{lines.join("\n")}</div>
    </div>
  );
}

export function WorkingFileEditor({
  path,
  value,
  onChange,
  onSave,
}: WorkingFileEditorProps): ReactElement {
  const client = rpc.useClient();
  const codeTheme = useCodeTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);
  const assetsRef = useRef(() => client.monacoAssets());
  const inputRef = useRef<MonacoBindingInput>({ value, codeTheme, onChange, onSave });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<EditorStatus>({ kind: "loading" });
  assetsRef.current = () => client.monacoAssets();
  inputRef.current = { value, codeTheme, onChange, onSave };

  useEffect(() => {
    let disposed = false;
    let acquisition: MonacoAcquisition | null = null;
    let binding: MonacoBinding | null = null;
    setStatus({ kind: "loading" });

    void (async () => {
      try {
        const acquired = await monacoRuntime.acquire(() => assetsRef.current());
        if (disposed) {
          acquired.release();
          return;
        }
        const container = containerRef.current;
        if (container === null) {
          acquired.release();
          return;
        }
        try {
          binding = createMonacoBinding(acquired.monaco, container, path, inputRef.current);
        } catch (error) {
          acquired.release();
          throw error;
        }
        acquisition = acquired;
        bindingRef.current = binding;
        setStatus({ kind: "ready" });
      } catch (error) {
        if (!disposed) setStatus({ kind: "error", message: errorMessage(error) });
      }
    })();

    return () => {
      disposed = true;
      bindingRef.current = null;
      binding?.dispose();
      acquisition?.release();
    };
  }, [attempt, path]);

  useEffect(() => {
    bindingRef.current?.update({ value, codeTheme, onChange, onSave });
  }, [codeTheme, onChange, onSave, value]);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        className={`absolute inset-0 ${status.kind === "ready" ? "visible" : "invisible"}`}
      />
      {status.kind === "loading" && (
        <>
          <EditorPlaceholder value={value} />
          <output className="sr-only">Loading editor…</output>
        </>
      )}
      {status.kind === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-destructive">Could not load the editor. {status.message}</p>
          <Button variant="outline" onClick={() => setAttempt((current) => current + 1)}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
