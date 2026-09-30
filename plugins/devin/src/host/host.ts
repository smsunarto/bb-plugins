import { experimental_defineProviderBridge } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge as acp } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createModelListRewriter } from "./model-order.ts";
import { createTurnSettler } from "./turn-settle.ts";

// Devin speaks ACP natively (`devin acp`), so the plugin runs it through the
// SDK's generic ACP bridge. The launch spec arrives per command in the
// provider options (src/server/lib/declaration.ts).
//
// The bridge writes its lines straight to stdout, so the plugin wraps the
// stream once at start. The model list rewriter (src/host/model-order.ts)
// reorders the answer to `model/list`; the turn settler
// (src/host/turn-settle.ts) delays a Cloud turn's end line. Everything else
// passes as written.
let writeThrough: (chunk: string) => void = () => {};
const models = createModelListRewriter();
const settler = createTurnSettler({ write: (line) => writeThrough(line) });

function wrapStdout(): void {
  const stdout = process.stdout;
  const original = stdout.write.bind(stdout);
  writeThrough = (chunk) => void original(chunk);
  stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === "string" && rest.length === 0) {
      settler.write(models.rewrite(chunk));
      return true;
    }
    return original(chunk as never, ...(rest as never[]));
  }) as typeof stdout.write;
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context) {
    wrapStdout();
    acp.start?.(context);
  },
  handleLine(line) {
    models.beforeInbound(line);
    settler.beforeInbound(line);
    acp.handleLine(line);
  },
  onClose() {
    settler.flush();
    acp.onClose?.();
  },
});
