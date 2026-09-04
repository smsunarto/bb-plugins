import { argv, CommandError, defineCommand } from "@bb-kit/core/command";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { placeThreads, type PlacedThread } from "../../shared/anchor.ts";
import type { CanvasDocument } from "../../shared/document.ts";
import { fileNameOf } from "../../shared/document.ts";
import { defaultStyle } from "../../shared/styles.ts";
import { CommentsError, readComments } from "../comments-store.ts";
import { formatWhen } from "../format.ts";
import { render } from "../rpc/render.ts";

const emptyDocument: CanvasDocument = { style: defaultStyle, nodes: [], stateIds: [] };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function orderOf(placed: PlacedThread): number {
  return placed.match.kind === "anchored" ? placed.match.index : Number.POSITIVE_INFINITY;
}

function threadLines(placed: PlacedThread, nowMs: number): readonly string[] {
  const { thread, match } = placed;
  const status = thread.resolvedAtMs === null ? "open" : "resolved";
  const where =
    match.kind === "anchored"
      ? `block ${match.index + 1} ${placed.context}${match.editedSince ? "  edited since" : ""}`
      : "detached (the block is no longer in the file)";
  const lines = [`${thread.id}  ${status}  ${where}`];
  if (match.kind === "detached") lines.push(`  was    ${JSON.stringify(placed.context)}`);
  else if (thread.anchor.quote !== null)
    lines.push(`  quote  ${JSON.stringify(thread.anchor.quote)}`);
  for (const message of thread.messages) {
    const [first = "", ...rest] = message.body.split("\n");
    lines.push(`  ${message.author.padEnd(6)} ${formatWhen(message.createdAtMs, nowMs)}  ${first}`);
    for (const line of rest) lines.push(`                ${line}`);
  }
  return lines;
}

export const comments = defineCommand({
  summary: "List the comments on a .canvas.mdx file with where each one sits now",
  input: z.object({
    path: argv.argument(z.string().min(1), {
      description: "Canvas file, absolute or relative to the cwd",
    }),
    all: argv.flag(z.boolean().optional(), { description: "Include resolved threads" }),
    json: argv.flag(z.boolean().optional(), {
      description: "Print {path, sidecarPath, parses, threads: [{thread, match, context}]} as JSON",
    }),
  }),
  async execute(ctx, { path, all, json }) {
    const absolute = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
    const source = { kind: "host", hostId: null, path: absolute } as const;
    const rendered = await render.execute(ctx, { source, knownSha256: null });
    if (rendered.status === "unreadable") {
      throw new CommandError(`${path}: ${rendered.reason}: ${rendered.detail}`, { exitCode: 2 });
    }
    const parses = rendered.status === "rendered";
    const document = parses ? rendered.document : emptyDocument;
    let read: Awaited<ReturnType<typeof readComments>>;
    try {
      read = await readComments(ctx.bb, source);
    } catch (error) {
      if (error instanceof CommentsError)
        throw new CommandError(`${path}: ${error.message}`, { exitCode: 2 });
      throw error;
    }
    if (read.malformed) {
      throw new CommandError(`${read.sidecarPath} is not a valid comments file; fix or delete it`, {
        exitCode: 2,
      });
    }
    const placement = placeThreads(document, read.file.threads);
    const everything = [...[...placement.byOffset.values()].flat(), ...placement.detached].sort(
      (a, b) => orderOf(a) - orderOf(b),
    );
    const shown =
      all === true ? everything : everything.filter((p) => p.thread.resolvedAtMs === null);
    if (json === true) {
      const report = { path: absolute, sidecarPath: read.sidecarPath, parses, threads: shown };
      return { exitCode: 0, stdout: `${JSON.stringify(report)}\n` };
    }
    const name = fileNameOf(absolute);
    if (everything.length === 0) return { exitCode: 0, stdout: `No comments in ${name}.\n` };
    const hidden = everything.length - shown.length;
    const open = everything.filter((p) => p.thread.resolvedAtMs === null).length;
    const head =
      all === true
        ? `${plural(everything.length, "comment")} in ${name} (${open} open)`
        : `${plural(open, "open comment")} in ${name}${hidden > 0 ? ` (${hidden} resolved, hidden; pass --all)` : ""}`;
    const note = parses
      ? []
      : ["The canvas does not parse right now, so every thread is listed as detached."];
    const nowMs = Date.now();
    const body = shown.map((placed) => threadLines(placed, nowMs).join("\n"));
    return { exitCode: 0, stdout: `${[head, ...note, "", ...body].join("\n")}\n` };
  },
});
