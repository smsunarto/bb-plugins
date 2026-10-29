// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DisplayComment } from "../../shared/contract.js";
import { CommentAuthor } from "./comment-author.js";

afterEach(cleanup);

const agentSource = {
  kind: "agent",
  threadId: "thr_worker",
  threadTitle: "Fix the login bug",
  provider: {
    id: "codex",
    name: "Codex",
    logoUrl: null,
    icon: null,
    strings: { iconTint: null },
  },
} satisfies DisplayComment["source"];
const base: DisplayComment = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZC1",
  taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1",
  source: agentSource,
  authorName: "agent (thr_worker)",
  body: "Done",
  notifiedCount: 0,
  createdAt: "2026-07-15T00:00:00.000Z",
  attachments: [],
};

describe("CommentAuthor", () => {
  it("renders an agent thread title as a link that opens the chat", () => {
    const onOpenThread = vi.fn();
    render(<CommentAuthor comment={base} onOpenThread={onOpenThread} />);

    const link = screen.getByRole("button", { name: "Fix the login bug" });
    fireEvent.click(link);

    expect(onOpenThread).toHaveBeenCalledTimes(1);
    expect(onOpenThread).toHaveBeenCalledWith("thr_worker");
  });

  it("renders the author name as plain text when the title is unresolved", () => {
    const onOpenThread = vi.fn();
    render(
      <CommentAuthor
        comment={{ ...base, source: { ...agentSource, threadTitle: null } }}
        onOpenThread={onOpenThread}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("agent (thr_worker)")).toBeTruthy();
    expect(onOpenThread).not.toHaveBeenCalled();
  });

  it("renders a user comment as its plain author name", () => {
    render(
      <CommentAuthor
        comment={{ ...base, source: { kind: "user" }, authorName: "You" }}
        onOpenThread={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("You")).toBeTruthy();
  });
});
