import { z } from "zod";

/** bb truncates one plugin's instructions to this many characters. */
export const MAX_INSTRUCTIONS_LENGTH = 4096;

/**
 * What a rule can be scoped to. Every field is an allow-list: empty matches
 * anything, otherwise the session must match one entry. Fields combine with
 * AND, so `{ hosts: [mac], providers: [codex] }` means Codex on the Mac.
 */
export const conditionsSchema = z
  .object({
    /** Host ids. */
    hosts: z.array(z.string().min(1)),
    /** Provider ids, such as `codex` or `claude-code`. */
    providers: z.array(z.string().min(1)),
    /** Model globs, such as `claude-opus-*`. `*` matches any run of characters. */
    models: z.array(z.string().trim().min(1).max(200)),
    /** Project ids. */
    projects: z.array(z.string().min(1)),
  })
  .strict();

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().max(80),
    enabled: z.boolean(),
    instructions: z.string().max(MAX_INSTRUCTIONS_LENGTH),
    when: conditionsSchema,
  })
  .strict();

export const rulesSchema = z
  .array(ruleSchema)
  .refine(
    (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
    "rule ids must be unique",
  );

/**
 * The stored rules. Every write bumps `revision`, so a whole-list save from a
 * stale editor can be refused instead of deleting rules it never saw.
 */
export const rulesStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  rules: rulesSchema,
});

/** `saved: false` means the save was based on an old revision. The state is current. */
export const saveResultSchema = rulesStateSchema.extend({ saved: z.boolean() });

export type RulesState = z.infer<typeof rulesStateSchema>;

export type Conditions = z.infer<typeof conditionsSchema>;
export type Rule = z.infer<typeof ruleSchema>;

/** The parts of a thread's agent configuration that rules can match. */
export type Session = {
  host: { id: string };
  provider: { id: string; model: string };
  project: { id: string };
};

export const ANYWHERE: Conditions = { hosts: [], providers: [], models: [], projects: [] };

/**
 * `*` matches any run of characters, case-insensitively. Linear backtracking
 * to the last `*` only, so no pattern can stall the thread-start path.
 */
export function globMatches(pattern: string, value: string): boolean {
  const glob = pattern.trim().toLowerCase();
  const text = value.toLowerCase();
  let g = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (glob[g] === "*") {
      star = g++;
      resume = t;
    } else if (g < glob.length && glob[g] === text[t]) {
      g++;
      t++;
    } else if (star !== -1) {
      g = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (glob[g] === "*") g++;
  return g === glob.length;
}

function allows(list: readonly string[], test: (entry: string) => boolean): boolean {
  return list.length === 0 || list.some(test);
}

export function ruleMatches(rule: Rule, session: Session): boolean {
  const { when } = rule;
  return (
    rule.enabled &&
    rule.instructions.trim().length > 0 &&
    allows(when.hosts, (id) => id === session.host.id) &&
    allows(when.providers, (id) => id === session.provider.id) &&
    allows(when.models, (glob) => globMatches(glob, session.provider.model)) &&
    allows(when.projects, (id) => id === session.project.id)
  );
}

/** The instructions an agent in `session` receives, in rule order. */
export function compose(rules: readonly Rule[], session: Session): string | null {
  const text = rules
    .filter((rule) => ruleMatches(rule, session))
    .map((rule) => rule.instructions.trim())
    .join("\n\n");
  return text.length > 0 ? text : null;
}

export function newRuleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `rule_${Array.from(bytes, (byte) => (byte % 36).toString(36)).join("")}`;
}
