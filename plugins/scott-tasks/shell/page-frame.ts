import type { PluginContentScriptContext } from "@get-bb/plugin-sdk/app";

// BB's inset and Monokai's web frame are outside the navPanel slot.
// Bounded split panes have data-focused. Leave their shared frame intact.
const TASKS_PAGE = "[data-scott-tasks-page]";
const FOCUSED_SPLIT = "[data-split-pane-id][data-focused]";
const INSET = `:has(${TASKS_PAGE}):not(:has(${FOCUSED_SPLIT}))[data-sidebar="inset"]`;

export function mountTasksPageFrame({ signal }: Pick<PluginContentScriptContext, "signal">) {
  if (signal.aborted) return;
  const style = document.createElement("style");
  style.setAttribute("data-scott-tasks-frame-style", "");
  style.textContent = `
    @media (min-width: 768px) {
      :not([data-framed]):has(> [data-sidebar="inset"] ${TASKS_PAGE}):not(:has(> [data-sidebar="inset"] ${FOCUSED_SPLIT}))[data-testid="app-layout-root"] {
        padding: 0;
      }
      ${INSET} {
        --bb-frame-card-radius: 0px;
        border-radius: 0;
        mask-image: none;
        clip-path: none;
      }
      ${INSET} > [data-app-content-shell]::after {
        display: none;
      }
      ${INSET} > [data-sidebar="inset-edge"] {
        display: none;
      }
    }
  `;
  const dispose = () => {
    style.remove();
    signal.removeEventListener("abort", dispose);
  };
  document.head.append(style);
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
