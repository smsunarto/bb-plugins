import type { ParsedEvent, TraceEvidence } from "../model";
import {
  contentText,
  decoded,
  event,
  fact,
  json,
  object,
  pointer,
  string,
  type ObjectRecord,
} from "./common";

type ToolLocation = {
  at: string;
  inputAt: string;
  nameAt: string;
  action?: "invoked" | "requested" | "available" | "result";
  basis?: TraceEvidence["basis"];
};

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function fileEvidence(path: string, at: string, basis: TraceEvidence["basis"]): TraceEvidence[] {
  const name = basename(path);
  if (name === "SKILL.md") {
    const facts = [fact("skills", "requested", path, at, basis)];
    const plugin = /\/(?:\.codex|\.claude)\/plugins\/cache\/([^/]+)\/([^/]+)\//.exec(path);
    if (plugin)
      facts.push(fact("plugins", "requested", `${plugin[1]}/${plugin[2]}`, at, "inferred"));
    return facts;
  }
  if (name === "AGENTS.md" || name === "CLAUDE.md")
    return [fact("instructions", "requested", path, at, basis)];
  return [];
}

type ShellState = { commands: string[][]; words: string[]; word: string; quote: string };

function finishShellWord(state: ShellState): void {
  if (state.word) state.words.push(state.word);
  state.word = "";
}

function finishShellCommand(state: ShellState): void {
  finishShellWord(state);
  if (state.words.length) state.commands.push(state.words);
  state.words = [];
}

function shellCharacter(state: ShellState, text: string, index: number): number {
  const char = text[index]!;
  if (char === "\\" && state.quote !== "'") {
    state.word += text[index + 1] ?? "";
    return index + 1;
  }
  if (state.quote) {
    if (char === state.quote) state.quote = "";
    else state.word += char;
    return index;
  }
  if (["'", '"'].includes(char)) {
    state.quote = char;
    return index;
  }
  if (char === "#" && !state.word) {
    const newline = text.indexOf("\n", index);
    finishShellCommand(state);
    return newline < 0 ? text.length : newline;
  }
  if (/[;|&\n]/.test(char)) {
    finishShellCommand(state);
    return index;
  }
  if (/\s/.test(char)) finishShellWord(state);
  else state.word += char;
  return index;
}

function shellCommands(text: string): string[][] {
  const state: ShellState = { commands: [], words: [], word: "", quote: "" };
  const bounded = text.slice(0, 131072);
  for (let index = 0; index < bounded.length && state.commands.length < 128; index += 1)
    index = shellCharacter(state, bounded, index);
  finishShellCommand(state);
  return state.commands;
}

function commandEvidence(
  command: string,
  at: string,
  basis: TraceEvidence["basis"],
  action: ToolLocation["action"],
): { facts: TraceEvidence[]; read: boolean } {
  const facts: TraceEvidence[] = [];
  let read = false;
  if (/<<-?\s*['"]?[A-Za-z_]/.test(command)) return { facts, read };
  for (const words of shellCommands(command)) {
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
    if (words[index] === "command") index += 1;
    const executable = basename(words[index] ?? "");
    const args = words.slice(index + 1);
    if ((executable === "parallel-cli" || executable === "parallel") && args[0] === "search") {
      facts.push(fact("search", action ?? "invoked", "Parallel CLI search", at, basis));
    }
    if (executable === "cat") {
      read = true;
      for (const path of args.filter((arg) => !arg.startsWith("-")))
        facts.push(...fileEvidence(path, at, basis));
    }
  }
  return { facts, read };
}

type ToolContext = {
  name: string;
  rawName: string;
  args: ObjectRecord;
  input: unknown;
  location: ToolLocation;
  action: NonNullable<ToolLocation["action"]>;
  basis: TraceEvidence["basis"];
  field(key: string): string;
};
type Description = { template: string; facts: TraceEvidence[] };

const basicTemplates = new Map([
  ["Read", "read"],
  ["read_file", "read"],
  ["Write", "write"],
  ["write_file", "write"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["edit_file", "edit"],
  ["apply_patch", "patch"],
]);
const searchNames = new Map([
  ["WebSearch", "Native web search"],
  ["web_search", "Native web search"],
  ["web_search_call", "Native web search"],
  ["web.run", "Native web search"],
  ["web__run", "Native web search"],
  ["WebFetch", "Native web fetch"],
  ["web_fetch", "Native web fetch"],
]);
const agentNames = new Set([
  "Agent",
  "Task",
  "spawn_agent",
  "send_message",
  "wait_agent",
  "followup_task",
  "interrupt_agent",
  "list_agents",
]);
const commandNames = new Set(["Bash", "exec_command", "run_command"]);

function mcpDescription(context: ToolContext): Description {
  const { name, rawName, action, basis, location } = context;
  const server = name.slice(5).split(/__|\./)[0] ?? name;
  const facts = [fact("mcp", action, rawName, location.nameAt, basis)];
  if (server.startsWith("plugin_"))
    facts.push(fact("plugins", action, server, location.nameAt, basis));
  const parallel =
    /^parallel(?:[-_]web)?$/.test(server) &&
    /(?:__|\.)(?:web_search|search|search_web)$/.test(name);
  if (parallel) facts.push(fact("search", action, "Parallel web search", location.nameAt, basis));
  return { template: parallel ? "search" : "mcp", facts };
}

function namedDescription(context: ToolContext): Description {
  const { name, args, action, basis, location } = context;
  if (name.startsWith("mcp__")) return mcpDescription(context);
  const search = searchNames.get(name);
  if (search)
    return { template: "search", facts: [fact("search", action, search, location.nameAt, basis)] };
  if (name === "Skill")
    return {
      template: "skill",
      facts: [
        fact(
          "skills",
          action,
          string(args.skill) ?? "Skill",
          args.skill ? context.field("skill") : location.nameAt,
          basis,
        ),
      ],
    };
  const agent = name.replace(/^collaboration\./, "");
  if (agentNames.has(agent))
    return {
      template: "subagent",
      facts: [
        fact(
          "subagents",
          action,
          string(args.subagent_type) ?? string(args.agent_type) ?? name,
          location.nameAt,
          basis,
        ),
      ],
    };
  return { template: basicTemplates.get(name) ?? "command", facts: [] };
}

function argumentEvidence(context: ToolContext): TraceEvidence[] {
  const { args, name, basis } = context;
  const facts: TraceEvidence[] = [];
  if (args.dangerouslyDisableSandbox === true)
    facts.push(
      fact(
        "sandbox",
        "bypass_requested",
        "Sandbox bypass requested",
        context.field("dangerouslyDisableSandbox"),
        basis,
      ),
    );
  if (args.sandbox_permissions === "require_escalated")
    facts.push(
      fact(
        "sandbox",
        "bypass_requested",
        "Escalated execution requested",
        context.field("sandbox_permissions"),
        basis,
      ),
    );
  const path = string(args.file_path) ?? string(args.path);
  if (basicTemplates.get(name) === "read" && path)
    facts.push(...fileEvidence(path, context.field(args.file_path ? "file_path" : "path"), basis));
  return facts;
}

function commandDescription(context: ToolContext): (Description & { preview: string }) | null {
  if (!commandNames.has(context.name)) return null;
  const command = string(context.args.cmd) ?? string(context.args.command);
  if (!command) return null;
  const result = commandEvidence(
    command,
    context.field(context.args.cmd ? "cmd" : "command"),
    context.basis,
    context.action,
  );
  let template = result.read ? "read" : "command";
  if (result.facts.some((item) => item.topic === "search")) template = "search";
  return { template, facts: result.facts, preview: command };
}

function toolPreview(args: ObjectRecord, input: unknown): string {
  return (
    string(args.file_path) ??
    string(args.path) ??
    string(args.query) ??
    string(args.skill) ??
    (typeof input === "string" ? input : json(input))
  );
}

export function toolEvidence(
  name: string,
  input: unknown,
  location: ToolLocation,
): Description & { preview: string; input: unknown } {
  const parsedInput = decoded(input);
  const context: ToolContext = {
    name: name.replace(/^(?:functions|tools)\./, ""),
    rawName: name,
    args: object(parsedInput),
    input: parsedInput,
    location,
    action: location.action ?? "invoked",
    basis: location.basis ?? "recorded",
    field: (key) => (typeof input === "string" ? location.inputAt : pointer(location.inputAt, key)),
  };
  const named = namedDescription(context);
  const command = commandDescription(context);
  return {
    template: command?.template ?? named.template,
    facts: [...named.facts, ...argumentEvidence(context), ...(command?.facts ?? [])],
    preview: command?.preview ?? toolPreview(context.args, input),
    input: parsedInput,
  };
}

type Token = { kind: "word" | "string" | "symbol"; value: string };

function codeString(text: string, start: number): { token: Token; next: number } {
  const quote = text[start]!;
  let value = "";
  let dynamic = false;
  let index = start + 1;
  const escapes: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };
  while (index < text.length && text[index] !== quote) {
    if (text[index] === "\\") {
      const escaped = text[index + 1] ?? "";
      value += escapes[escaped] ?? escaped;
      index += 2;
      continue;
    }
    if (quote === "`" && text[index] === "$" && text[index + 1] === "{") dynamic = true;
    value += text[index++];
  }
  return { token: { kind: "string", value: dynamic ? "" : value }, next: index + 1 };
}

function codeRegex(text: string, start: number): number | null {
  let characterClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") return null;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") characterClass = true;
    else if (char === "]") characterClass = false;
    else if (char === "/" && !characterClass) {
      let end = index + 1;
      while (/[A-Za-z]/.test(text[end] ?? "")) end += 1;
      return end;
    }
  }
  return null;
}

function codeToken(text: string, index: number): { token?: Token; next: number } {
  const char = text[index]!;
  if (/\s/.test(char)) return { next: index + 1 };
  if (text.startsWith("//", index)) {
    const end = text.indexOf("\n", index + 2);
    return { next: end < 0 ? text.length : end };
  }
  if (text.startsWith("/*", index)) {
    const end = text.indexOf("*/", index + 2);
    return { next: end < 0 ? text.length : end + 2 };
  }
  if (["'", '"', "`"].includes(char)) return codeString(text, index);
  if (char === "/") {
    const end = codeRegex(text, index);
    if (end !== null) return { token: { kind: "string", value: "" }, next: end };
  }
  if (/[A-Za-z_$]/.test(char)) {
    let end = index + 1;
    while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end += 1;
    return { token: { kind: "word", value: text.slice(index, end) }, next: end };
  }
  return { token: { kind: "symbol", value: char }, next: index + 1 };
}

function codeTokens(source: string): Token[] {
  const tokens: Token[] = [];
  const text = source.slice(0, 131072);
  for (let index = 0; index < text.length && tokens.length < 16384;) {
    const result = codeToken(text, index);
    if (result.token) tokens.push(result.token);
    index = result.next;
  }
  return tokens;
}

function nestedCallName(tokens: Token[], index: number): string | null {
  if (
    tokens[index]?.kind !== "word" ||
    tokens[index]?.value !== "tools" ||
    tokens[index + 1]?.value !== "." ||
    tokens[index + 2]?.kind !== "word" ||
    tokens[index + 3]?.value !== "("
  )
    return null;
  return tokens[index + 2]!.value;
}

const argumentNames = new Set([
  "cmd",
  "command",
  "sandbox_permissions",
  "dangerouslyDisableSandbox",
  "skill",
  "subagent_type",
  "agent_type",
]);
function nestedArguments(tokens: Token[], start: number): ObjectRecord {
  const args: ObjectRecord = {};
  let depth = 1;
  for (let index = start; index < Math.min(tokens.length, start + 4096) && depth > 0; index += 1) {
    const key = tokens[index]!.value;
    if (key === "(") depth += 1;
    if (key === ")") depth -= 1;
    const value = tokens[index + 2];
    if (!argumentNames.has(key) || tokens[index + 1]?.value !== ":" || !value) continue;
    if (value.kind === "string") args[key] = value.value;
    else if (value.value === "true") args[key] = true;
  }
  return args;
}

function nestedToolEvidence(code: string, at: string): TraceEvidence[] {
  const tokens = codeTokens(code);
  const facts: TraceEvidence[] = [];
  for (let index = 0; index < tokens.length && facts.length < 64; index += 1) {
    const name = nestedCallName(tokens, index);
    if (!name) continue;
    const args = nestedArguments(tokens, index + 4);
    const inferred = toolEvidence(name, args, {
      at,
      inputAt: at,
      nameAt: at,
      action: "requested",
      basis: "inferred",
    }).facts;
    for (const item of inferred) {
      item.pointer = at;
      facts.push(item);
    }
  }
  return facts;
}

export function toolCall(
  record: ObjectRecord,
  input: {
    name: string;
    callId: string | null;
    value: unknown;
    at: string;
    inputAt: string;
    nameAt: string;
    code?: boolean;
  },
): ParsedEvent {
  const description = toolEvidence(input.name, input.value, input);
  if (input.code && typeof input.value === "string")
    description.facts.push(...nestedToolEvidence(input.value, input.inputAt));
  return event(record, {
    kind: "tool_call",
    role: "assistant",
    title: input.name,
    preview: description.preview,
    template: description.template,
    pointer: input.at,
    tool: { name: input.name, callId: input.callId, status: "requested" },
    evidence: description.facts,
    body: {
      type: "tool",
      input: description.input,
      output: null,
      text: typeof input.value === "string" ? input.value : null,
    },
  });
}

function denial(output: unknown, failed: boolean, succeeded: boolean): boolean {
  const record = object(decoded(output));
  if (record.sandbox_denied === true || record.approval_denied === true) return true;
  if (succeeded) return false;
  const text =
    typeof output === "string"
      ? output
      : contentText(output) || string(record.aggregated_output) || string(record.output) || "";
  return text
    .split("\n")
    .some(
      (line) =>
        /^(?:Permission request|Approval(?: request)?) (?:denied|rejected)\b|^Request rejected:\s*approval denied\b/i.test(
          line.trim(),
        ) ||
        /^(?:Command failed with exit code -?\d+:\s*)(?:Error:\s*)?Sandbox (?:denied|blocked)\b/i.test(
          line.trim(),
        ) ||
        (failed && /^(?:Error:\s*)?Sandbox (?:denied|blocked)\b/i.test(line.trim())),
    );
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  const result = object(value);
  return (
    contentText(value) || string(result.aggregated_output) || string(result.output) || json(value)
  );
}

function resultExitCode(result: ObjectRecord, text: string): number | null {
  for (const value of [result.exit_code, result.exitCode]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const code = /(?:^|\n)(?:Process exited with code|Command failed with exit code) (-?\d+)\b/i.exec(
    text,
  )?.[1];
  return code === undefined ? null : Number(code);
}

function resultOutcome(
  value: unknown,
  isError: boolean | undefined,
): { text: string; blocked: boolean; status: "error" | "success" | "unknown" } {
  const result = object(decoded(value));
  const text = resultText(value);
  const exitCode = resultExitCode(result, text);
  const failed =
    isError === true || result.is_error === true || (exitCode !== null && exitCode !== 0);
  const succeeded = !failed && (isError === false || result.is_error === false || exitCode === 0);
  const blocked = denial(value, failed, succeeded);
  if (failed || blocked) return { text, blocked, status: "error" };
  return { text, blocked, status: succeeded ? "success" : "unknown" };
}

export function toolResult(
  record: ObjectRecord,
  input: { value: unknown; callId: string | null; at: string; outputAt: string; isError?: boolean },
): ParsedEvent {
  const { text, blocked, status } = resultOutcome(input.value, input.isError);
  const title = blocked ? "Execution blocked" : status === "error" ? "Tool error" : "Tool result";
  return event(record, {
    kind: "tool_result",
    role: "tool",
    title,
    preview: text,
    pointer: input.at,
    template: /^(?:diff --git |\*\*\* Begin Patch)/.test(text.trimStart()) ? "patch" : "command",
    tool: { name: "Tool result", callId: input.callId, status },
    evidence: blocked
      ? [fact("sandbox", "blocked", "Execution explicitly denied", input.outputAt)]
      : [],
    body: { type: "tool", input: null, output: input.value, text },
  });
}
