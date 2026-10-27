import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import { createElement, useState } from "react";
import type { AgentationProps } from "../vendor/agentation/dist/index.mjs";
import { FEEDBACK_MODE_LABEL, feedbackModeLauncher } from "../lib/feedback-mode.ts";

installDom();
const { render, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const { Agentation } = await import("../vendor/agentation/dist/index.mjs");
afterEach(cleanup);

test("a host launcher controls feedback mode and Escape hides the floating launcher", async () => {
  function ControlledToolbar() {
    const [active, setActive] = useState(false);
    return createElement(
      "div",
      null,
      createElement(
        "button",
        { "aria-label": FEEDBACK_MODE_LABEL, onClick: () => setActive(!active) },
        "Footer launcher",
      ),
      createElement<AgentationProps>(Agentation, {
        active,
        onActiveChange: setActive,
        hideLauncher: true,
        getLauncherElement: feedbackModeLauncher,
      }),
    );
  }
  const view = render(createElement(ControlledToolbar));
  const toolbar = () =>
    document
      .querySelector("agentation-toolbar")
      ?.shadowRoot?.querySelector<HTMLElement>("[data-agentation-toolbar]");
  await waitFor(() => expect(toolbar()?.style.display).toBe("none"));

  // The footer has not been used yet: the keyboard shortcut must still leave
  // that control exempt from annotation targeting on its very first click.
  fireEvent.keyDown(document, { key: "F", shiftKey: true, ctrlKey: true });
  await waitFor(() => expect(toolbar()?.style.display).not.toBe("none"));
  fireEvent.click(view.getByText("Footer launcher"));
  await waitFor(() => expect(toolbar()?.style.display).toBe("none"));

  fireEvent.click(view.getByText("Footer launcher"));
  await waitFor(() => expect(toolbar()?.style.display).not.toBe("none"));

  const exit = document
    .querySelector("agentation-toolbar")
    ?.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Exit"]');
  exit?.focus();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(toolbar()?.style.display).toBe("none"));
  expect(document.activeElement).toBe(view.getByText("Footer launcher"));

  fireEvent.click(view.getByText("Footer launcher"));
  await waitFor(() => expect(toolbar()?.style.display).not.toBe("none"));
  fireEvent.click(view.getByText("Footer launcher"));
  await waitFor(() => expect(toolbar()?.style.display).toBe("none"));
});

test("an initially active toolbar focuses its controls after mounting", async () => {
  render(createElement<AgentationProps>(Agentation, { active: true, hideLauncher: true }));
  await waitFor(() =>
    expect(
      document.querySelector("agentation-toolbar")?.shadowRoot?.activeElement?.getAttribute("aria-label"),
    ).toBe("Pause animations"),
  );
});
