'use client';

import { useEffect, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';

interface BillingEvent {
  id: number;
  event_type: string;
  member_id: number | null;
  member_name: string | null;
  amount: string | null;
  source: string;
  notes: string | null;
  created_at: string;
  charge_type_code: string | null;
}

interface PageResult {
  items: BillingEvent[];
  total: number;
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 50;

export default function TransactionsPage() {
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();

  const [items, setItems] = useState<BillingEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (off: number) => {
    if (!activeGymId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<PageResult>(`/payments?limit=${DEFAULT_LIMIT}&offset=${off}`);
      setItems(data.items);
      setTotal(data.total);
      setOffset(off);
    } catch {
      setError('Failed to load transactions.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, activeGymId]);

  useEffect(() => { if (!gymLoading) load(0); }, [gymLoading, load]);

  const formatAmount = (amount: string | null) => {
    if (amount === null) return '—';
    const n = parseFloat(amount);
    return isNaN(n) ? '—' : n.toFixed(2);
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>Transactions</h1>

      {loading && <p style={{ color: '#888', fontSize: 14 }}>Loading…</p>}
      {error && <p style={{ color: 'red', fontSize: 14 }}>{error}</p>}

      {!loading && !error && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px' }}>Date</th>
                <th style={{ padding: '8px 12px' }}>Type</th>
                <th style={{ padding: '8px 12px' }}>Member</th>
                <th style={{ padding: '8px 12px' }}>Charge Type</th>
                <th style={{ padding: '8px 12px', textAlign: 'right' }}>Amount</th>
                <th style={{ padding: '8px 12px' }}>Source</th>
                <th style={{ padding: '8px 12px' }}>Notes</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '24px 12px', textAlign: 'center', color: '#888' }}>
                    No transactions yet.
                  </td>
                </tr>
              )}
              {items.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{formatDate(row.created_at)}</td>
                  <td style={{ padding: '8px 12px' }}>{row.event_type}</td>
                  <td style={{ padding: '8px 12px' }}>{row.member_name ?? '—'}</td>
                  <td style={{ padding: '8px 12px' }}>{row.charge_type_code ?? '—'}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {formatAmount(row.amount)}
                  </td>
                  <td style={{ padding: '8px 12px' }}>{row.source}</td>
                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{row.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, fontSize: 13, color: '#6b7280' }}>
            <button
              onClick={() => load(Math.max(0, offset - DEFAULT_LIMIT))}
              disabled={offset === 0}
              style={{ padding: '4px 10px', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.4 : 1 }}
            >
              ← Previous
            </button>
            <span>
              {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + DEFAULT_LIMIT, total)}`} of {total}
            </span>
            <button
              onClick={() => load(offset + DEFAULT_LIMIT)}
              disabled={offset + DEFAULT_LIMIT >= total}
              style={{ padding: '4px 10px', cursor: offset + DEFAULT_LIMIT >= total ? 'not-allowed' : 'pointer', opacity: offset + DEFAULT_LIMIT >= total ? 0.4 : 1 }}
            >
              Next →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
