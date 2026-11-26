import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { formFields } from "../../core/form";
import type { PropsOf } from "../../core/types";
import { Button as BaseButton } from "@/components/ui/button";
import { FieldSet } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { deferAnswer, flushAnswers } from "../answerSheet";
import { RenderNodes } from "../render";
import { NodeKeyContext, questionClosed, sentFor, useAnswers, UiRuntimeContext, useUiRuntime, type UiRuntime } from "../runtime";
import { actionIntent } from "./action-logic";
import { FormValidationContext } from "./fieldValidation";
import { ActionGlyph, ActionHint, InMessageLine, SentLine } from "./inputs";

/**
 * Disabled fields keep their values legible: no UA graying (Safari dims
 * disabled text fields and fills their text gray) and no pointer cursor.
 */
const READ_ONLY =
  "[&_:disabled]:cursor-default [&_input:disabled]:opacity-100 [&_select:disabled]:opacity-100 [&_textarea:disabled]:opacity-100 [&_input:disabled]:[-webkit-text-fill-color:currentColor] [&_textarea:disabled]:[-webkit-text-fill-color:currentColor]";

/** How long typing pauses before a text field's answer is staged. */
const TYPING_PAUSE_MS = 300;

/**
 * Fields stacked like a Stack, and one question: the user's first edit of
 * any field stages the whole Form in their message (a `Label: answer` line
 * per field, core/form.ts), and every later edit keeps it in step. There is
 * no submit: the user sends with the composer. Once sent, or once the thread
 * moved on, the fields stay visible read-only ("Sent" when it was sent).
 * Without a thread composer the Form keeps a Send button that posts it.
 */
export function Form({ props }: { props: PropsOf<"Form"> }) {
  const runtime = useUiRuntime();
  const { staged, sent, target, stage } = useAnswers();
  const question = useContext(NodeKeyContext);
  const fields = formFields(props.children);
  const invalidCount = fields.filter((field) => field.errors.length > 0).length;
  const message = fields.map((field) => field.line).join("\n");
  const closed = questionClosed(sent, question, runtime.superseded);
  const answered = sentFor(sent, question) !== null;
  const entry = staged.get(question);
  const [sending, setSending] = useState(false);
  const [showAllErrors, setShowAllErrors] = useState(false);
  // The user's edits of this Form's fields: the newest, and whether it was typed.
  const [edit, setEdit] = useState<{ readonly seq: number; readonly typed: boolean } | null>(null);
  const handled = useRef(0);
  const fieldNames = fields.map((field) => field.name).join("\n");
  const typedNames = fields.flatMap((field) => (field.typed ? [field.name] : [])).join("\n");
  const validation = useMemo(
    () => ({ showAll: showAllErrors, revealAll: () => setShowAllErrors(true) }),
    [showAllErrors],
  );

  useEffect(() => {
    if (invalidCount === 0 && showAllErrors) setShowAllErrors(false);
  }, [invalidCount, showAllErrors]);

  // The fields write through this runtime, so an edit inside the Form is seen here.
  const inner = useMemo<UiRuntime>(() => {
    const names = fieldNames.split("\n");
    const typed = typedNames.split("\n");
    const touched = (name: string) => {
      if (names.includes(name)) setEdit((previous) => ({ seq: (previous?.seq ?? 0) + 1, typed: typed.includes(name) }));
    };
    return {
      ...runtime,
      setValue(name, value) {
        runtime.setValue(name, value);
        touched(name);
      },
      async run(actions) {
        await runtime.run(actions);
        for (const action of actions) if (action.type === "set") touched(action.name);
      },
    };
  }, [runtime, fieldNames, typedNames]);

  // Only the user's own edit of a field stages the Form: never the sheet's entry differing from it (another window, a deleted block).
  // While any field fails declarative `checks:`, staging is held back and any previously staged answer is withdrawn until fixed.
  useEffect(() => {
    if (closed || target === "direct" || message === "" || edit === null) return;
    if (invalidCount > 0) {
      if (entry !== undefined) void stage(question, null);
      return;
    }
    if (edit.seq <= handled.current) return;
    const seq = edit.seq;
    let done = false;
    const apply = () => {
      if (done) return;
      done = true;
      handled.current = seq;
      void stage(question, { text: message, selection: true });
    };
    // A click (a box, a choice) shows in the message at once; typing waits for a pause,
    // or less: leaving the field, Enter or a press anywhere (BB's send button) write it first.
    if (!edit.typed) {
      apply();
      return;
    }
    const timer = setTimeout(apply, TYPING_PAUSE_MS);
    const release = deferAnswer(apply);
    return () => {
      clearTimeout(timer);
      release();
    };
  }, [closed, target, message, invalidCount, entry, edit, question, stage]);
  return (
    <FieldSet
      data-genui-question={question}
      disabled={sending || closed}
      onBlur={flushAnswers}
      className={`m-0 gap-4 ${READ_ONLY}`}
    >
      <FormValidationContext value={validation}>
        <UiRuntimeContext value={inner}>
          <RenderNodes nodes={props.children} />
        </UiRuntimeContext>
      </FormValidationContext>
      {answered ? (
        <SentLine text={null} />
      ) : closed ? null : target === "direct" ? (
        // The hint quotes the answers the button posts: one line per field.
        <div className="flex min-w-0 flex-col gap-2">
          {showAllErrors && invalidCount > 0 ? (
            <FormValidationNotice count={invalidCount} revealed />
          ) : null}
          <ActionHint hint={actionIntent([{ kind: "action", type: "send", text: message }], { send: "send" }).hint}>
            <BaseButton
              type="button"
              size="sm"
              disabled={sending || message === ""}
              aria-busy={sending || undefined}
              onClick={async () => {
                if (invalidCount > 0) {
                  setShowAllErrors(true);
                  return;
                }
                setSending(true);
                await stage(question, { text: message, selection: true });
                setSending(false);
              }}
              className="w-fit max-w-full gap-1 text-[13px]"
            >
              Send
              <ActionGlyph name="Sent" />
            </BaseButton>
          </ActionHint>
        </div>
      ) : entry !== undefined ? (
        <InMessageLine />
      ) : edit !== null && invalidCount > 0 ? (
        <FormValidationNotice
          count={invalidCount}
          revealed={showAllErrors}
          onReveal={() => setShowAllErrors(true)}
        />
      ) : null}
    </FieldSet>
  );
}

function FormValidationNotice({
  count,
  revealed,
  onReveal,
}: {
  count: number;
  revealed: boolean;
  onReveal?: () => void;
}) {
  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs leading-4 text-destructive"
    >
      <Icon name="AlertTriangle" aria-hidden className="size-3.5 shrink-0" />
      <span>
        {count === 1
          ? "1 field needs attention before adding to your message"
          : `${count} fields need attention before adding to your message`}
      </span>
      {revealed || onReveal === undefined ? null : (
        <button
          type="button"
          onClick={onReveal}
          className="cursor-pointer font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Show
        </button>
      )}
    </div>
  );
}
