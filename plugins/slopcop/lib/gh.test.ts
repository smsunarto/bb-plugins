import { beforeEach, describe, expect, it, vi } from "vitest";
import { experimental_execHostFileCallback as execFile } from "@get-bb/plugin-sdk/process";
import { Effect, Result } from "effect";
import { createGhClient } from "./gh";
vi.mock("@get-bb/plugin-sdk/process", () => ({ experimental_execHostFileCallback: vi.fn() }));
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
  const rows = await Effect.runPromise(createGhClient("gh").listOpenPullRequests("org/repo"));
  expect(rows.map((row) => row.number)).toEqual([1, 2]);
  expect(rows[0]?.title).toBe("first\nPR");
  expect(rows[0]?.authorAssociation).toBe("MEMBER");
});
it("handles an empty paginated endpoint", async () => {
  expect(await Effect.runPromise(createGhClient("gh").listOpenPullRequests("org/repo"))).toEqual(
    [],
  );
});

/** What one `gh` call does: print a login, or fail with this output. */
type Reply = { stdout: string } | { stderr: string; timedOut?: boolean };

/** Signs in with `api user` answering `asUser` and `slopcop-login` answering `asBot`. */
async function signIn(asUser: Reply, asBot: Reply): Promise<string | null | "unavailable"> {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    done: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const reply = args[0] === "slopcop-login" ? asBot : asUser;
    if ("stdout" in reply) return done(null, reply.stdout, "");
    const error = Object.assign(new Error(`Command failed: gh ${args.join(" ")}\n`), {
      code: reply.timedOut ? null : 1,
      killed: reply.timedOut === true,
    });
    done(error, "", reply.stderr);
  }) as never);
  const outcome = await Effect.runPromise(Effect.result(createGhClient("gh").authenticatedLogin()));
  return Result.isSuccess(outcome) ? outcome.success : "unavailable";
}

// Verbatim from gh 2.45 and the slopcop-gh wrapper.
const notACommand = { stderr: 'unknown command "slopcop-login" for "gh"' };

describe("signing in", () => {
  it.each([
    ["gh is signed out", "To get started with GitHub CLI, please run:  gh auth login"],
    ["the token is rejected", "gh: Bad credentials (HTTP 401)"],
    ["the bot wrapper's key is rejected", "slopcop-gh: token request failed (401): {}"],
    ["gh is missing", ""],
  ])("asks for configuration when %s", async (_case, stderr) => {
    expect(await signIn({ stderr }, notACommand)).toBeNull();
  });

  it.each([
    ["DNS fails", "error connecting to api.github.com\ncheck your internet connection"],
    [
      "the connection is refused",
      'Get "https://api.github.com/user": dial tcp 140.82.112.6:443: connect: connection refused',
    ],
    ["GitHub is down", "gh: Server Error (HTTP 502)"],
    ["the connection times out", "net/http: TLS handshake timeout"],
  ])("reports GitHub out of reach when %s", async (_case, stderr) => {
    expect(await signIn({ stderr }, notACommand)).toBe("unavailable");
  });

  it("reports GitHub out of reach when gh outlives its timeout", async () => {
    expect(await signIn({ stderr: "", timedOut: true }, notACommand)).toBe("unavailable");
  });

  it("reports GitHub out of reach when the bot wrapper cannot mint a token", async () => {
    const offline = { stderr: "slopcop-gh: fetch failed" };
    expect(await signIn(offline, offline)).toBe("unavailable");
  });

  it("asks for configuration when one lookup is rejected while the other cannot connect", async () => {
    expect(
      await signIn(
        { stderr: "slopcop-gh: token request failed (401): {}" },
        { stderr: "slopcop-gh: fetch failed" },
      ),
    ).toBeNull();
  });

  it("takes the bot wrapper's login when GitHub has no user for an installation token", async () => {
    expect(
      await signIn(
        { stderr: "gh: Resource not accessible by integration (HTTP 403)" },
        { stdout: "slopcop[bot]\n" },
      ),
    ).toBe("slopcop[bot]");
  });
});
