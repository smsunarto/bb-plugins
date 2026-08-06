// bb-plugin-ghostty — backend entry.
//
// Bridges BB's terminal sessions (bb.sdk.terminals) to the frontend, which
// renders them with libghostty (ghostty-web WASM) instead of the built-in
// terminal. Also serves the vendored ghostty-vt.wasm binary over HTTP so the
// frontend bundle never has to inline it.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

const sessionOutput = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["starting", "running", "disconnected", "exited"]),
  exitCode: z.number().nullable(),
  cols: z.number(),
  rows: z.number(),
});

const terminalId = z.string().min(1);
const dims = {
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(1000),
};

export const rpcContract = defineRpcContract({
  // Reuse the newest live Ghostty session for the thread, or create one.
  ensureTerminal: {
    input: z.object({ threadId: z.string().min(1), ...dims }).strict(),
    output: sessionOutput,
  },
  sendInput: {
    input: z.object({ terminalId, dataBase64: z.string() }).strict(),
    output: z.object({ status: sessionOutput.shape.status }),
  },
  resize: {
    input: z.object({ terminalId, ...dims }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  // One poll returns new output chunks and the session status together.
  readOutput: {
    input: z
      .object({
        terminalId,
        sinceSeq: z.number().int().nonnegative().optional(),
        tailBytes: z.number().int().positive().max(4_000_000).optional(),
      })
      .strict(),
    output: z.object({
      chunks: z.array(z.object({ seq: z.number(), dataBase64: z.string() })),
      nextSeq: z.number(),
      truncated: z.boolean(),
      status: sessionOutput.shape.status,
      exitCode: z.number().nullable(),
    }),
  },
  restart: {
    input: z.object({ terminalId }).strict(),
    output: sessionOutput,
  },
});

const SESSION_TITLE = "Ghostty";

function toSessionOutput(session: {
  id: string;
  title: string;
  status: "starting" | "running" | "disconnected" | "exited";
  exitCode: number | null;
  cols: number;
  rows: number;
}): z.infer<typeof sessionOutput> {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
  };
}

function locateWasm(): string | null {
  // server.ts runs from the plugin root on path installs and from dist/ when
  // built, so probe both directions for the vendored copy (with the npm
  // package as a fallback).
  const candidates = [
    "./assets/ghostty-vt.wasm",
    "../assets/ghostty-vt.wasm",
    "./node_modules/ghostty-web/ghostty-vt.wasm",
    "../node_modules/ghostty-web/ghostty-vt.wasm",
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return null;
}

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    fontFamily: {
      type: "string",
      label: "Font family",
      default:
        '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    },
    fontSize: { type: "string", label: "Font size (px)", default: "13" },
    cursorBlink: { type: "boolean", label: "Blinking cursor", default: true },
    scrollback: { type: "string", label: "Scrollback lines", default: "10000" },
  });

  let wasmBytes: ArrayBuffer | null = null;
  bb.http.route("GET", "/wasm", () => {
    if (!wasmBytes) {
      const path = locateWasm();
      if (!path) {
        return new Response("ghostty-vt.wasm not found in plugin directory", {
          status: 404,
        });
      }
      const bytes = readFileSync(path);
      wasmBytes = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    }
    return new Response(wasmBytes, {
      headers: {
        "content-type": "application/wasm",
        "cache-control": "public, max-age=3600",
      },
    });
  });

  bb.rpc.register(rpcContract, {
    async ensureTerminal({ threadId, cols, rows }) {
      const { sessions } = await bb.sdk.terminals.list({
        scope: { kind: "thread", threadId },
      });
      const live = sessions
        .filter(
          (session) =>
            session.title === SESSION_TITLE &&
            (session.status === "running" || session.status === "starting"),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (live) {
        if (live.cols !== cols || live.rows !== rows) {
          await bb.sdk.terminals.resize({ terminalId: live.id, cols, rows });
        }
        return toSessionOutput({ ...live, cols, rows });
      }
      const created = await bb.sdk.terminals.create({
        scope: { kind: "thread", threadId },
        cols,
        rows,
        title: SESSION_TITLE,
      });
      return toSessionOutput(created);
    },

    async sendInput({ terminalId, dataBase64 }) {
      const session = await bb.sdk.terminals.input({ terminalId, dataBase64 });
      return { status: session.status };
    },

    async resize({ terminalId, cols, rows }) {
      await bb.sdk.terminals.resize({ terminalId, cols, rows });
      return { ok: true as const };
    },

    async readOutput({ terminalId, sinceSeq, tailBytes }) {
      const [output, session] = await Promise.all([
        bb.sdk.terminals.output({ terminalId, sinceSeq, tailBytes }),
        bb.sdk.terminals.get({ terminalId }),
      ]);
      return {
        chunks: output.chunks,
        nextSeq: output.nextSeq,
        truncated: output.truncated,
        status: session.status,
        exitCode: session.exitCode,
      };
    },

    async restart({ terminalId }) {
      const session = await bb.sdk.terminals.restart({ terminalId });
      return toSessionOutput(session);
    },
  });
}
