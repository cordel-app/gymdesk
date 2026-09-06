'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { StatusBadge } from '@/components/StatusBadge';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AssignedPlan {
  id: number;
  member_name: string;
  plan_name: string | null;
  starts_at: string;
  ends_at: string | null;
  lifecycle_status: 'pending' | 'active' | 'paused' | 'expired' | 'cancelled';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AssignedPlansPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();

  const [rows, setRows] = useState<AssignedPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeGymId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<AssignedPlan[]>('/user-memberships');
      setRows(data);
    } catch {
      setError('Failed to load assigned plans.');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGymId]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>{t('assigned_plans_page.title')}</h1>

      {loading && <p style={{ color: '#888', fontSize: 14 }}>{t('assigned_plans_page.loading')}</p>}
      {error && <p style={{ color: 'red', fontSize: 14 }}>{error}</p>}

      {!loading && !error && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>{t('assigned_plans_page.col_member')}</th>
              <th style={{ padding: '8px 12px' }}>{t('assigned_plans_page.col_plan')}</th>
              <th style={{ padding: '8px 12px' }}>{t('assigned_plans_page.col_starts_at')}</th>
              <th style={{ padding: '8px 12px' }}>{t('assigned_plans_page.col_ends_at')}</th>
              <th style={{ padding: '8px 12px' }}>{t('assigned_plans_page.col_status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: '24px 12px', textAlign: 'center', color: '#888' }}>
                  {t('assigned_plans_page.empty')}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '8px 12px', fontWeight: 500 }}>{row.member_name}</td>
                <td style={{ padding: '8px 12px', color: '#6b7280' }}>{row.plan_name ?? '—'}</td>
                <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(row.starts_at)}</td>
                <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                  {row.ends_at ? fmtDate(row.ends_at) : t('assigned_plans_page.open_ended')}
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <StatusBadge status={row.lifecycle_status} label={t(`status.${row.lifecycle_status}`)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
