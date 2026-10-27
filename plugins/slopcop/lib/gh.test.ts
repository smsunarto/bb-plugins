import { beforeEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createGhClient } from "./gh";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
let output = "";
beforeEach(() => {
  output = "";
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    done: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    expect(file).toBe("gh");
    expect(args).toContain("--paginate");
    expect(args).toContain("--jq");
    expect(args).not.toContain("--slurp");
    done(null, output, "");
  }) as never);
});
it("reads every paginated PR row with older gh versions", async () => {
  output =
    JSON.stringify({
      number: 1,
      title: "first\nPR",
      user: { login: "member" },
      author_association: "MEMBER",
    }) +
    "\n" +
    JSON.stringify({ number: 2, title: "second" }) +
    "\n";
  const rows = await createGhClient("gh").listOpenPullRequests("org/repo");
  expect(rows.map((row) => row.number)).toEqual([1, 2]);
  expect(rows[0]?.title).toBe("first\nPR");
  expect(rows[0]?.authorAssociation).toBe("MEMBER");
});
it("handles an empty paginated endpoint", async () => {
  expect(await createGhClient("gh").listOpenPullRequests("org/repo")).toEqual([]);
});
