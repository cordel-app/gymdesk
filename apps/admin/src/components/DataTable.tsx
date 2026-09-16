'use client';

import React from 'react';

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
        <tr style={{ background: 'var(--gd-app-bg, #f0f0f0)', textAlign: 'left' }}>
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
              <tr style={{ borderTop: '1px solid var(--gd-border, #e5e7eb)' }}>
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

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: 'var(--gd-card-bg, #ffffff)', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const th: React.CSSProperties = { padding: '12px 16px', fontWeight: 600, fontSize: 15 };
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 15 };
const chevronStyle: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gd-text-muted, #6b7280)', fontSize: 12, padding: 4, lineHeight: 1 };
const expandedCell: React.CSSProperties = { padding: 0, background: 'var(--gd-app-bg, #f5f5f5)', borderTop: '1px solid var(--gd-border, #e5e7eb)' };
