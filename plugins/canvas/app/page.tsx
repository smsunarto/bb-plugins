import { useMemo } from "react";
import type { ReactElement } from "react";
import { experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { stateKeyOf } from "../shared/source.ts";
import { CanvasView } from "./canvas.tsx";
import { decodeCanvasSubPath } from "./route.ts";
import { rpc } from "./rpc.ts";
import { useCanvas } from "./state.tsx";

// The page has no host preview to fall back on, so its source view reads the
// raw text through the plugin's own rpc.
function PageSource(): ReactElement {
  const canvas = useCanvas();
  const query = rpc.source.useQuery({ source: canvas.source }, { staleTime: 0 });
  const data = query.data;
  if (data === undefined) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">
        {query.error === null ? "Loading source" : query.error.message}
      </p>
    );
  }
  if (data.status === "unreadable") {
    return <p className="px-3 py-2 text-sm text-muted-foreground">{data.detail}</p>;
  }
  return <SourceCode content={data.content} path={canvas.path} className="h-full" />;
}

export function CanvasPage(props: PluginNavPanelProps): ReactElement {
  const source = useMemo(() => decodeCanvasSubPath(props.subPath), [props.subPath]);
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {source === null ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Open a canvas link from a chat. It renders here in its own pane.
        </div>
      ) : (
        <CanvasView
          key={stateKeyOf(source)}
          source={source}
          path={source.path}
          Original={PageSource}
        />
      )}
    </div>
  );
}
