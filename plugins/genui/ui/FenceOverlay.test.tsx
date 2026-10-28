// @vitest-environment jsdom
import { createContext, useContext } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FenceOverlay } from "./FenceOverlay";

const Navigation = createContext<(url: string) => void>(() => { throw new Error("Missing thread navigation"); });
vi.mock("@get-bb/plugin-sdk/app", () => ({ experimental_usePluginId: () => "genui" }));
vi.mock("./Fence", () => ({
  useThreadActions: () => ({}),
  Fence: ({ threadId }: { threadId: string }) => {
    const openUrl = useContext(Navigation);
    return <button onClick={() => openUrl("https://example.com")}>Open {threadId}</button>;
  },
}));

function message(thread: string, role = "assistant") {
  const row = document.createElement("div");
  row.setAttribute("data-timeline-row-id", `${thread}:${role}:1`);
  row.innerHTML = '<div><pre><code class="language-ui">Card("Test", [])</code></pre></div>';
  document.body.append(row);
  return row;
}

afterEach(() => { cleanup(); document.body.innerHTML = ""; });

describe("thread-scoped fallback", () => {
  it("preserves each owning thread's navigation through the portal", async () => {
    const a = message("a");
    const b = message("b");
    const user = message("a", "user");
    const openA = vi.fn();
    const openB = vi.fn();
    render(<>
      <Navigation.Provider value={openA}><FenceOverlay threadId="a" /></Navigation.Provider>
      <Navigation.Provider value={openB}><FenceOverlay threadId="b" /></Navigation.Provider>
    </>);
    await waitFor(() => expect(a.querySelector("button")).not.toBeNull());
    fireEvent.click(a.querySelector("button")!);
    expect(openA).toHaveBeenCalledWith("https://example.com");
    expect(openB).not.toHaveBeenCalled();
    fireEvent.click(b.querySelector("button")!);
    expect(openB).toHaveBeenCalledWith("https://example.com");
    expect(a.querySelectorAll("[data-genui-fence]")).toHaveLength(1);
    expect(b.querySelectorAll("[data-genui-fence]")).toHaveLength(1);
    expect(user.querySelector("[data-genui-fence]")).toBeNull();
  });

  it("restores only its own code blocks when a thread unmounts", async () => {
    const a = message("a");
    const b = message("b");
    const first = render(<FenceOverlay threadId="a" />);
    render(<FenceOverlay threadId="b" />);
    await waitFor(() => expect(b.querySelector("[data-genui-hidden]")).not.toBeNull());
    first.unmount();
    expect(a.querySelector("[data-genui-hidden]")).toBeNull();
    expect(a.querySelector("[data-genui-fence]")).toBeNull();
    expect(b.querySelector("[data-genui-hidden]")).not.toBeNull();
    expect(b.querySelector("button")).not.toBeNull();
  });

  it("picks up later messages only for the owning thread", async () => {
    render(<FenceOverlay threadId="a" />);
    let own!: HTMLElement;
    let other!: HTMLElement;
    await act(async () => { own = message("a"); other = message("b"); });
    await waitFor(() => expect(own.querySelector("button")).not.toBeNull());
    expect(other.querySelector("[data-genui-fence]")).toBeNull();
  });
});
