import { defineCommand, PluginCliError } from "@bb-kit/core/command";
import { isAbsolute, resolve } from "node:path";
import { collectDiagnostics, type Diagnostic } from "../../shared/document.ts";
import { defaultStyle } from "../../shared/styles.ts";
import { documentStats, type DocumentStats } from "../../shared/parse.ts";
import { render } from "../rpc/render.ts";

interface CheckReport {
  readonly ok: boolean;
  readonly diagnostics: readonly { line: number | null; column: number | null; message: string }[];
  readonly stats: DocumentStats;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function successLine(stats: DocumentStats): string {
  const components =
    stats.components.length === 0
      ? "0 components"
      : `${plural(stats.components.length, "component")} (${stats.components.join(", ")})`;
  const stateIds =
    stats.stateIds.length === 0
      ? "0 state ids"
      : `${plural(stats.stateIds.length, "state id")} (${stats.stateIds.join(", ")})`;
  return `ok — style ${stats.style}, ${plural(stats.blocks, "block")}, ${components}, ${stateIds}`;
}

function reportOf(diagnostics: readonly Diagnostic[], stats: DocumentStats): CheckReport {
  return {
    ok: diagnostics.length === 0,
    diagnostics: diagnostics.map((diagnostic) => ({
      line: diagnostic.span?.line ?? null,
      column: diagnostic.span?.column ?? null,
      message: diagnostic.message,
    })),
    stats,
  };
}

function textOf(path: string, report: CheckReport): string {
  if (report.ok) return `${successLine(report.stats)}\n`;
  const lines = report.diagnostics.map((diagnostic) =>
    diagnostic.line === null
      ? `${path}: ${diagnostic.message}`
      : `${path}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
  );
  return `${lines.join("\n")}\n${plural(report.diagnostics.length, "problem")}\n`;
}

export const check = defineCommand({
  summary: "Parse a .canvas.mdx file and report every diagnostic",
  positionals: [
    { name: "path", description: "Canvas file, absolute or relative to the cwd", required: true },
  ],
  options: {
    json: { type: "boolean", description: "Print {ok, diagnostics, stats} as JSON" },
  },
  async execute(ctx, { positionals: { path }, options: { json } }) {
    const absolute = isAbsolute(path) ? path : resolve(ctx.cwd ?? process.cwd(), path);
    const rendered = await render.execute(ctx, {
      source: { kind: "host", hostId: null, path: absolute },
      knownSha256: null,
    });
    if (rendered.status === "unreadable") {
      throw new PluginCliError(`${path}: ${rendered.reason}: ${rendered.detail}`, { exitCode: 2 });
    }
    if (rendered.status === "unchanged") {
      throw new PluginCliError(`${path}: unexpected unchanged result`, { exitCode: 2 });
    }
    const report =
      rendered.status === "unparseable"
        ? reportOf([rendered.diagnostic], {
            style: defaultStyle,
            blocks: 0,
            components: [],
            stateIds: [],
          })
        : reportOf(collectDiagnostics(rendered.document), documentStats(rendered.document));
    const stdout = json ? `${JSON.stringify(report)}\n` : textOf(path, report);
    return { exitCode: report.ok ? 0 : 1, stdout };
  },
});
