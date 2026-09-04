import { definePlugin } from "@bb-kit/core/plugin";
import { check } from "./command/check.ts";
import { render } from "./rpc/render.ts";
import { resetState } from "./rpc/reset-state.ts";
import { setState } from "./rpc/set-state.ts";
import { source } from "./rpc/source.ts";
import { state } from "./rpc/state.ts";

export default definePlugin({
  pluginId: "canvas",
  rpc: { render, source, state, setState, resetState },
  command: { check },
});
