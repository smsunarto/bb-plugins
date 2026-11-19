/**
 * Crew models: each dispatched role's model ladder, in Captain's settings.
 * Each rung's provider, model and reasoning come from bb's own picker, so the
 * choices are what the provider lists. Every edit saves at once.
 */
import {
  experimental_Icon as Icon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { useCallback } from "react";
import { MAX_RUNGS, type LadderRole, type Rung } from "../contract/ladder.ts";
import { captainContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import { cn } from "./lib/utils.ts";

const NO_INPUT = {};
/** A phone or touch screen gets 44px targets, Apple's minimum. */
const TOUCH = "max-md:size-11 pointer-coarse:size-11";

type RoleLadder = {
  role: LadderRole;
  label: string;
  rungs: Rung[];
  custom: boolean;
  defaults: Rung[];
};

export function CrewModelsSettings() {
  const ladders = useRpcQuery({ contract: captainContract, method: "ladders", input: NO_INPUT });
  const save = useRpcMutation({
    contract: captainContract,
    method: "setLadder",
    optimistic({ role, rungs }, cache) {
      cache.update("ladders", NO_INPUT, (current) => ({
        roles: current.roles.map((entry) =>
          entry.role === role
            ? { ...entry, rungs: rungs ?? entry.defaults, custom: rungs !== null }
            : entry,
        ),
      }));
    },
  });
  const { mutate } = save;
  const write = useCallback(
    (role: LadderRole, rungs: Rung[] | null) => {
      mutate({ role, rungs }).catch(() => {});
    },
    [mutate],
  );

  if (ladders.data === undefined) {
    return (
      <div className="flex flex-col gap-3" data-bb-plugin="captain" data-bb-plugin-scope-captain="">
        {ladders.error === null ? (
          [0, 1, 2].map((index) => (
            <div key={index} className="h-24 animate-pulse rounded-md bg-muted" />
          ))
        ) : (
          <p className="text-sm text-destructive">Ladders not loaded: {ladders.error.message}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-bb-plugin="captain" data-bb-plugin-scope-captain="">
      <p className="text-sm text-muted-foreground">
        Crew start on the first rung whose provider has a ready Account Pooler account. A crew
        thread that hits a rate limit before it reports restarts on the next rung.
      </p>
      {ladders.data.roles.map((entry) => (
        <RoleSection key={entry.role} ladder={entry} onChange={write} />
      ))}
      {save.error === null ? null : (
        <p className="text-sm text-destructive">Not saved: {save.error.message}</p>
      )}
    </div>
  );
}

function RoleSection({
  ladder,
  onChange,
}: {
  ladder: RoleLadder;
  onChange: (role: LadderRole, rungs: Rung[] | null) => void;
}) {
  const { role, rungs } = ladder;
  const set = (next: Rung[]) => onChange(role, next);
  const move = (from: number, to: number) => {
    const next = [...rungs];
    const [rung] = next.splice(from, 1);
    if (rung === undefined) return;
    next.splice(to, 0, rung);
    set(next);
  };
  return (
    <section className="flex flex-col gap-2" aria-label={`${ladder.label} ladder`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{ladder.label}</h3>
        <span className="text-xs text-muted-foreground">
          {ladder.custom ? "custom" : "default"}
        </span>
        {ladder.custom ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto max-md:min-h-11 pointer-coarse:min-h-11"
            onClick={() => onChange(role, null)}
          >
            Reset to default
          </Button>
        ) : null}
      </header>
      <ol className="@container flex flex-col rounded-md border">
        {rungs.map((rung, index) => (
          <li
            key={index}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-2 py-1.5 first:border-t-0"
          >
            <span className="order-1 w-14 shrink-0 text-xs text-muted-foreground tabular-nums">
              Rung {index + 1}
            </span>
            <div className="order-3 min-w-0 basis-full @xl:order-2 @xl:flex-1 @xl:basis-auto">
              <ProviderModelPicker
                value={toPicker(rung)}
                onChange={(value) =>
                  set(rungs.map((entry, at) => (at === index ? fromPicker(value) : entry)))
                }
              />
            </div>
            <div className="order-2 ml-auto flex shrink-0 items-center @xl:order-3">
              <Button
                variant="ghost"
                size="icon"
                className={TOUCH}
                aria-label={`Move rung ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
              >
                <Icon name="ChevronUp" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={TOUCH}
                aria-label={`Move rung ${index + 1} down`}
                disabled={index === rungs.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <Icon name="ChevronDown" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={TOUCH}
                aria-label={`Remove rung ${index + 1}`}
                disabled={rungs.length === 1}
                onClick={() => set(rungs.filter((_, at) => at !== index))}
              >
                <Icon name="X" aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        className={cn("self-start max-md:min-h-11 pointer-coarse:min-h-11")}
        disabled={rungs.length >= MAX_RUNGS}
        onClick={() => {
          const last = rungs.at(-1);
          if (last !== undefined) set([...rungs, { ...last }]);
        }}
      >
        <Icon name="Plus" aria-hidden />
        Add rung
      </Button>
    </section>
  );
}

function toPicker(rung: Rung): ExperimentalProviderModelPickerValue {
  return {
    providerId: rung.providerId,
    model: rung.model,
    reasoningLevel: rung.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(rung.serviceTier === undefined
      ? {}
      : {
          serviceTier: rung.serviceTier as NonNullable<
            ExperimentalProviderModelPickerValue["serviceTier"]
          >,
        }),
  };
}

function fromPicker(value: ExperimentalProviderModelPickerValue): Rung {
  return {
    providerId: value.providerId,
    model: value.model,
    reasoningLevel: value.reasoningLevel,
    ...(value.serviceTier === undefined || value.serviceTier === "default"
      ? {}
      : { serviceTier: value.serviceTier }),
  };
}
