import { definePlugin } from "@bb-kit/core/plugin";
import { check } from "./command/check.ts";
import { render } from "./rpc/render.ts";
import { resetState } from "./rpc/reset-state.ts";
import { setState } from "./rpc/set-state.ts";
import { state } from "./rpc/state.ts";

export default definePlugin({
  pluginId: "canvas",
  rpc: { render, state, setState, resetState },
  command: { check },
});
