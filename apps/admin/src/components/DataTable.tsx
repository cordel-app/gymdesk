'use client';

import React from 'react';
import {
  LIST_NAME_VALUE_CLASS, type ListColumnMobile, listCellClass, listCellStyle,
  listExpandedStyle, listHeaderCellStyle, listHeaderRowStyle, listRowDividerStyle,
  listScrollerClass, listSurfaceStyle,
} from './listChrome';

export interface Column<T> {
  header: React.ReactNode;
  width?: number | string;
  render: (row: T) => React.ReactNode;
  /**
   * #1011 — what this column is below the mobile breakpoint. Every column
   * declares it: the default (`secondary`, i.e. hidden or scrolled) is what a
   * column that says nothing gets, and the gate in
   * `api/src/test/admin-list-mobile-columns.unit.test.ts` is what stops a new
   * column from saying nothing by accident.
   */
  mobile?: ListColumnMobile;
  /**
   * The full value a truncated `mobile: 'name'` cell keeps in its `title`, so a
   * name clipped on a phone is still readable. Ignored for every other column.
   */
  title?: (row: T) => string | undefined;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => React.Key;
  loading?: boolean;
  loadingText: string;
  emptyText: string;
  // Optional row expansion (tree grid). When renderExpanded is provided a
  // leading chevron column is rendered and expanded rows get an extra full-width
  // row containing renderExpanded(row). All three props are optional so the 16
  // existing flat-table consumers are unaffected.
  renderExpanded?: (row: T) => React.ReactNode;
  expandedRowKeys?: Set<React.Key>;
  onToggleExpand?: (row: T) => void;
}

export function DataTable<T>({
  columns, rows, rowKey, loading, loadingText, emptyText,
  renderExpanded, expandedRowKeys, onToggleExpand,
}: DataTableProps<T>) {
  if (loading) return <p style={{ color: 'var(--gd-text-muted, #6b7280)' }}>{loadingText}</p>;
  if (rows.length === 0) return <p style={{ color: 'var(--gd-text-muted, #6b7280)' }}>{emptyText}</p>;

  const expandable = !!renderExpanded;
  const totalCols = columns.length + (expandable ? 1 : 0);
  // #1011: a row that expands reads its hidden columns one tap below itself, so
  // they are hidden on a phone; a flat row has nowhere to read them, so they
  // stay and the block between the pinned cells scrolls instead (`Q2 scroll`).
  const scroller = listScrollerClass(expandable ? 'collapse' : 'scroll');

  return (
    <div className={scroller}>
      <table style={tableStyle}>
        <thead>
          <tr style={listHeaderRowStyle}>
            {expandable && <th style={{ ...th, width: 44 }} aria-hidden />}
            {columns.map((col, i) => (
              <th
                key={i}
                className={listCellClass(col.mobile)}
                style={col.width !== undefined ? { ...th, width: col.width } : th}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const isExpanded = expandable && !!expandedRowKeys?.has(key);
            return (
              <React.Fragment key={key}>
                <tr style={listRowDividerStyle}>
                  {expandable && (
                    <td style={{ ...td, textAlign: 'center' }}>
                      <button
                        onClick={() => onToggleExpand?.(row)}
                        aria-label={isExpanded ? 'Collapse' : 'Expand'}
                        aria-expanded={isExpanded}
                        style={chevronStyle}
                      >
                        <span style={{ display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                      </button>
                    </td>
                  )}
                  {columns.map((col, i) => {
                    const value = col.render(row);
                    return (
                      <td
                        key={i}
                        className={listCellClass(col.mobile)}
                        // The full name, for the cell a phone truncates.
                        title={col.mobile === 'name' ? col.title?.(row) : undefined}
                        style={td}
                      >
                        {col.mobile === 'name'
                          ? <div className={LIST_NAME_VALUE_CLASS}>{value}</div>
                          : value}
                      </td>
                    );
                  })}
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={totalCols} style={expandedCell}>{renderExpanded!(row)}</td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// The surface, the header band, the cell insets and the dividers all come from
// listChrome (#724), so a card list can wear the same chrome without copying it.
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', ...listSurfaceStyle };
const th: React.CSSProperties = listHeaderCellStyle;
const td: React.CSSProperties = listCellStyle;
const chevronStyle: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gd-text-muted, #6b7280)', fontSize: 12, padding: 4, lineHeight: 1 };
const expandedCell: React.CSSProperties = { padding: 0, ...listExpandedStyle };
