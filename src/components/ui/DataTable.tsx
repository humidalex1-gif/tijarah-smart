import type { ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: string;
  align?: "start" | "end";
  render: (row: T) => ReactNode;
}

export function DataTable<T extends { id: string }>({
  columns, rows, empty,
}: {
  columns: Column<T>[];
  rows: T[];
  empty: ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`px-4 py-3 font-medium text-muted ${
                  column.align === "end" ? "text-end" : "text-start"
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Row hover is `subtle`, not `surface`: the header above is filled
              `surface`, so hovering the first row merged it into the header and
              the table appeared to lose a line. `subtle` sits between panel and
              surface, so it reads as a lift in either theme. */}
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-line last:border-0 hover:bg-subtle">
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-4 py-3 ${column.align === "end" ? "text-end" : "text-start"}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
