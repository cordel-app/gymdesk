import type React from 'react';

/**
 * #2786 — the cells of a DataTable draft row, in column order.
 *
 * A draft row's cells are keyed by the column's own `key`, never by position:
 * a positional array has to be kept in step with `columns` by hand, and a column
 * added to the table (#2609's *Assigned to*) without a matching entry shifted
 * every cell after it under the wrong header. A column the draft has nothing
 * for (no key, or no entry) gets an empty cell, so the row always has exactly
 * one cell per column.
 */
export function draftRowCells(
  columns: ReadonlyArray<{ key?: string }>,
  cells: Readonly<Record<string, React.ReactNode>>,
): React.ReactNode[] {
  return columns.map((col) => (col.key !== undefined && col.key in cells ? cells[col.key] : null));
}
