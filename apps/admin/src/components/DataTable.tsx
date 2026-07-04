'use client';

import React from 'react';

export interface Column<T> {
  header: string;
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
}

export function DataTable<T>({ columns, rows, rowKey, loading, loadingText, emptyText }: DataTableProps<T>) {
  if (loading) return <p style={{ color: '#666' }}>{loadingText}</p>;
  if (rows.length === 0) return <p style={{ color: '#666' }}>{emptyText}</p>;

  return (
    <table style={tableStyle}>
      <thead>
        <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
          {columns.map((col, i) => (
            <th key={i} style={col.width !== undefined ? { ...th, width: col.width } : th}>{col.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} style={{ borderTop: '1px solid #eee' }}>
            {columns.map((col, i) => (
              <td key={i} style={td}>{col.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const th: React.CSSProperties = { padding: '12px 16px', fontWeight: 600, fontSize: 15 };
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 15 };
