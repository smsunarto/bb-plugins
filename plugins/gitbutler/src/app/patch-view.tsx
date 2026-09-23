import { useMemo } from "react";
import { experimental_useCodeTheme as useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getSingularPatch } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { PatchSource } from "../shared/schema.ts";
import { Loading, Notice, errorText } from "./notice.tsx";
import { rpc, defined } from "./rpc.ts";

const REFRESH_INTERVAL_MS = 10_000;

/*
 * Pierre draws its header inside a shadow root, where the plugin stylesheet
 * cannot reach it. `unsafeCSS` is its supported hook. The 12px change icon
 * matches the 11px header text the panel asks for in gitbutler.css.
 */
const DIFF_CSS = "[data-change-icon]{width:12px;height:12px}";

/**
 * One file's diff, rendered by Pierre against bb's current code theme. The
 * host hands over a complete git patch (see `patchFor`), which is what lets
 * Pierre name the file and pick a highlighter for it.
 */
export function PatchView({
  threadId,
  repositoryKey,
  source,
  path,
}: {
  threadId: string;
  repositoryKey: string | undefined;
  source: PatchSource;
  path: string;
}) {
  const { mode, name } = useCodeTheme();
  const patch = rpc.patch.useQuery(defined({ threadId, repositoryKey, source, path }), {
    staleTime: REFRESH_INTERVAL_MS,
  });

  const text = patch.data?.patch ?? "";
  const fileDiff = useMemo(() => {
    if (text === "") return null;
    try {
      return getSingularPatch(text);
    } catch {
      return null;
    }
  }, [text]);

  const options = useMemo(
    () => ({
      collapsed: false,
      // A thread panel is a column, not a page. Split view halves an already
      // narrow column, so the panel always reads unified.
      diffStyle: "unified" as const,
      stickyHeader: false,
      theme: name,
      themeType: mode,
      unsafeCSS: DIFF_CSS,
    }),
    [mode, name],
  );

  if (patch.isPending) return <Loading label="Loading diff…" />;
  if (patch.isError) return <Notice title="Diff failed to load" detail={errorText(patch.error)} />;
  if (text === "") {
    return <Notice title="No text diff" detail="This file is binary, empty, or unchanged." />;
  }
  if (!fileDiff) {
    return <Notice title="Diff could not be parsed" detail={`GitButler returned ${path}.`} />;
  }

  return (
    <div className="gb-diff mt-2.5 overflow-hidden rounded-md border border-border">
      {patch.data.truncated ? (
        <p className="border-b border-border px-2 py-1 text-warning">
          Diff truncated to keep the panel responsive.
        </p>
      ) : null}
      <FileDiff disableWorkerPool fileDiff={fileDiff} options={options} />
    </div>
  );
}
