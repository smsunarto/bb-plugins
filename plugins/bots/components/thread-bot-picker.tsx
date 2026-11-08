import { useState } from "react";
import {
  experimental_DetailRow as DetailRow,
  experimental_InfoSection as InfoSection,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadInfoProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { BOTS_PLUGIN_ID, rpcContract, type ThreadBot } from "../contract";
import { useBotsRpc } from "../lib/rpc";
import { BotIcon } from "./bot-icon";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from "./ui/select";
import { cn } from "../lib/utils";

import { ClampedText, ResourceCard } from "./resource-card";
import { ThreadBotResources } from "./thread-bot-resources";

const NONE = "__no_bot__";

/** The toast for a bot change, naming the bot and how many children moved with it. */
export function announceBotChange(botName: string | null, threadIds: readonly string[]) {
  if (!threadIds.length) return;
  const extra =
    threadIds.length > 1
      ? ` with ${threadIds.length - 1} child conversation${threadIds.length === 2 ? "" : "s"}`
      : "";
  toast.success(botName ? `Moved to ${botName}${extra}` : `Removed from bot${extra}`);
}

/** Which bot a thread belongs to, kept live by the server's bots invalidation. */
function useThreadBot(threadId: string) {
  const rpc = useBotsRpc();
  const { data: value } = useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "thread_bot",
    input: { threadId },
  });
  const [pending, setPending] = useState(false);
  const choose = async (botId: string | null) => {
    setPending(true);
    try {
      const result = await rpc.call("conversation_set_bot", { threadId, botId });
      announceBotChange(
        botId ? (value?.bots.find((bot) => bot.id === botId)?.name ?? "bot") : null,
        result.threadIds,
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return { value, pending, choose };
}

function NoBotGlyph({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="shrink-0 opacity-60"
    >
      <rect x="4" y="6" width="12" height="10" rx="3" strokeDasharray="2.2 2" />
      <path d="M10 6V3.5" />
    </svg>
  );
}

function ThreadBotSelect({ threadId }: { threadId: string }) {
  const { value, pending, choose } = useThreadBot(threadId);
  if (!value) return null;
  const current = value.bots.find((bot) => bot.id === value.botId) ?? null;
  const size = 14;
  const label = current ? current.name : "No bot";
  const visible = value.bots.filter((bot) => !bot.hidden || bot.id === value.botId);
  const hidden = value.bots.filter((bot) => bot.hidden && bot.id !== value.botId);
  const item = (bot: ThreadBot["bots"][number]) => (
    <SelectItem key={bot.id} value={bot.id} className="text-xs">
      <span className="flex min-w-0 items-center gap-2">
        <BotIcon avatar={bot.avatar} size={16} />
        <span className="truncate">{bot.name}</span>
        {bot.role ? (
          <>
            <span className="sr-only">, </span>
            <span className="truncate text-muted-foreground">{bot.role}</span>
          </>
        ) : null}
      </span>
    </SelectItem>
  );
  return (
    <Select
      value={value.botId ?? NONE}
      disabled={pending}
      onValueChange={(next) => {
        void choose(next === NONE ? null : next);
      }}
    >
      <SelectTrigger
        aria-label={current ? `Bot: ${current.name}. Change bot` : "No bot. Assign to a bot"}
        title={
          current
            ? `${current.name}${value.explicit ? "" : " (inherited from the parent conversation)"}`
            : value.detached
              ? "Removed from its bot"
              : "Not assigned to a bot"
        }
        className={cn(
          "thread-bot-trigger w-auto max-w-[14rem] gap-1.5 border-0 bg-transparent shadow-none focus:ring-0 focus-visible:ring-1 [&>svg:last-child]:size-3.5",
          "h-auto min-h-0 rounded-sm p-0 text-sm text-foreground hover:underline hover:underline-offset-2",
          !current && "text-muted-foreground",
        )}
      >
        {/* A div: the trigger line-clamps direct span children, which breaks flex. */}
        <div className="flex min-w-0 items-center gap-1.5">
          {current ? (
            <BotIcon avatar={current.avatar} size={size} label={current.name} />
          ) : (
            <NoBotGlyph size={size} />
          )}
          <div className="truncate">{label}</div>
        </div>
      </SelectTrigger>
      <SelectContent align="start" className="min-w-[12rem]">
        <SelectItem value={NONE} className="text-xs">
          <span className="flex items-center gap-2 text-muted-foreground">
            <NoBotGlyph size={16} />
            No bot
          </span>
        </SelectItem>
        {visible.length ? <SelectSeparator /> : null}
        {visible.map(item)}
        {hidden.length ? (
          <>
            <SelectSeparator />
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Hidden
            </div>
            {hidden.map(item)}
          </>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/** Thread Info tab: the bot beside BB's own Parent row. */
export function ThreadBotInfoRow({ threadId }: ExperimentalThreadInfoProps) {
  return (
    <DetailRow label="Bot" icon="Bot">
      <ThreadBotSelect threadId={threadId} />
    </DetailRow>
  );
}

/** What the thread's bot adds to the agent's system prompt, kept live like the picker. */
function useThreadBotPrompt(threadId: string) {
  return useRpcQuery({
    contract: rpcContract,
    pluginId: BOTS_PLUGIN_ID,
    method: "thread_bot_prompt",
    input: { threadId },
  }).data;
}

function PromptBlock({ title, text }: { title: string; text: string }) {
  return (
    <ResourceCard title={title} meta={`${text.length.toLocaleString()} chars`}>
      <ClampedText
        text={text}
        className="whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.6] text-muted-foreground"
      />
    </ResourceCard>
  );
}

/** Thread Info tab: the system-prompt additions from the thread's bot, one card per block. */
export function ThreadBotPromptSection({ threadId }: ExperimentalThreadInfoProps) {
  const value = useThreadBotPrompt(threadId);
  if (!value?.botId) return null;
  return (
    <>
      <ThreadBotResources key={value.botId} botId={value.botId} />
      <InfoSection label="Bot prompt">
        <div className="flex flex-col gap-2">
          {value.sections.map((section) => (
            <PromptBlock key={section.id} title={section.title} text={section.text} />
          ))}
          <p className="mt-1 text-[11px] leading-[1.55] text-muted-foreground text-pretty [overflow-wrap:anywhere]">
            Tools: {value.tools.join(", ")} · Skill: {value.skills.join(", ")}
          </p>
        </div>
      </InfoSection>
    </>
  );
}
