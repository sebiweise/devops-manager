"use client";

import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * One row of the DataTable with its disclosure (UI overhaul §1.7): a
 * chevron button in a narrow leading cell toggles a full-width detail row
 * underneath (colSpan over every column), so the hidden columns read as a
 * label/value list across the whole table width instead of being squeezed
 * into the last cell. The detail row is rendered on the server and only
 * shown or hidden here.
 */
export function ExpandableRow({
  lead,
  cells,
  detail,
  colSpan,
  label,
  className,
  muted,
  toggleClassName,
}: {
  /** Cell content before the toggle (the selection checkbox). */
  lead?: ReactNode;
  /** The row's data cells (`<td>` elements). */
  cells: ReactNode;
  detail: ReactNode;
  colSpan: number;
  /** Accessible name of the toggle. */
  label: string;
  className?: string;
  muted?: boolean;
  /** Hides the toggle cell and the detail row from a breakpoint on. */
  toggleClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <TableRow
        data-muted={muted || undefined}
        className={cn(open && "border-b-0", className)}
      >
        {lead !== undefined ? <TableCell>{lead}</TableCell> : null}
        <TableCell className={cn("w-px pr-0 pl-0 sm:pl-1", toggleClassName)}>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={label}
            title={label}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-4 transition-transform", open && "rotate-90")}
            />
          </button>
        </TableCell>
        {cells}
      </TableRow>
      <TableRow
        id={id}
        hidden={!open}
        data-detail
        className={cn("bg-muted/30 hover:bg-muted/30", toggleClassName)}
      >
        <TableCell
          colSpan={colSpan}
          className="px-3 pt-1 pb-3 whitespace-normal"
        >
          {detail}
        </TableCell>
      </TableRow>
    </>
  );
}
