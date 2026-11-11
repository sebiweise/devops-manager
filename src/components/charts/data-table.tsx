import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The table view of a chart: one header row, string cells. */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<ReadonlyArray<string>>;
}) {
  return (
    <div className="max-h-80 overflow-y-auto">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            {columns.map((c, i) => (
              <TableHead key={c} className={i > 0 ? "text-right" : undefined}>
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, r) => (
            <TableRow key={r}>
              {row.map((cell, i) => (
                <TableCell
                  key={i}
                  className={i > 0 ? "text-right tabular-nums" : undefined}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
