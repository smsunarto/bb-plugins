import { experimental_PluginRpcRefusal as PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import { rpcError, toolErrorText } from "./boundary-errors.ts";
import { HostUnavailableError } from "./host-io/client.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const zodError = () => {
  const parsed = z.strictObject({ version: z.number() }).safeParse({ version: "1" });
  if (parsed.success) throw new Error("expected a parse failure");
  return parsed.error;
};

describe("expected failures", () => {
  it.each([
    { status: 404, code: "not_found" },
    { status: 409, code: "conflict" },
    { status: 400, code: "invalid" },
    { status: 401, code: "forbidden" },
  ] as const)(
    "ReviewInputError $status is refused as $code with its message",
    ({ status, code }) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const error = new ReviewInputError("Review not found.", status);

      const refused = rpcError("history", error);

      expect(refused).toBeInstanceOf(PluginRpcRefusal);
      expect(refused).toMatchObject({ code, message: "Review not found." });
      expect(toolErrorText("history", error)).toBe("Review not found.");
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("an offline host is a conflict naming the machine, not a crash", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new HostUnavailableError("h1", "Build Mac", false);
    const message =
      "Build Mac is not connected to bb. Whiteboard reads this checkout on Build Mac. Reconnect it, then retry.";

    expect(rpcError("file", error)).toMatchObject({ code: "conflict", message });
    expect(rpcError("file", error)).toBeInstanceOf(PluginRpcRefusal);
    expect(toolErrorText("file", error)).toBe(message);
    expect(log).not.toHaveBeenCalled();
  });

  it("a schema failure is invalid, with a readable message and its issues", () => {
    const error = zodError();

    const refused = rpcError("command", error);

    expect(refused).toBeInstanceOf(PluginRpcRefusal);
    expect(refused).toMatchObject({
      code: "invalid",
      message: z.prettifyError(error),
      issues: [{ message: error.issues[0]!.message, path: ["version"] }],
    });
    expect(toolErrorText("command", error)).toBe(z.prettifyError(error));
  });
});

describe("unexpected failures", () => {
  it("log the cause and answer only its kind", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(new Error("EACCES: /Users/me/secret/file"), { code: "EACCES" });

    const crashed = rpcError("file", error);

    expect(crashed).not.toBeInstanceOf(PluginRpcRefusal);
    expect(crashed.message).toBe(
      "Whiteboard operation failed (EACCES). The bb server logged the cause in server-stdio.log, in the bb server's logs folder.",
    );
    expect(crashed.message).not.toContain("/Users/me");
    expect(log).toHaveBeenCalledWith("[Whiteboard] file failed:", error);
  });

  it("name the error class when there is no system code", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(toolErrorText("tree", new TypeError("x is undefined"))).toBe(
      "Whiteboard operation failed (TypeError). The bb server logged the cause in server-stdio.log, in the bb server's logs folder.",
    );
  });
});
