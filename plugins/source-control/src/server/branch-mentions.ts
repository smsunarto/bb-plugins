/**
 * Which GitButler branch a shell command worked on, read from the `but`
 * invocations in it. A GitButler checkout is shared by many threads, each on
 * its own branch, so a thread's branch is the last one its own commands named.
 */

/** A `but` command naming a branch, or renaming one. */
export type BranchMention =
  | { kind: "branch"; branch: string }
  | { kind: "rename"; from: string; to: string };

type Token = { word: string } | { operator: string };

// Heredoc bodies are data, not commands: `cat <<'EOF'` around a `but` line.
const HEREDOC =
  /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

/** A quoted or escaped run starting at `index`: its text and the index of its last character. */
function quoted(script: string, index: number): { text: string; end: number } | null {
  const char = script[index];
  if (char === "'") {
    const close = script.indexOf("'", index + 1);
    const end = close === -1 ? script.length : close;
    return { text: script.slice(index + 1, end), end };
  }
  if (char === '"') {
    let text = "";
    let at = index + 1;
    while (at < script.length && script[at] !== '"') {
      if (script[at] === "\\" && at + 1 < script.length) at += 1;
      text += script[at];
      at += 1;
    }
    return { text, end: at };
  }
  if (char === "\\" && index + 1 < script.length) {
    const next = script[index + 1]!;
    return { text: next === "\n" ? "" : next, end: index + 1 };
  }
  return null;
}

const SEPARATORS = new Set(["\n", ";", "(", ")"]);

/** A control operator at `index` (`;`, `&&`, `|`, …) and how many characters it takes. */
function operatorAt(script: string, index: number): { operator: string; length: number } | null {
  const char = script[index]!;
  if (SEPARATORS.has(char)) return { operator: char, length: 1 };
  if (char !== "&" && char !== "|") return null;
  return script[index + 1] === char
    ? { operator: char + char, length: 2 }
    : { operator: char, length: 1 };
}

function tokenize(script: string): Token[] {
  const tokens: Token[] = [];
  let word: string | null = null;
  const push = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    const run = quoted(script, index);
    const operator = run ? null : operatorAt(script, index);
    if (run) {
      word = (word ?? "") + run.text;
      index = run.end;
    } else if (operator) {
      push();
      tokens.push({ operator: operator.operator });
      index += operator.length - 1;
    } else if (char === " " || char === "\t") {
      push();
    } else {
      word = (word ?? "") + char;
    }
  }
  push();
  return tokens;
}

function simpleCommands(script: string): string[][] {
  const commands: string[][] = [[]];
  for (const token of tokenize(script.replace(HEREDOC, ""))) {
    if ("operator" in token) commands.push([]);
    else commands[commands.length - 1]!.push(token.word);
  }
  return commands.filter((words) => words.length > 0);
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash"]);
const PREFIXES = new Set(["env", "command", "nohup", "time", "exec"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The words after any `VAR=value` assignments and pass-through prefixes. */
function commandWords(words: readonly string[]): readonly string[] {
  let start = 0;
  while (
    start < words.length &&
    (ASSIGNMENT.test(words[start]!) || PREFIXES.has(basename(words[start]!)))
  )
    start += 1;
  return words.slice(start);
}

/**
 * CLI ids (`but`'s two- or three-letter handles) and commit hashes name
 * nothing a pull request lookup can use, so they are not branches.
 */
function isBranchName(value: string | undefined): value is string {
  if (value === undefined || value === "" || value.startsWith("-")) return false;
  if (/^[a-z0-9]{1,3}$/.test(value)) return false;
  if (/^[0-9a-f]{7,40}$/.test(value)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..");
}

/** Flags of the `but` subcommands read here that take a value. */
const VALUE_FLAGS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-A",
  "--above",
  "-B",
  "--below",
  "-C",
  "--current-dir",
]);

type Parsed = { positionals: string[]; options: Map<string, string> };

function parseArguments(words: readonly string[]): Parsed {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    if (equals > 0) {
      options.set(word.slice(0, equals), word.slice(equals + 1));
    } else if (word === "-b" || word === "--branch") {
      // `but commit -b` takes an optional name: a following flag is not one.
      const next = words[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        options.set("--branch", next);
        index += 1;
      }
    } else if (VALUE_FLAGS.has(word)) {
      options.set(word, words[index + 1] ?? "");
      index += 1;
    } else if (!word.startsWith("-")) {
      positionals.push(word);
    }
  }
  return { positionals, options };
}

/**
 * Whether `dir` leaves `checkout`. An absolute path outside it does, and so
 * does a `~/` path the checkout does not end with. A relative path stays
 * where the command started, which is taken to be the checkout.
 */
function leaves(dir: string, checkout: string | undefined): boolean {
  if (checkout === undefined) return false;
  const root = checkout.replace(/\/+$/, "");
  if (dir.startsWith("/")) {
    const target = dir.replace(/\/+$/, "");
    return target !== root && !target.startsWith(`${root}/`);
  }
  if (dir === "~" || dir.startsWith("~/")) {
    // The home directory is unknown here: the path stays when some leading
    // part of it is how the checkout's path ends, as `~/git/app/src` does
    // for `/home/me/git/app`.
    const tail = dir.slice(1).replace(/\/+$/, "");
    for (let end = tail.indexOf("/", 1); ; end = tail.indexOf("/", end + 1)) {
      const prefix = end === -1 ? tail : tail.slice(0, end);
      if (prefix !== "" && root.endsWith(prefix)) return false;
      if (end === -1) return true;
    }
  }
  return false;
}

function butMention(args: readonly string[], checkout: string | undefined): BranchMention | null {
  // Global options come before the subcommand. `-C` elsewhere is another checkout's branch.
  let start = 0;
  while (start < args.length && args[start]!.startsWith("-")) {
    if (args[start] === "-C" || args[start] === "--current-dir") {
      if (leaves(args[start + 1] ?? "", checkout)) return null;
      start += 2;
    } else start += 1;
  }
  const [subcommand, ...rest] = args.slice(start);
  const branch = (name: string | undefined): BranchMention | null =>
    isBranchName(name) ? { kind: "branch", branch: name } : null;
  switch (subcommand) {
    case "commit":
      // With --above or --below and no name, the commit lands on a new branch
      // with a generated name, so nothing here names it.
      return branch(parseArguments(rest).options.get("--branch"));
    case "branch":
    case "pr": {
      const [action, ...more] = rest;
      return action === "new" ? branch(parseArguments(more).positionals[0]) : null;
    }
    case "push":
    case "land":
    case "merge":
      return branch(parseArguments(rest).positionals[0]);
    case "reword": {
      const { positionals, options } = parseArguments(rest);
      const from = positionals[0];
      const to = options.get("-m") ?? options.get("--message");
      return isBranchName(from) && isBranchName(to) ? { kind: "rename", from, to } : null;
    }
    default:
      return null;
  }
}

/** Where `cd <dir>` leaves the commands after it: away from the checkout, or not; undefined when it says nothing. */
function cdLeaves(command: readonly string[], checkout: string | undefined): boolean | undefined {
  const dir = command[1];
  if (dir === undefined || dir === "-") return undefined;
  return dir.startsWith("/") || dir.startsWith("~") ? leaves(dir, checkout) : undefined;
}

/** The script a shell runs with `-c`: `zsh -lc '<script>'`. */
function shellScript(command: readonly string[]): string | undefined {
  const flag = command.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
  return flag === -1 ? undefined : command[flag + 1];
}

function scan(
  script: string,
  checkout: string | undefined,
  away: boolean,
  depth: number,
  out: BranchMention[],
): void {
  let elsewhere = away;
  for (const words of simpleCommands(script)) {
    const command = commandWords(words);
    const program = basename(command[0] ?? "");
    if (program === "cd") {
      elsewhere = cdLeaves(command, checkout) ?? elsewhere;
    } else if (program === "but") {
      const mention = elsewhere ? null : butMention(command.slice(1), checkout);
      if (mention) out.push(mention);
    } else if (SHELLS.has(program) && depth < 3) {
      // The script is a command line of its own.
      const inner = shellScript(command);
      if (inner !== undefined) scan(inner, checkout, elsewhere, depth + 1, out);
    }
  }
}

/**
 * Every branch `command` named through `but`, in order. With `checkout`, a
 * `but` run after `cd` or with `-C` into another directory names nothing:
 * its branch belongs to another repository. `cwd` is where the command
 * started, when the provider reports it.
 */
export function branchMentions(command: string, checkout?: string, cwd?: string): BranchMention[] {
  if (!command.includes("but")) return [];
  const out: BranchMention[] = [];
  scan(command, checkout, cwd ? leaves(cwd, checkout) : false, 0, out);
  return out;
}

/** The branch after `mentions`, starting from `current`. */
export function applyMentions(
  current: string | null,
  mentions: readonly BranchMention[],
): string | null {
  let branch = current;
  for (const mention of mentions) {
    if (mention.kind === "branch") branch = mention.branch;
    else if (mention.from === branch) branch = mention.to;
  }
  return branch;
}
