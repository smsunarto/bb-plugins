// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test } from "vitest";
import { resetEscapeLayers, useEscapeLayer, useFocusContainment } from "./escape.ts";

afterEach(() => {
  cleanup();
  resetEscapeLayers();
  document.body.innerHTML = "";
});

function Layer({
  name,
  modal = false,
  contain = false,
  children,
}: {
  name: string;
  modal?: boolean;
  contain?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  useEscapeLayer(scope, () => setOpen(false), { open, modal });
  useFocusContainment(scope, open && contain);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open {name}
      </button>
      {open ? (
        <div ref={scope} data-testid={name}>
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- a dialog takes focus as it opens */}
          <button type="button" autoFocus>
            In {name}
          </button>
          <button type="button">Last in {name}</button>
          {children}
        </div>
      ) : null}
    </>
  );
}

/** Escape on whatever has focus, as a reader presses it; false when something claimed it. */
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

test("a modal layer claims Escape wherever focus is", () => {
  const view = render(
    <>
      <Layer name="dialog" modal />
      <button type="button">Elsewhere</button>
    </>,
  );
  const opener = view.getByText("Open dialog");
  opener.focus();
  fireEvent.click(opener);
  expect(document.activeElement?.textContent).toBe("In dialog");
  view.getByText("Elsewhere").focus();
  expect(escape()).toBe(false);
  expect(view.queryByTestId("dialog")).toBeNull();
  // Escape with nothing open is bb's again.
  expect(escape()).toBe(true);
});

test("a confirm row or menu claims Escape only while focus is inside it, and focus returns to its opener", async () => {
  const view = render(
    <>
      <Layer name="row" />
      <button type="button">Elsewhere</button>
    </>,
  );
  const opener = view.getByText("Open row");
  opener.focus();
  fireEvent.click(opener);
  view.getByText("Elsewhere").focus();
  expect(escape()).toBe(true);
  expect(view.getByTestId("row")).toBeTruthy();
  view.getByText("In row").focus();
  expect(escape()).toBe(false);
  expect(view.queryByTestId("row")).toBeNull();
  await act(async () => {});
  expect(document.activeElement).toBe(opener);
});

test("the innermost layer closes first", () => {
  const view = render(
    <Layer name="outer" modal>
      <Layer name="inner" />
    </Layer>,
  );
  fireEvent.click(view.getByText("Open outer"));
  const inner = view.getByText("Open inner");
  inner.focus();
  fireEvent.click(inner);
  expect(escape()).toBe(false);
  expect(view.queryByTestId("inner")).toBeNull();
  expect(view.getByTestId("outer")).toBeTruthy();
  expect(escape()).toBe(false);
  expect(view.queryByTestId("outer")).toBeNull();
});

test("an open picker of bb's own gets Escape first", () => {
  const view = render(<Layer name="dialog" modal />);
  fireEvent.click(view.getByText("Open dialog"));
  const picker = document.createElement("div");
  picker.setAttribute("data-radix-popper-content-wrapper", "");
  document.body.append(picker);
  expect(escape()).toBe(true);
  expect(view.getByTestId("dialog")).toBeTruthy();
  picker.remove();
  // A tooltip of bb's does not hold Escape back.
  const tooltip = document.createElement("div");
  tooltip.setAttribute("data-radix-popper-content-wrapper", "");
  tooltip.innerHTML = '<span role="tooltip">Model</span>';
  document.body.append(tooltip);
  expect(escape()).toBe(false);
  expect(view.queryByTestId("dialog")).toBeNull();
});

test("a contained dialog keeps Tab inside, except for bb's portaled pickers", () => {
  const view = render(
    <>
      <Layer name="dialog" modal contain />
      <button type="button">Behind</button>
    </>,
  );
  fireEvent.click(view.getByText("Open dialog"));
  act(() => view.getByText("Behind").focus());
  expect(document.activeElement?.textContent).toBe("In dialog");
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  act(() => view.getByText("Behind").focus());
  expect(document.activeElement?.textContent).toBe("Last in dialog");
  const picker = document.createElement("div");
  picker.setAttribute("data-radix-popper-content-wrapper", "");
  const option = document.createElement("button");
  picker.append(option);
  document.body.append(picker);
  act(() => option.focus());
  expect(document.activeElement).toBe(option);
});

function Row() {
  const [asking, setAsking] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  useEscapeLayer(scope, () => setAsking(false), { open: asking });
  return (
    <div data-bb-plugin="source-control">
      {asking ? (
        <div ref={scope}>
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- a confirm row takes focus as it opens */}
          <button type="button" autoFocus>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" aria-label="Delete scott/a" onClick={() => setAsking(true)}>
          Delete
        </button>
      )}
    </div>
  );
}

test("a confirm row that replaced its trigger gives focus to the trigger drawn again", async () => {
  const view = render(<Row />);
  const trigger = view.getByLabelText("Delete scott/a");
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement?.textContent).toBe("Cancel");
  expect(escape()).toBe(false);
  await act(async () => {});
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Delete scott/a");
});

function Replying() {
  const [open, setOpen] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  useEscapeLayer(scope, () => setOpen(false), { open });
  return (
    <div data-bb-plugin="source-control">
      <button type="button" disabled={open} onClick={() => setOpen(true)}>
        Reply
      </button>
      {open ? (
        <div ref={scope}>
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- a composer takes focus as it opens */}
          <textarea aria-label="Reply text" autoFocus />
        </div>
      ) : null}
    </div>
  );
}

test("a trigger disabled while its layer is open gets focus back once it is enabled", async () => {
  const view = render(<Replying />);
  const trigger = view.getByText("Reply");
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Reply text");
  expect(escape()).toBe(false);
  await act(async () => {});
  expect(document.activeElement).toBe(trigger);
});

function Tray() {
  const [open, setOpen] = useState(false);
  const scope = useRef<HTMLDivElement>(null);
  useEscapeLayer(scope, () => setOpen(false), { open });
  return (
    <div data-bb-plugin="source-control">
      <button type="button">Elsewhere</button>
      <div ref={scope}>
        <button type="button" onClick={() => setOpen(true)}>
          Send
        </button>
        <div hidden={!open}>Tray</div>
      </div>
    </div>
  );
}

test("a layer that wraps its own trigger leaves focus on the trigger", async () => {
  const view = render(<Tray />);
  view.getByText("Elsewhere").focus();
  const send = view.getByText("Send");
  send.focus();
  // jsdom has no checkVisibility; the browser's answer for a visible trigger.
  send.checkVisibility = () => true;
  fireEvent.click(send);
  expect(escape()).toBe(false);
  await act(async () => {});
  expect(document.activeElement).toBe(send);
});
