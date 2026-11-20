import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import { join } from "node:path";
import { callerCaptain, readCallerFile } from "../caller.ts";
import { DRIVE_FILE_MAX_BYTES, DrivePathError, resolveDrivePath } from "../drive.ts";
import { driveTag } from "../../contract/rpc.ts";
import { guard, Refusal, render } from "../output.ts";
import { driveSignature } from "../overview.ts";
import { CAPTAIN_OPTION, ensureStorageRoot, JSON_OPTION, type CommandDeps } from "./deps.ts";

const PATH = {
  name: "path",
  required: true,
  description: "A path inside the Captain's Drive, such as CREW.md or roles/review.md",
} as const;

/** The Captain's Drive file a command names, for the Captain or one of its crew. */
async function drivePath(
  deps: CommandDeps,
  ctx: PluginCliContext,
  path: string,
  captainOption: string | undefined,
): Promise<{ file: string; captainId: string }> {
  const captain = await callerCaptain(deps.bb, deps.registry, ctx, {
    captain: captainOption,
    crew: true,
  });
  const root = await ensureStorageRoot(deps);
  if (root === null) {
    throw new Refusal([
      { reason: "the bb server's machine has no thread storage yet", fix: "bb host list" },
    ]);
  }
  try {
    return {
      file: resolveDrivePath(join(root, captain.threadId), path),
      captainId: captain.threadId,
    };
  } catch (error) {
    if (!(error instanceof DrivePathError)) throw error;
    throw new Refusal([
      { reason: error.message, fix: "pass a path inside the Drive, such as CREW.md" },
    ]);
  }
}

export function driveReadCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Print a file from the Captain's Drive, from any machine",
    positionals: [PATH],
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain drive read", json, async () => {
        const path = input.positionals.path;
        const { file } = await drivePath(deps, ctx, path, input.options.captain);
        const size = deps.drive.size(file);
        if (size === null) {
          throw new Refusal([
            { reason: `${path} is not in the Drive`, fix: "bb captain drive read CREW.md" },
          ]);
        }
        if (size > DRIVE_FILE_MAX_BYTES) {
          throw new Refusal([
            {
              reason: `${path} is over ${DRIVE_FILE_MAX_BYTES} bytes`,
              fix: "read it by path on the server's machine",
            },
          ]);
        }
        const content = deps.drive.read(file) ?? "";
        if (!json) return { exitCode: 0, stdout: content };
        return render(
          [{ id: path, ok: true, state: "read", data: { bytes: size, content } }],
          json,
        );
      });
    },
  });
}

export function driveWriteCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Write a file into the Captain's Drive, from any machine",
    positionals: [PATH],
    options: {
      file: {
        type: "string",
        placeholder: "path",
        aliases: ["from", "source"],
        description: "Read the content from this UTF-8 file on the invoking machine",
      },
      content: {
        type: "string",
        placeholder: "text",
        aliases: ["text", "body"],
        description: "The content inline; use --file for anything past one line",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    constraints: [{ kind: "exactly-one", options: ["file", "content"] }],
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain drive write", json, async () => {
        const path = input.positionals.path;
        const { file: target, captainId } = await drivePath(deps, ctx, path, input.options.captain);
        const source = input.options.file;
        const content =
          source === undefined
            ? (input.options.content ?? "")
            : await readCallerFile(deps.bb, ctx, source);
        if (Buffer.byteLength(content) > DRIVE_FILE_MAX_BYTES) {
          throw new Refusal([
            {
              reason: `content is over ${DRIVE_FILE_MAX_BYTES} bytes`,
              fix: "write a smaller file",
            },
          ]);
        }
        deps.drive.write(target, content);
        // The Overview's Drive cards, at once, for every watcher; a running
        // scan takes the Drive as now for its baseline, so it does not refresh
        // the same write again.
        if (deps.registry.driveBaseline(captainId) !== undefined) {
          deps.registry.setDriveBaseline(captainId, await driveSignature(deps, captainId));
        }
        deps.bb.rpc.experimental_invalidate([driveTag(captainId)]);
        const bytes = Buffer.byteLength(content);
        return render(
          [{ id: path, ok: true, state: "written", detail: `${bytes} bytes`, data: { bytes } }],
          json,
        );
      });
    },
  });
}
