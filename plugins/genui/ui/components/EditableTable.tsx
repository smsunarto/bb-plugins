// An editable table over a list-of-objects state: typed cells, add and remove
// rows. A table where the UI has room, one card per row on a phone (a
// container query, so a narrow pane gets cards too). Totals are the spec's:
// it reads the same state. The rules live in choose-logic.ts.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { Value } from "../../core/types";
import { Button as BaseButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useUiRuntime } from "../runtime";
import { isBinding, optionalText, text, type Props } from "../values";
import {
  blankRow,
  parseNumberInput,
  setCell,
  tableColumns,
  tableRows,
  type ColumnType,
  type TableColumn,
  type TableRow,
} from "./choose-logic";
import { CheckMark, ErrorLine } from "./display";
import { CAPTION, FIELD, FOCUS_RING } from "./inputs";
import { RISE, useEntrance } from "./motion";

/**
 * Grid track per column type in the table layout; the last track holds the
 * remove button. Small minimums, so many columns narrow their fields instead
 * of overflowing the frame.
 */
const TRACK: Record<ColumnType, string> = {
  text: "minmax(4rem,2fr)",
  number: "minmax(3.5rem,1fr)",
  boolean: "minmax(2.5rem,0.6fr)",
};

const ALIGN: Record<ColumnType, string> = {
  text: "",
  number: "text-right",
  boolean: "text-center",
};

export function EditableTable({ props }: { props: Props }) {
  const { setValue } = useUiRuntime();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  // Where focus goes after the next render: a new row's first field, or the
  // control that takes a removed row's place.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const selector = pendingFocus.current;
    if (selector === null) return;
    pendingFocus.current = null;
    root.current?.querySelector<HTMLElement>(selector)?.focus();
  });
  const binding = props.value;
  if (!isBinding(binding)) return <ErrorLine message="EditableTable needs a $state binding" />;
  const rows = tableRows(binding.value);
  if (rows === null) return <ErrorLine message="EditableTable rows must be objects, one per row" />;
  if (!Array.isArray(props.columns)) return <ErrorLine message="EditableTable columns must be a list" />;
  const columns = tableColumns(props.columns, rows);
  if (columns.length === 0) return null;
  const label = optionalText(props.label);
  const name = label ?? binding.name;
  const grid = { "--cols": [...columns.map((column) => TRACK[column.type]), "2rem"].join(" ") } as CSSProperties;

  const add = () => {
    pendingFocus.current = `[data-row="${rows.length}"] [data-field]`;
    setValue(binding.name, [...rows, blankRow(columns)]);
  };
  const remove = (index: number) => {
    pendingFocus.current = index < rows.length - 1 ? `[data-row="${index}"] [data-remove]` : "[data-add]";
    setValue(
      binding.name,
      rows.filter((_, position) => position !== index),
    );
  };

  return (
    <div ref={root} className="@container flex min-w-0 flex-col gap-1.5">
      {label === null ? null : (
        <span id={`${id}-label`} className={CAPTION}>
          {label}
        </span>
      )}
      {rows.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          No rows yet
        </p>
      ) : (
        <div
          role="table"
          aria-labelledby={label === null ? undefined : `${id}-label`}
          aria-label={label === null ? binding.name : undefined}
          style={grid}
          className="flex min-w-0 flex-col gap-2 @lg:gap-0"
        >
          <div
            role="row"
            className="hidden min-w-0 gap-2 border-b border-border pb-2 @lg:grid @lg:[grid-template-columns:var(--cols)]"
          >
            {columns.map((column) => (
              <span
                key={column.key}
                role="columnheader"
                className={cn("truncate px-0.5 text-xs font-medium text-muted-foreground", ALIGN[column.type])}
              >
                {column.label}
              </span>
            ))}
            <span role="columnheader">
              <span className="sr-only">Remove</span>
            </span>
          </div>
          {rows.map((row, index) => (
            <EditableRow
              // Rows are positional: a state row has no identity of its own.
              key={index}
              id={`${id}-${index}`}
              index={index}
              row={row}
              columns={columns}
              tableName={name}
              onChange={(key, value) => setValue(binding.name, setCell(rows, index, key, value))}
              onRemove={() => remove(index)}
            />
          ))}
        </div>
      )}
      <BaseButton
        type="button"
        size="sm"
        variant="ghost"
        data-add=""
        onClick={add}
        className="-ml-2 w-fit gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <Icon name="Plus" aria-hidden className="size-3.5" />
        Add row
      </BaseButton>
    </div>
  );
}

function EditableRow({
  id,
  index,
  row,
  columns,
  tableName,
  onChange,
  onRemove,
}: {
  id: string;
  index: number;
  row: TableRow;
  columns: readonly TableColumn[];
  tableName: string;
  onChange: (key: string, value: Value) => void;
  onRemove: () => void;
}) {
  const rise = useEntrance<HTMLDivElement>(RISE);
  return (
    <div
      ref={rise}
      role="row"
      data-row={index}
      className="relative grid min-w-0 grid-cols-1 gap-2 rounded-lg bg-surface-recessed py-3 pl-3 pr-10 @lg:items-center @lg:rounded-none @lg:border-b @lg:border-border/60 @lg:bg-transparent @lg:px-0 @lg:py-1.5 @lg:[grid-template-columns:var(--cols)] @lg:last:border-b-0"
    >
      {columns.map((column, position) => {
        const field = `${id}-${position}`;
        const cell = Object.hasOwn(row, column.key) ? row[column.key] : null;
        return (
          <div
            key={column.key}
            role="cell"
            className="grid min-w-0 grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] items-center gap-3 @lg:block"
          >
            <label htmlFor={field} className="truncate text-xs leading-5 text-muted-foreground @lg:sr-only">
              {column.label}
            </label>
            <CellField
              id={field}
              type={column.type}
              value={cell}
              name={`${column.label}, row ${index + 1}`}
              onChange={(value) => onChange(column.key, value)}
            />
          </div>
        );
      })}
      <div role="cell" className="absolute right-2 top-2.5 @lg:static @lg:flex @lg:justify-center">
        <button
          type="button"
          data-remove=""
          aria-label={`Remove row ${index + 1} of ${tableName}`}
          onClick={onRemove}
          className={cn(
            "flex size-7 cursor-pointer touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-surface-recessed hover:text-foreground motion-reduce:transition-none",
            FOCUS_RING,
          )}
        >
          <Icon name="X" aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function CellField({
  id,
  type,
  value,
  name,
  onChange,
}: {
  id: string;
  type: ColumnType;
  value: Value;
  name: string;
  onChange: (value: Value) => void;
}) {
  if (type === "number") return <NumberField id={id} value={value} name={name} onChange={onChange} />;
  if (type === "boolean") {
    const checked = value === true;
    return (
      // Narrow, the box lines up with the fields' left edge; in the table it is centered.
      <span className="-ml-1.5 flex h-8 items-center @lg:ml-0 @lg:justify-center">
        <button
          id={id}
          type="button"
          role="checkbox"
          data-field=""
          aria-checked={checked}
          aria-label={name}
          onClick={() => onChange(!checked)}
          className={cn(
            "flex size-7 cursor-pointer touch-manipulation items-center justify-center rounded-md transition-colors duration-150 hover:bg-surface-recessed motion-reduce:transition-none",
            FOCUS_RING,
          )}
        >
          <span
            aria-hidden
            className={cn(
              "flex size-4 items-center justify-center rounded-[4px] border transition-colors duration-150 motion-reduce:transition-none",
              checked ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-background",
            )}
          >
            {checked ? <CheckMark className="size-3" /> : null}
          </span>
        </button>
      </span>
    );
  }
  return (
    <input
      id={id}
      type="text"
      data-field=""
      value={text(value)}
      aria-label={name}
      autoComplete="off"
      enterKeyHint="next"
      onChange={(event) => onChange(event.currentTarget.value)}
      className={cn(FIELD, "px-2")}
    />
  );
}

/**
 * A number cell with a decimal keyboard. What is typed stays as typed while
 * the field has focus; every readable value is written at once (empty is
 * null), so the spec's totals follow keystroke by keystroke.
 */
function NumberField({
  id,
  value,
  name,
  onChange,
}: {
  id: string;
  value: Value;
  name: string;
  onChange: (value: Value) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const invalid = draft !== null && parseNumberInput(draft) === undefined;
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      data-field=""
      value={draft ?? text(value)}
      aria-label={name}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      enterKeyHint="next"
      onChange={(event) => {
        const typed = event.currentTarget.value;
        setDraft(typed);
        const parsed = parseNumberInput(typed);
        if (parsed !== undefined) onChange(parsed);
      }}
      onBlur={() => setDraft(null)}
      className={cn(FIELD, "px-2 text-right tabular-nums", invalid && "border-destructive/60")}
    />
  );
}
