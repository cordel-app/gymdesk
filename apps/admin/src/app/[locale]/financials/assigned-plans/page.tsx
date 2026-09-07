'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { StatusBadge } from '@/components/StatusBadge';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';

// ── Types ─────────────────────────────────────────────────────────────────────

type LifecycleStatus = 'pending' | 'active' | 'paused' | 'expired' | 'cancelled';

interface AssignedPlan {
  id: number;
  member_name: string;
  plan_name: string | null;
  starts_at: string;
  ends_at: string | null;
  lifecycle_status: LifecycleStatus;
}

interface MemberHit { id: number; name: string; email: string }

const LIFECYCLE_STATUSES: LifecycleStatus[] = ['pending', 'active', 'paused', 'expired', 'cancelled'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

// ── Member search (inline filter — mirrors payments/billing-events' MemberFilter) ──

function MemberFilter({
  value,
  onSelect,
  onClear,
  placeholder,
}: {
  value: string;
  onSelect: (m: MemberHit) => void;
  onClear: () => void;
  placeholder: string;
}) {
  const { apiFetch } = useApiClient();
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<MemberHit[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      try {
        const data = await apiFetch<MemberHit[]>(`/members?q=${encodeURIComponent(query)}`);
        setResults(data);
        setOpen(true);
      } catch { setResults([]); }
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div ref={wrap} style={{ position: 'relative', minWidth: 220 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setResults([]); setOpen(false); onClear(); }}
            style={{ padding: '4px 8px', fontSize: 13, cursor: 'pointer', border: '1px solid #d1d5db', borderRadius: 6 }}
          >
            ×
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,.08)', marginTop: 4,
        }}>
          {results.map((m) => (
            <div
              key={m.id}
              onMouseDown={() => { onSelect(m); setQuery(m.name); setOpen(false); }}
              style={{ padding: '8px 12px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
            >
              <span style={{ fontWeight: 500 }}>{m.name}</span>
              <span style={{ color: '#9ca3af', marginLeft: 8 }}>{m.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AssignedPlansPage() {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();

  const [rows, setRows] = useState<AssignedPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state (#411)
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [memberId, setMemberId] = useState<number | null>(null);
  const [memberName, setMemberName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const load = useCallback(async () => {
    if (!activeGymId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      for (const s of statusFilter) params.append('lifecycle_status', s);
      if (memberId) params.set('member_id', String(memberId));
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      const qs = params.toString();
      const data = await apiFetch<AssignedPlan[]>(`/user-memberships${qs ? `?${qs}` : ''}`);
      setRows(data);
    } catch {
      setError('Failed to load assigned plans.');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGymId, statusFilter, memberId, startDate, endDate]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  const hasFilters = statusFilter.length > 0 || !!memberId || !!startDate || !!endDate;

  function clearFilters() {
    setStatusFilter([]);
    setMemberId(null);
    setMemberName('');
    setStartDate('');
    setEndDate('');
  }

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>{t('assigned_plans_page.title')}</h1>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('assigned_plans_page.filter_status')}
          </label>
          <MultiSelectFilter
            label={t('assigned_plans_page.filter_status')}
            options={LIFECYCLE_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            selected={statusFilter}
            onChange={setStatusFilter}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('assigned_plans_page.filter_member')}
          </label>
          <MemberFilter
            value={memberName}
            placeholder={t('assigned_plans_page.filter_member')}
            onSelect={(m) => { setMemberId(m.id); setMemberName(m.name); }}
            onClear={() => { setMemberId(null); setMemberName(''); }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('assigned_plans_page.filter_from')}
          </label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('assigned_plans_page.filter_to')}
          </label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          />
        </div>
        {hasFilters && (
          <button
            onClick={clearFilters}
            style={{ padding: '6px 12px', fontSize: 13, cursor: 'pointer', border: '1px solid #d1d5db', borderRadius: 6, alignSelf: 'flex-end' }}
          >
            {t('assigned_plans_page.filter_clear')}
          </button>
        )}
      </div>

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
                  {hasFilters ? t('assigned_plans_page.no_matches') : t('assigned_plans_page.empty')}
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
