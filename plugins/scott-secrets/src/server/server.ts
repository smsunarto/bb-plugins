import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract } from "../shared/host-contract.ts";
import { foldDescribePairs, parseRequest, runRequest } from "./request.ts";
import type { ServerContext } from "./shared.ts";
import { forgetSudo, parseSudo, runSudo } from "./sudo.ts";

const CACHE_MINUTES_DEFAULT = 15;
const CACHE_MINUTES_MAX = 24 * 60;

function asCliError(error: unknown): PluginCliError {
  if (error instanceof PluginCliError) return error;
  return new PluginCliError(error instanceof Error ? error.message : String(error));
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    sudoCacheMinutes: {
      type: "number",
      label: "Remember sudo password per thread (minutes)",
      description:
        "How long a thread keeps its sudo password in memory after you type it. Until then that thread runs sudo commands without asking; running commands does not extend the window. Restarting bb forgets the password.",
      default: CACHE_MINUTES_DEFAULT,
    },
  });
  const ctx: ServerContext = {
    bb,
    host: bb.hosts.experimental_client({ contract: hostContract }),
    async sudoCacheMinutes() {
      const { sudoCacheMinutes } = await settings.get();
      if (!Number.isFinite(sudoCacheMinutes)) return CACHE_MINUTES_DEFAULT;
      return Math.min(CACHE_MINUTES_MAX, Math.max(1, Math.round(sudoCacheMinutes)));
    },
  };

  const cli = defineCli({
    name: "secret",
    summary: "Securely request credentials and run approved sudo commands.",
    description:
      "Values are typed by the user into a secure form; they never reach the agent, argv, or logs.",
    commands: {
      request: cliCommand({
        summary: "Request one or more secrets in a secure user form.",
        description:
          "Batch every currently known variable into one request. Relative --write-env paths resolve from the CLI working directory; absolute paths may point anywhere on the thread's host.",
        positionals: [
          {
            name: "name",
            description:
              "Environment variable to request (letters, digits, underscores; must not start with a digit); repeat for each variable",
            required: true,
            variadic: true,
          },
        ],
        options: {
          "write-env": {
            type: "string",
            required: true,
            placeholder: "PATH",
            aliases: ["env-file", "dotenv", "write-env-file"],
            description:
              "Dotenv file the values are written to, with mode 0600 and existing assignments preserved",
          },
          purpose: {
            type: "string",
            placeholder: "TEXT",
            aliases: ["reason", "why"],
            description: "One line telling the user why these credentials are needed",
          },
          describe: {
            type: "string",
            repeatable: true,
            placeholder: "NAME=TEXT",
            aliases: ["description", "describe-variable"],
            description:
              "Short description of one requested variable, written as NAME=TEXT or as the two-token form NAME TEXT; repeat per variable",
          },
          json: {
            type: "boolean",
            description:
              "Report failures as a JSON envelope on stdout; the success line is always JSON",
          },
        },
        async run(input, context) {
          const request = parseRequest({
            names: input.positionals.name,
            purpose: input.options.purpose,
            describe: input.options.describe ?? [],
            writeEnv: input.options["write-env"],
          });
          try {
            return await runRequest(ctx, request, context);
          } catch (error) {
            throw asCliError(error);
          }
        },
      }),
      sudo: cliCommand({
        summary: "Run one command as root; the first in a thread asks the user for the password.",
        description:
          "Put the command after --. The first command in a thread shows the user the exact command and asks for the password; later commands in that thread run without asking until the cache window ends. Exits with the command's exit code and passes through its stdout and stderr. The command gets no stdin.",
        passthrough: true,
        options: {
          purpose: {
            type: "string",
            placeholder: "TEXT",
            aliases: ["reason", "why"],
            description: "One line telling the user why the command needs root",
          },
          timeout: {
            type: "integer",
            min: 1,
            max: 86_400,
            default: 600,
            placeholder: "SECONDS",
            description: "Terminate the command after this many seconds (default 600)",
          },
          json: {
            type: "boolean",
            description: "Report failures as a JSON envelope on stdout",
          },
        },
        async run(input, context) {
          const request = parseSudo({
            passthrough: input.passthrough,
            purpose: input.options.purpose,
            timeoutSeconds: input.options.timeout,
          });
          try {
            return await runSudo(ctx, request, context);
          } catch (error) {
            throw asCliError(error);
          }
        },
      }),
      "forget-sudo": cliCommand({
        summary: "Drop the sudo password cached for this thread.",
        options: {
          json: { type: "boolean", description: "Report failures as a JSON envelope on stdout" },
        },
        async run(_input, context) {
          try {
            return await forgetSudo(ctx, context);
          } catch (error) {
            throw asCliError(error);
          }
        },
      }),
    },
  });
  // Only `request` takes the two-token --describe form; sudo's passthrough
  // argv must reach the command untouched.
  bb.cli.register({
    ...cli,
    run: (argv, context) =>
      cli.run(argv[0] === "request" ? foldDescribePairs(argv) : argv, context),
  });
}
