import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { formFields } from "../../core/form";
import { Button as BaseButton } from "@/components/ui/button";
import { deferAnswer, flushAnswers } from "../answerSheet";
import { RenderNodes } from "../render";
import { NodeKeyContext, questionClosed, sentFor, useAnswers, UiRuntimeContext, useUiRuntime, type UiRuntime } from "../runtime";
import { nodes, type Props } from "../values";
import { actionIntent } from "./action-logic";
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
export function Form({ props }: { props: Props }) {
  const runtime = useUiRuntime();
  const { staged, sent, target, stage } = useAnswers();
  const question = useContext(NodeKeyContext);
  const fields = formFields({ kind: "node", type: "Form", key: question, props });
  const message = fields.map((field) => field.line).join("\n");
  const closed = questionClosed(sent, question, runtime.superseded);
  const answered = sentFor(sent, question) !== null;
  const entry = staged.get(question);
  const [sending, setSending] = useState(false);
  // The user's edits of this Form's fields: the newest, and whether it was typed.
  const [edit, setEdit] = useState<{ readonly seq: number; readonly typed: boolean } | null>(null);
  const handled = useRef(0);
  const fieldNames = fields.map((field) => field.name).join("\n");
  const typedNames = fields.flatMap((field) => (field.typed ? [field.name] : [])).join("\n");

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
  useEffect(() => {
    if (closed || target === "direct" || message === "" || edit === null || edit.seq <= handled.current) return;
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
  }, [closed, target, message, edit, question, stage]);
  return (
    <fieldset
      data-genui-question={question}
      disabled={sending || closed}
      onBlur={flushAnswers}
      className={`m-0 flex min-w-0 flex-col gap-4 border-0 p-0 ${READ_ONLY}`}
    >
      <UiRuntimeContext value={inner}>
        <RenderNodes nodes={nodes(props.children)} />
      </UiRuntimeContext>
      {answered ? (
        <SentLine text={null} />
      ) : closed ? null : target === "direct" ? (
        // The hint quotes the answers the button posts: one line per field.
        <ActionHint hint={actionIntent([{ kind: "action", type: "send", text: message }], { send: "send" }).hint}>
          <BaseButton
            type="button"
            size="sm"
            disabled={sending || message === ""}
            aria-busy={sending || undefined}
            onClick={async () => {
              setSending(true);
              await stage(question, { text: message, selection: true });
              setSending(false);
            }}
            className="w-fit max-w-full gap-1.5 text-[13px]"
          >
            Send
            <ActionGlyph name="Sent" />
          </BaseButton>
        </ActionHint>
      ) : entry !== undefined ? (
        <InMessageLine />
      ) : null}
    </fieldset>
  );
}
