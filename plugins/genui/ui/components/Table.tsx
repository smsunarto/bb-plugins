import type { ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { Value } from "../../core/types";
import { cn } from "@/lib/utils";
import { RenderNode } from "../render";
import { InTableContext } from "../runtime";
import { isNode, list, type Props } from "../values";
import { RISE, useEntrance } from "./motion";

/** Models write `**bold**`, `code` and links in cells as they would in a markdown table. */
const INLINE_MARKDOWN = /\*\*|__|`|\[[^\]]*\]\(/;

function Cell({ value }: { value: Value }): ReactNode {
  if (isNode(value)) return <RenderNode node={value} />;
  if (value === null) return <span className="text-subtle-foreground">—</span>;
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {value.map((item: Value, index) => (
          <Cell key={isNode(item) ? item.key : index} value={item} />
        ))}
      </span>
    );
  }
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && INLINE_MARKDOWN.test(value)) {
    return <Markdown content={value} className="text-sm [&_p]:m-0" />;
  }
  return String(value);
}

/** A body row: rises in with its siblings the first time it appears. */
function BodyRow({ children }: { children: ReactNode }) {
  const ref = useEntrance<HTMLTableRowElement>(RISE);
  return <tr ref={ref}>{children}</tr>;
}

export function Table({ props }: { props: Props }) {
  const columns = list(props.columns);
  const rows = list(props.rows).map((row) => (Array.isArray(row) ? row : [row]));
  const width = Math.max(columns.length, ...rows.map((row) => row.length));
  // A column whose filled cells are all numbers is right-aligned.
  const numeric = Array.from({ length: width }, (_, column) => {
    const filled = rows.map((row) => row[column] ?? null).filter((cell) => cell !== null);
    return filled.length > 0 && filled.every((cell) => typeof cell === "number");
  });
  return (
    // No box of its own: the table sits on its Card's surface and is ruled
    // only between rows, like a typeset table.
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm leading-5">
        {columns.length === 0 ? null : (
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={index}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap border-b border-border pb-2 pr-4 align-bottom text-xs font-medium text-muted-foreground last:pr-0",
                    numeric[index] && "text-right",
                  )}
                >
                  <Cell value={column} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <InTableContext value={true}>
          <tbody className="[&>tr:last-child>td]:border-b-0">
            {rows.map((row, rowIndex) => (
              <BodyRow key={rowIndex}>
                {Array.from({ length: width }, (_, column) => (
                  <td
                    key={column}
                    className={cn(
                      "border-b border-border/60 py-2.5 pr-4 align-top text-foreground last:pr-0",
                      column === 0 && width > 1 && "min-w-[7rem] font-medium",
                      numeric[column] && "whitespace-nowrap text-right tabular-nums",
                    )}
                  >
                    <Cell value={row[column] ?? null} />
                  </td>
                ))}
              </BodyRow>
            ))}
          </tbody>
        </InTableContext>
      </table>
    </div>
  );
}
