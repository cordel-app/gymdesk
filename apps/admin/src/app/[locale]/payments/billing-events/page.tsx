'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useLocale } from 'next-intl';

// ── Types ─────────────────────────────────────────────────────────────────────

interface BillingEvent {
  id: number | null;
  type: 'real' | 'virtual';
  member_id: number;
  member_name: string | null;
  user_membership_id: number | null;
  plan_name: string | null;
  billing_date: string;
  amount: string | null;
  event_type: string;
  status: 'paid' | 'failed' | 'scheduled' | 'recorded';
  currency: string | null;
}

interface PageResult {
  items: BillingEvent[];
  total: number;
  limit: number;
  offset: number;
}

interface Transaction {
  id: number;
  status: string;
  amount: string | null;
  currency: string | null;
  provider: string | null;
  provider_ref: string | null;
  created_at: string;
  completed_at: string | null;
  member_name: string | null;
  plan_name: string | null;
  card_brand: string | null;
  card_last4: string | null;
}

interface MemberHit { id: number; name: string; email: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function fmtAmount(amount: string | null) {
  if (!amount) return '—';
  const n = parseFloat(amount);
  return isNaN(n) ? '—' : n.toFixed(2);
}

// ── Member search (inline) ────────────────────────────────────────────────────

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

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  paid:      { bg: '#dcfce7', text: '#166534' },
  failed:    { bg: '#fee2e2', text: '#991b1b' },
  scheduled: { bg: '#fef9c3', text: '#92400e' },
  recorded:  { bg: '#e0f2fe', text: '#075985' },
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  const c = STATUS_COLORS[status] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      fontSize: 12, fontWeight: 600, background: c.bg, color: c.text,
    }}>
      {label}
    </span>
  );
}

// ── Expanded transactions row ─────────────────────────────────────────────────

function TransactionsRow({ billingEventId, t }: { billingEventId: number; t: ReturnType<typeof useTranslations> }) {
  const { apiFetch } = useApiClient();
  const [rows, setRows] = useState<Transaction[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ items: Transaction[] }>(`/payments/billing-events/${billingEventId}/transactions`)
      .then((d) => setRows(d.items))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingEventId]);

  if (loading) return <td colSpan={5} style={{ padding: '12px 16px', fontSize: 13, color: '#6b7280' }}>{t('billing_events_page.loading')}</td>;

  return (
    <td colSpan={5} style={{ padding: '0 0 0 48px', background: '#f9fafb' }}>
      <div style={{ padding: '12px 16px 16px' }}>
        <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 13 }}>{t('billing_events_page.transactions_heading')}</p>
        {rows && rows.length === 0 ? (
          <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>{t('billing_events_page.transactions_empty')}</p>
        ) : (
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                {(['col_tx_date', 'col_tx_status', 'col_tx_amount', 'col_tx_card', 'col_tx_ref'] as const).map((k) => (
                  <th key={k} style={{ padding: '4px 10px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>
                    {t(`billing_events_page.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows?.map((tx) => (
                <tr key={tx.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{fmtDate(tx.created_at)}</td>
                  <td style={{ padding: '6px 10px' }}>{tx.status}</td>
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtAmount(tx.amount)} {tx.currency ?? ''}
                  </td>
                  <td style={{ padding: '6px 10px' }}>
                    {tx.card_brand && tx.card_last4 ? `${tx.card_brand} ···${tx.card_last4}` : '—'}
                  </td>
                  <td style={{ padding: '6px 10px', color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>
                    {tx.provider_ref ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </td>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BillingEventsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();

  // Filter state — synced with URL params
  const [memberId, setMemberId] = useState<number | null>(
    searchParams.get('memberId') ? Number(searchParams.get('memberId')) : null,
  );
  const [memberName, setMemberName] = useState<string>(searchParams.get('memberName') ?? '');
  const [from, setFrom] = useState(searchParams.get('from') ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? '');
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState<BillingEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Sync filter state to URL
  function pushParams(params: { memberId?: number | null; memberName?: string; from?: string; to?: string }) {
    const p = new URLSearchParams();
    const mId = params.memberId !== undefined ? params.memberId : memberId;
    const mName = params.memberName !== undefined ? params.memberName : memberName;
    const f = params.from !== undefined ? params.from : from;
    const t2 = params.to !== undefined ? params.to : to;
    if (mId) { p.set('memberId', String(mId)); p.set('memberName', mName); }
    if (f) p.set('from', f);
    if (t2) p.set('to', t2);
    router.replace(`/${locale}/payments/billing-events${p.toString() ? '?' + p.toString() : ''}`, { scroll: false });
  }

  const load = useCallback(async (off: number) => {
    if (!activeGymId) return;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ limit: String(DEFAULT_LIMIT), offset: String(off) });
      if (memberId) p.set('member_id', String(memberId));
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const data = await apiFetch<PageResult>(`/payments/billing-events?${p}`);
      setItems(data.items);
      setTotal(data.total);
      setOffset(off);
      setExpanded(new Set()); // collapse all on new page/filter
    } catch {
      setError('Failed to load billing events.');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGymId, memberId, from, to]);

  useEffect(() => { if (!gymLoading) load(0); }, [gymLoading, load]);

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const statusLabel: Record<string, string> = {
    paid: t('billing_events_page.status_paid'),
    failed: t('billing_events_page.status_failed'),
    scheduled: t('billing_events_page.status_scheduled'),
    recorded: t('billing_events_page.status_recorded'),
  };

  return (
    <div>
      <h1 style={{ margin: '0 0 16px' }}>{t('billing_events_page.title')}</h1>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('billing_events_page.filter_member')}
          </label>
          <MemberFilter
            value={memberName}
            placeholder={t('billing_events_page.filter_member')}
            onSelect={(m) => {
              setMemberId(m.id);
              setMemberName(m.name);
              pushParams({ memberId: m.id, memberName: m.name });
            }}
            onClear={() => {
              setMemberId(null);
              setMemberName('');
              pushParams({ memberId: null, memberName: '' });
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('billing_events_page.filter_from')}
          </label>
          <input
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); pushParams({ from: e.target.value }); }}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('billing_events_page.filter_to')}
          </label>
          <input
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); pushParams({ to: e.target.value }); }}
            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
          />
        </div>
        {(memberId || from || to) && (
          <button
            onClick={() => {
              setMemberId(null); setMemberName(''); setFrom(''); setTo('');
              router.replace(`/${locale}/payments/billing-events`, { scroll: false });
            }}
            style={{ padding: '6px 12px', fontSize: 13, cursor: 'pointer', border: '1px solid #d1d5db', borderRadius: 6, alignSelf: 'flex-end' }}
          >
            {t('billing_events_page.filter_clear')}
          </button>
        )}
      </div>

      {/* Table */}
      {loading && <p style={{ color: '#888', fontSize: 14 }}>{t('billing_events_page.loading')}</p>}
      {error && <p style={{ color: 'red', fontSize: 14 }}>{error}</p>}

      {!loading && !error && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', width: 32 }} />
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_member')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_plan')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_date')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right' }}>{t('billing_events_page.col_amount')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: '24px 12px', textAlign: 'center', color: '#888' }}>
                    {t('billing_events_page.empty')}
                  </td>
                </tr>
              )}
              {items.map((row, idx) => {
                const rowKey = row.id != null ? `real-${row.id}` : `virtual-${row.user_membership_id}-${row.billing_date}-${idx}`;
                const isExpandable = row.type === 'real' && row.id != null;
                const isExpanded = isExpandable && expanded.has(row.id!);

                return (
                  <>
                    <tr
                      key={rowKey}
                      style={{
                        borderBottom: isExpanded ? 'none' : '1px solid #f3f4f6',
                        background: isExpanded ? '#f9fafb' : undefined,
                        cursor: isExpandable ? 'pointer' : undefined,
                      }}
                      onClick={isExpandable ? () => toggleExpand(row.id!) : undefined}
                    >
                      <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 12 }}>
                        {isExpandable ? (isExpanded ? '▾' : '▸') : null}
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 500 }}>{row.member_name ?? '—'}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{row.plan_name ?? '—'}</td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(row.billing_date)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtAmount(row.amount)} {row.currency ?? ''}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <StatusBadge status={row.status} label={statusLabel[row.status] ?? row.status} />
                      </td>
                    </tr>
                    {isExpanded && row.id != null && (
                      <tr key={`${rowKey}-expanded`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <TransactionsRow billingEventId={row.id} t={t} />
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, fontSize: 13, color: '#6b7280' }}>
            <button
              onClick={() => load(Math.max(0, offset - DEFAULT_LIMIT))}
              disabled={offset === 0}
              style={{ padding: '4px 10px', cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.4 : 1 }}
            >
              ← {t('billing_events_page.previous')}
            </button>
            <span>
              {total === 0 ? '0' : `${offset + 1}–${Math.min(offset + DEFAULT_LIMIT, total)}`} / {total}
            </span>
            <button
              onClick={() => load(offset + DEFAULT_LIMIT)}
              disabled={offset + DEFAULT_LIMIT >= total}
              style={{
                padding: '4px 10px',
                cursor: offset + DEFAULT_LIMIT >= total ? 'not-allowed' : 'pointer',
                opacity: offset + DEFAULT_LIMIT >= total ? 0.4 : 1,
              }}
            >
              {t('billing_events_page.next')} →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
