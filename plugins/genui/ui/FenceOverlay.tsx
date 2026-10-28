// Fallback for BB versions without the code-fence renderer slot: a thread-scoped
// overlay finds the ```ui and ```app code blocks BB rendered in assistant
// replies, hides each one, and portals a Fence into a node placed just before
// it. The header slot supplies the owning thread navigation context without
// rendering a header control. Anywhere the overlay is not running the block
// stays readable code.
import { useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import { Fence, useThreadActions, type FenceLanguage, type ThreadActions } from "./Fence";

/** BB renders a fence as `div > pre > code.language-<lang>` inside a timeline row. */
const FENCE_CODE = "[data-timeline-row-id] pre > code.language-ui, [data-timeline-row-id] pre > code.language-app";
const ROW = "[data-timeline-row-id]";
const MOUNT_ATTRIBUTE = "data-genui-fence";
const HIDDEN_ATTRIBUTE = "data-genui-hidden";
/**
 * The overlay cannot see whether the closing fence arrived, so a block counts
 * as complete once its text has stopped changing for this long.
 */
const SETTLE_MS = 1500;

interface FenceBlock {
  /** Stable while the message re-renders: `<row id>#<language>#<index among that language>`. */
  key: string;
  language: FenceLanguage;
  threadId: string;
  /** The assistant reply's timeline row id, which is also its BB message id. */
  messageId: string;
  /** Its index among the message's blocks of its language. */
  index: number;
  code: string;
  mount: HTMLElement;
}

function restore(wrapper: Element): void {
  if (wrapper instanceof HTMLElement && wrapper.hasAttribute(HIDDEN_ATTRIBUTE)) {
    wrapper.removeAttribute(HIDDEN_ATTRIBUTE);
    wrapper.style.removeProperty("display");
  }
}

/**
 * Reconciles the DOM with the previous scan: every fence in an assistant row
 * gets a mount node right before its (hidden) code block. Returns the previous
 * map unchanged when nothing moved or grew, and whether a block appeared.
 */
function scan(
  previous: ReadonlyMap<string, FenceBlock>,
  pluginId: string,
  threadId: string,
): { blocks: ReadonlyMap<string, FenceBlock>; appeared: boolean } {
  const next = new Map<string, FenceBlock>();
  const counts = new Map<string, number>();
  let changed = false;
  let appeared = false;
  for (const code of document.querySelectorAll(FENCE_CODE)) {
    const row = code.closest(ROW);
    const wrapper = code.parentElement?.parentElement;
    const rowId = row?.getAttribute("data-timeline-row-id") ?? "";
    // Only the assistant's replies, never user messages or tool output.
    if (row === null || wrapper == null || !rowId.startsWith(`${threadId}:`) || !rowId.includes(":assistant:")) continue;
    const language: FenceLanguage = code.classList.contains("language-app") ? "app" : "ui";
    const counter = `${rowId}#${language}`;
    const index = counts.get(counter) ?? 0;
    counts.set(counter, index + 1);
    const key = `${counter}#${index}`;
    const text = code.textContent ?? "";
    const known = previous.get(key);
    const mount = known?.mount ?? document.createElement("div");
    mount.setAttribute(MOUNT_ATTRIBUTE, "");
    mount.setAttribute("data-genui-renderer", "overlay");
    // BB scopes plugin CSS to `[data-bb-plugin=<id>]` subtrees; a portal into
    // BB's own DOM is outside every plugin root unless it declares one.
    mount.setAttribute("data-bb-plugin", pluginId);
    if (wrapper.previousElementSibling !== mount) wrapper.before(mount);
    if (wrapper instanceof HTMLElement && !wrapper.hasAttribute(HIDDEN_ATTRIBUTE)) {
      wrapper.setAttribute(HIDDEN_ATTRIBUTE, "");
      wrapper.style.display = "none";
    }
    if (known === undefined) appeared = true;
    if (known === undefined || known.code !== text) changed = true;
    next.set(key, {
      key,
      language,
      threadId: rowId.slice(0, rowId.indexOf(":")),
      messageId: rowId,
      index,
      code: text,
      mount,
    });
  }
  for (const [key, block] of previous) {
    if (next.has(key)) continue;
    changed = true;
    block.mount.remove();
  }
  return { blocks: changed ? next : previous, appeared };
}

export function FenceOverlay({ threadId }: { threadId: string }) {
  const [blocks, setBlocks] = useState<ReadonlyMap<string, FenceBlock>>(() => new Map());
  const actions = useThreadActions();
  const pluginId = experimental_usePluginId();

  useEffect(() => {
    let current: ReadonlyMap<string, FenceBlock> = new Map();
    let timer: number | undefined;
    const commit = (blocks: ReadonlyMap<string, FenceBlock>) => {
      clearTimeout(timer);
      timer = undefined;
      current = blocks;
      // A block BB just laid out (a new reply, or a row its timeline remounted
      // while the user scrolls) renders in this same task, before the browser
      // paints: the row is measured once, with the UI in it, so the
      // conversation never moves under the reader.
      flushSync(() => setBlocks(blocks));
    };
    const run = () => {
      const { blocks, appeared } = scan(current, pluginId, threadId);
      if (blocks === current) return;
      if (appeared) commit(blocks);
      // Text streaming into a known block, or a block gone: at most every 60 ms.
      else timer ??= window.setTimeout(() => commit(scan(current, pluginId, threadId).blocks), 60);
    };
    const observer = new MutationObserver((records) => {
      // Our own renders mutate the page too; they never add or grow a block.
      const foreign = records.some((record) => {
        const node = record.target instanceof Element ? record.target : record.target.parentElement;
        return node?.closest(`[${MOUNT_ATTRIBUTE}]`) == null;
      });
      if (foreign) run();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    run();
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      for (const block of current.values()) block.mount.remove();
      for (const wrapper of document.querySelectorAll(`[${HIDDEN_ATTRIBUTE}]`)) {
        const rowId = wrapper.closest(ROW)?.getAttribute("data-timeline-row-id");
        if (rowId?.startsWith(`${threadId}:`)) restore(wrapper);
      }
    };
  }, [pluginId, threadId]);

  return [...blocks.values()].map((block) =>
    createPortal(<SettlingFence block={block} actions={actions} />, block.mount, block.key),
  );
}

/**
 * The text each block last settled on in this page. BB's timeline remounts
 * rows as the user scrolls back; a block whose text is unchanged is complete
 * at once instead of waiting out SETTLE_MS (an app would otherwise show
 * "Building app…" and then grow).
 */
const SETTLED = new Map<string, string>();

function SettlingFence({ block, actions }: { block: FenceBlock; actions: ThreadActions }) {
  const [settledCode, setSettledCode] = useState<string | null>(() =>
    SETTLED.get(block.key) === block.code ? block.code : null,
  );
  useEffect(() => {
    if (SETTLED.get(block.key) === block.code) {
      setSettledCode(block.code);
      return;
    }
    const timer = setTimeout(() => {
      SETTLED.set(block.key, block.code);
      setSettledCode(block.code);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [block.key, block.code]);
  return (
    <Fence
      language={block.language}
      code={block.code}
      complete={settledCode === block.code}
      stateKey={`bb.genui.state:${block.key}`}
      threadId={block.threadId}
      messageId={block.messageId}
      fence={block.index}
      actions={actions}
    />
  );
}
