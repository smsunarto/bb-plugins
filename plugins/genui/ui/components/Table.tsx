import type { ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { Value } from "../../core/types";
import {
  Table as TableView,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  return (
    <TableRow ref={ref} className="border-b-0 hover:bg-transparent">
      {children}
    </TableRow>
  );
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
    <div className="min-w-0">
      <TableView className="border-collapse text-left leading-5">
        {columns.length === 0 ? null : (
          <TableHeader className="[&_tr]:border-b-0">
            <TableRow className="hover:bg-transparent">
              {columns.map((column, index) => (
                <TableHead
                  key={index}
                  scope="col"
                  className={cn(
                    "h-auto whitespace-nowrap border-b border-border pb-2 pl-0 pr-4 align-bottom text-xs last:pr-0",
                    numeric[index] && "text-right",
                  )}
                >
                  <Cell value={column} />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
        )}
        <InTableContext value={true}>
          <TableBody className="[&>tr:last-child>td]:border-b-0">
            {rows.map((row, rowIndex) => (
              <BodyRow key={rowIndex}>
                {Array.from({ length: width }, (_, column) => (
                  <TableCell
                    key={column}
                    className={cn(
                      "border-b border-border py-2.5 pl-0 pr-4 align-top text-foreground last:pr-0",
                      column === 0 && width > 1 && "min-w-[7rem] font-medium",
                      numeric[column] && "whitespace-nowrap text-right tabular-nums",
                    )}
                  >
                    <Cell value={row[column] ?? null} />
                  </TableCell>
                ))}
              </BodyRow>
            ))}
          </TableBody>
        </InTableContext>
      </TableView>
    </div>
  );
}
