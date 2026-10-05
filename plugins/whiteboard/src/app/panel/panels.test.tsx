// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => ({ toPluginPanel: vi.fn(), toCompose: vi.fn() }));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => navigate,
  experimental_Icon: ({ name }: { name: string }) => <svg data-icon={name} />,
}));
// The panels' own job is routing; the mount and the info query have their own specs.
vi.mock("./mount.tsx", () => ({
  WhiteboardMount: (props: { sessionId?: string; threadId?: string }) => (
    <div data-testid="mount">{JSON.stringify(props)}</div>
  ),
}));
vi.mock("../lib/whiteboard-info.tsx", () => ({
  WhiteboardInfo: ({ children }: { children: (info: object) => unknown }) => children({}),
}));

const { SessionPanel, panelSessionId } = await import("./session-panel.tsx");
const { HomePanel, routeSessionId } = await import("./home-panel.tsx");
const { HomeHeader } = await import("./home-header.tsx");
const { NO_WHITEBOARDS_DESCRIPTION, NO_WHITEBOARDS_TITLE, WelcomePage } =
  await import("../stubs/welcome-page.tsx");

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const mountProps = () => JSON.parse(screen.getByTestId("mount").textContent!);

describe("panelSessionId", () => {
  it("accepts only a non-empty string sessionId", () => {
    expect(panelSessionId({ sessionId: "s1" })).toBe("s1");
    expect(panelSessionId({ sessionId: "" })).toBeUndefined();
    expect(panelSessionId({ sessionId: 7 })).toBeUndefined();
    expect(panelSessionId(null)).toBeUndefined();
    expect(panelSessionId(["s1"])).toBeUndefined();
  });
});

describe("routeSessionId", () => {
  it("reads the first path segment", () => {
    expect(routeSessionId("")).toBeUndefined();
    expect(routeSessionId("s1")).toBe("s1");
    expect(routeSessionId("s%201/extra")).toBe("s 1");
    expect(routeSessionId("bad%E0%A4")).toBe("bad%E0%A4");
  });
});

describe("SessionPanel", () => {
  it("mounts the session named by the tab params", () => {
    render(<SessionPanel threadId="thread-1" params={{ sessionId: "s1" }} />);
    expect(mountProps()).toEqual({ threadId: "thread-1", info: {}, sessionId: "s1" });
  });

  it("mounts Home for the thread without a session", () => {
    render(<SessionPanel threadId="thread-1" params={null} />);
    expect(mountProps()).toEqual({ threadId: "thread-1", info: {} });
  });
});

describe("HomePanel", () => {
  it("shows Home at the root route", () => {
    render(<HomePanel subPath="" />);
    expect(mountProps()).toEqual({ info: {} });
  });

  it("shows a session full-page with no back row in the body", () => {
    render(<HomePanel subPath="abc" />);
    expect(mountProps()).toEqual({ info: {}, sessionId: "abc" });
    expect(screen.queryByRole("button", { name: "All Whiteboards" })).toBeNull();
  });
});

describe("HomeHeader", () => {
  it("links a full-page session back to Home from bb's title bar", () => {
    render(<HomeHeader subPath="abc" />);
    fireEvent.click(screen.getByRole("button", { name: "All Whiteboards" }));
    expect(navigate.toPluginPanel).toHaveBeenCalledWith("whiteboard", { subPath: "" });
  });

  it("renders nothing on Home", () => {
    const { container } = render(<HomeHeader subPath="" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("WelcomePage", () => {
  const ARCHITECTURE_PROMPT =
    "Create a Whiteboard that sketches out the main data flows, access patterns, and code paths in this repo, so I can do a full architecture review of it. Open it in Whiteboard when you're done.";

  it("shows upstream starter prompts in bb's empty state", () => {
    render(<WelcomePage />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(`${NO_WHITEBOARDS_TITLE}${NO_WHITEBOARDS_DESCRIPTION}`);
    expect(status.textContent).toContain("type /whiteboard in any thread");
    expect(screen.getByRole("button", { name: "Review a change" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Architecture review" }));
    expect(status.textContent).toContain(ARCHITECTURE_PROMPT);
    expect(screen.getByRole("button", { name: "Copy prompt" })).toBeTruthy();
  });

  it("starts a new thread with the selected prompt", () => {
    render(<WelcomePage />);
    fireEvent.click(screen.getByRole("button", { name: "Start in a new thread" }));
    expect(navigate.toCompose).toHaveBeenLastCalledWith({
      initialPrompt:
        "Create a Whiteboard of my current branch against up to date main, then open it in Whiteboard.",
      focusPrompt: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Architecture review" }));
    fireEvent.click(screen.getByRole("button", { name: "Start in a new thread" }));
    expect(navigate.toCompose).toHaveBeenLastCalledWith({
      initialPrompt: ARCHITECTURE_PROMPT,
      focusPrompt: true,
    });
  });
});
