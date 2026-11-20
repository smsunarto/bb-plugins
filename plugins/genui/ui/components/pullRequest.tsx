// Local (bb-plugins): the retired PullRequest(refs), kept so replies written
// before 2026-11-15 still show. Each ref is a link; the one that is this
// thread's pull request also shows Source Control's state and status line,
// read from its `statusForThread` row (watched, so Source Control reads it
// again when it hasn't lately). Other refs stay plain links: Source Control
// knows pull requests by thread, not by number.
import { experimental_useRpcKeyedQuery as useRpcKeyedQuery, UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { PR_STATE_LABEL } from "../../core/project";
import {
  parsePullRequestRef,
  parseThreadStatuses,
  samePullRequest,
  SOURCE_CONTROL_PLUGIN_ID,
  type ThreadPullRequest,
} from "../../core/sourceControl";
import type { PropsOf } from "../../core/types";
import { sourceControlContract } from "../../source-control-contract";
import { useUiRuntime } from "../runtime";
import { STATE_ICON, STATE_TEXT } from "./environments";
import { CAPTION, FOCUS_RING } from "./inputs";

interface Item {
  readonly text: string;
  readonly url: string | null;
  /** Source Control's row for it, when it is this thread's pull request. */
  readonly status: { readonly pullRequest: ThreadPullRequest; readonly line: string } | null;
}

export function PullRequest({ props }: { props: PropsOf<"PullRequest"> }) {
  const { threadId } = useUiRuntime();
  const rows = useRpcKeyedQuery({
    pluginId: SOURCE_CONTROL_PLUGIN_ID,
    contract: sourceControlContract,
    method: "statusForThread",
    keys: threadId === null ? [] : [threadId],
    enabled: threadId !== null,
  });
  const row = threadId === null || rows.data === undefined ? undefined : parseThreadStatuses(rows.data)[threadId];
  const own = row?.state === "change" && row.pullRequest !== null ? { pullRequest: row.pullRequest, line: row.line } : null;
  const refs = (props.refs ?? []).filter((ref): ref is string => typeof ref === "string");
  const items: Item[] = refs.map((text) => {
    const ref = parsePullRequestRef(text);
    if (ref === null) return { text, url: null, status: null };
    const status = own !== null && samePullRequest(ref, own.pullRequest) ? own : null;
    return { text: `${ref.owner}/${ref.repo}#${ref.number}`, url: ref.url, status };
  });
  if (items.length === 0 && own !== null) items.push({ text: `#${own.pullRequest.number} ${own.pullRequest.title}`, url: own.pullRequest.url, status: own });
  if (items.length === 0) return <p className={CAPTION}>Pull request: see this thread's Source Control card</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={cn(CAPTION, "font-medium")}>{items.length === 1 ? "Pull request" : "Pull requests"}</span>
      <ul className="flex min-w-0 flex-col gap-1 text-[13px]">
        {items.map((item, index) => (
          <li key={index} className="flex min-w-0 flex-wrap items-center gap-x-2">
            {item.url === null ? (
              <span className="min-w-0 [overflow-wrap:anywhere]">{item.text}</span>
            ) : (
              <UrlLink href={item.url} className={cn("min-w-0 rounded-sm [overflow-wrap:anywhere]", FOCUS_RING)}>
                {item.text}
              </UrlLink>
            )}
            {item.status === null ? null : (
              <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={item.status.pullRequest.title}>
                <Icon name={STATE_ICON[item.status.pullRequest.state]} aria-hidden className={cn("size-3.5 shrink-0", STATE_TEXT[item.status.pullRequest.state])} />
                {PR_STATE_LABEL[item.status.pullRequest.state]} · {item.status.line}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
