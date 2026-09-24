'use client';

import React from 'react';
import {
  listCellStyle, listExpandedStyle, listHeaderCellStyle, listHeaderRowStyle,
  listRowDividerStyle, listSurfaceStyle,
} from './listChrome';

export interface Column<T> {
  header: React.ReactNode;
  width?: number | string;
  render: (row: T) => React.ReactNode;
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

  return (
    <table style={tableStyle}>
      <thead>
        <tr style={listHeaderRowStyle}>
          {expandable && <th style={{ ...th, width: 44 }} aria-hidden />}
          {columns.map((col, i) => (
            <th key={i} style={col.width !== undefined ? { ...th, width: col.width } : th}>{col.header}</th>
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
                {columns.map((col, i) => (
                  <td key={i} style={td}>{col.render(row)}</td>
                ))}
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
  );
}

// The surface, the header band, the cell insets and the dividers all come from
// listChrome (#724), so a card list can wear the same chrome without copying it.
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', ...listSurfaceStyle };
const th: React.CSSProperties = listHeaderCellStyle;
const td: React.CSSProperties = listCellStyle;
const chevronStyle: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gd-text-muted, #6b7280)', fontSize: 12, padding: 4, lineHeight: 1 };
const expandedCell: React.CSSProperties = { padding: 0, ...listExpandedStyle };
