// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => ({ toPluginPanel: vi.fn() }));

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
const { ALL_WHITEBOARDS, HomePanel, routeSessionId } = await import("./home-panel.tsx");
const { NO_WHITEBOARDS_DESCRIPTION, NO_WHITEBOARDS_TITLE, WelcomePage } =
  await import("../stubs/welcome-page.tsx");

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
  it("shows Home without a back button at the root route", () => {
    render(<HomePanel subPath="" />);
    expect(mountProps()).toEqual({ info: {} });
    expect(screen.queryByRole("button", { name: `← ${ALL_WHITEBOARDS}` })).toBeNull();
  });

  it("shows a session full-page with a way back to the list", () => {
    render(<HomePanel subPath="s1" />);
    expect(mountProps()).toEqual({ info: {}, sessionId: "s1" });
    fireEvent.click(screen.getByRole("button", { name: `← ${ALL_WHITEBOARDS}` }));
    expect(navigate.toPluginPanel).toHaveBeenCalledWith("whiteboard", { subPath: "" });
  });
});

describe("WelcomePage", () => {
  it("shows upstream starter prompts in bb's empty state", () => {
    render(<WelcomePage />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(`${NO_WHITEBOARDS_TITLE}${NO_WHITEBOARDS_DESCRIPTION}`);
    expect(screen.getByRole("button", { name: "Review a change" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Architecture review" }));
    expect(status.textContent).toContain(
      "Create a Whiteboard that sketches out the main data flows, access patterns, and code paths in this repo, so I can do a full architecture review of it. Open it in Whiteboard when you're done.",
    );
  });
});
