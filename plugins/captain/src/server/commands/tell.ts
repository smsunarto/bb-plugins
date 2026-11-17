import { cliCommand } from "@get-bb/plugin-sdk";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { callerCaptain } from "../caller.ts";
import { crewOnTask, isActive, readCrew, steer, tasksOrRefuse, type CrewThread } from "../crew.ts";
import { guard, Refusal, render, type Blocker, type Item } from "../output.ts";
import { parseRole, ROLE_SPECS, type Role } from "../roles.ts";
import { adoptionContract } from "./dispatch.ts";
import { textOption } from "./ask.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

const THREAD_ID = /^thr_[A-Za-z0-9_-]+$/u;

export function tellCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Steer crew threads with one message; --rule also adds it to CREW.md",
    positionals: [
      {
        name: "target",
        variadic: true,
        description: "Task keys or crew thread ids; a task reaches its live crew threads",
      },
    ],
    options: {
      role: {
        type: "string",
        placeholder: "role",
        description: "Only the thread with this role on each task, such as Implement",
      },
      all: { type: "boolean", description: "Every live crew thread" },
      rule: {
        type: "boolean",
        description:
          "Append the message to CREW.md as a rule for every crew thread; owes no report",
      },
      message: {
        type: "string",
        stdin: true,
        placeholder: "text",
        description: "The message",
      },
      "message-file": {
        type: "string",
        placeholder: "path",
        description: "Read the message from this UTF-8 file on the invoking machine",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    constraints: [{ kind: "exactly-one", options: ["message", "message-file"] }],
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain tell", json, async () => {
        const captain = await callerCaptain(deps.bb, deps.registry, ctx, {
          captain: input.options.captain,
        });
        const message = (
          await textOption(
            deps,
            ctx,
            input.options.message,
            input.options["message-file"],
            "--message-stdin",
          )
        ).trim();
        const targets = input.positionals.target ?? [];
        const blockers: Blocker[] = [];
        if (message === "")
          blockers.push({ reason: "the message is empty", fix: "pass --message <text>" });
        if (targets.length === 0 && !input.options.all) {
          blockers.push({ reason: "no crew named", fix: "pass task keys or thread ids, or --all" });
        }
        if (targets.length > 0 && input.options.all) {
          blockers.push({
            reason: "--all already names every crew thread",
            fix: "drop the targets or --all",
          });
        }
        let role: Role | null = null;
        if (input.options.role !== undefined) {
          role = parseRole(input.options.role);
          if (role === null) {
            blockers.push({
              reason: `no role ${JSON.stringify(input.options.role)}`,
              fix: "pass --role Plan, Implement or Review",
            });
          }
        }
        const driveDir = deps.registry.driveDir(captain.threadId);
        if (input.options.rule && driveDir === null) {
          blockers.push({ reason: "the Captain's Drive is not known yet", fix: "bb host list" });
        }
        if (blockers.length > 0) throw new Refusal(blockers);

        const crew = await tasksOrRefuse(() => readCrew(deps, captain.threadId));
        const chosen = pick(crew, targets, role, input.options.all, blockers);
        if (blockers.length > 0) throw new Refusal(blockers);

        const items: Item[] = [];
        if (input.options.rule && driveDir !== null) items.push(appendRule(driveDir, message));
        const text = input.options.rule
          ? deps.files.read("rule-tell", { captain: JSON.stringify(captain.name), rule: message })
          : message;
        const notes = chosen.length === 0 ? ["no live crew to tell"] : [];
        items.push(
          ...(await Promise.all(
            chosen.map(async (member): Promise<Item> => {
              const taskKey = member.rows[0]?.task.key ?? "-";
              const label = member.role === null ? "-" : ROLE_SPECS[member.role].label;
              // A rule reaches an idle thread through CREW.md at its next session;
              // steering it now would start a turn in every idle child.
              if (input.options.rule && !isActive(member.thread.status)) {
                return {
                  id: member.thread.id,
                  ok: true,
                  state: "skipped",
                  detail: `${taskKey}  ${label}  idle; CREW.md applies from its next session`,
                  data: { task: taskKey, role: label },
                };
              }
              const owed =
                member.crewRole !== null && !member.crewRole.contractSent && member.role !== null;
              const body =
                owed && member.role !== null
                  ? `${adoptionContract(deps, captain, member.role, taskKey)}\n\n---\n\n${text}`
                  : text;
              try {
                await steer(deps.bb, member.thread.id, body);
              } catch (error) {
                return {
                  id: member.thread.id,
                  ok: false,
                  state: "failed",
                  detail: `${taskKey}  ${label}  ${(error as Error).message}`,
                };
              }
              if (owed) deps.store.setContractSent(member.thread.id);
              // A rule broadcast owes no report; any other tell does, from now.
              if (!input.options.rule) markReportDue(deps, captain.threadId, member);
              return {
                id: member.thread.id,
                ok: true,
                state: "told",
                detail: `${taskKey}  ${label}${owed ? "  with contract" : ""}`,
                data: { task: taskKey, role: label, contractSent: owed },
              };
            }),
          )),
        );
        return render(items, json, notes);
      });
    },
  });
}

/** The crew threads a tell reaches, deduplicated; unresolved targets become blockers. */
function pick(
  crew: readonly CrewThread[],
  targets: readonly string[],
  role: Role | null,
  all: boolean,
  blockers: Blocker[],
): CrewThread[] {
  const chosen = new Map<string, CrewThread>();
  const withRole = (member: CrewThread) => role === null || member.role === role;
  if (all) for (const member of crew.filter(withRole)) chosen.set(member.thread.id, member);
  for (const raw of targets) {
    const target = raw.trim();
    if (THREAD_ID.test(target)) {
      const member = crew.find((entry) => entry.thread.id === target);
      if (member === undefined) {
        blockers.push({
          reason: `${target} is not live crew of this Captain`,
          fix: "bb captain status --all",
        });
      } else chosen.set(member.thread.id, member);
      continue;
    }
    const key = target.toUpperCase();
    const members = crewOnTask(crew, key, role ?? undefined);
    if (members.length === 0) {
      const label = role === null ? "" : `${ROLE_SPECS[role].label} `;
      blockers.push({
        reason: `${key} has no live ${label}crew thread`,
        fix: `bb captain dispatch ${key} --role ${role === null ? "<role>" : ROLE_SPECS[role].label}`,
      });
    }
    for (const member of members) chosen.set(member.thread.id, member);
  }
  return [...chosen.values()];
}

/** Append a rule to CREW.md once: a rerun with the same text appends nothing. */
function appendRule(driveDir: string, rule: string): Item {
  mkdirSync(driveDir, { recursive: true });
  const path = join(driveDir, "CREW.md");
  // Read the disk, not the Drive cache: this read decides a write.
  const current = readFileSync(path, { encoding: "utf8", flag: "a+" });
  const line = `- ${rule.replace(/\n/gu, "\n  ")}`;
  if (current.includes(line))
    return { id: "CREW.md", ok: true, state: "kept", detail: "rule already there" };
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  // Appending, not rewriting, so two tells never drop each other's rule.
  appendFileSync(path, `${separator}${line}\n`);
  return { id: "CREW.md", ok: true, state: "appended", detail: rule.split("\n")[0] ?? "" };
}

function markReportDue(deps: CommandDeps, captainId: string, member: CrewThread): void {
  const now = deps.now();
  if (member.crewRole !== null) {
    deps.store.setReportDue(member.thread.id, now);
    return;
  }
  // A child with no row yet: backfill it from its preset's role, when it names one.
  if (member.role !== null) {
    deps.store.ensureCrewRole({
      threadId: member.thread.id,
      captainId,
      role: member.role,
      reportDueSince: now,
      contractSent: true,
    });
  }
}
