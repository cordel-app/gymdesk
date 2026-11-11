'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useLocale } from 'next-intl';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymDateTime, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { readOnlyStyle } from '@/components/ui';
import { ExpandedRow, StatusBadge, fmtDate, fmtDateTime, fmtAmount, type Transaction, type BillingEventDetails } from './BillingEventExpandedRow';
import {
  BILLING_EVENT_STATUS_VALUES, BillingEventStatusBadge, NormalizedPaymentStatusBadge, billingEventAmountLabel, useBillingEventActions,
  type BillingEventHeaderRow,
} from './BillingEventShared';

const STATUS_VALUES = BILLING_EVENT_STATUS_VALUES;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BillingEvent extends BillingEventHeaderRow {
  id: number | null;
  type: 'real' | 'virtual';
  member_id: number;
  member_name: string | null;
  user_membership_id: number | null;
  plan_name: string | null;
  billing_date: string;
  /** ISO datetime the ledger row was created; null for projected (virtual) rows. */
  created_at: string | null;
  /** #2565: the latest attempt's normalized payment status (same as the details). */
  normalized_payment_status?: string | null;
  amount: string | null;
  event_type: string;
  status: 'paid' | 'failed' | 'pending' | 'scheduled' | 'recorded' | 'cancelled';
  currency: string | null;
  /** #640: Retry Payment / Manual payment apply to this row. */
  payment_actions_available: boolean;
  /** #1459: the API's per-action flags — the menu renders them, it decides nothing. */
  can_retry?: boolean;
  can_pay_cash?: boolean;
  can_pay_card?: boolean;
  can_waive?: boolean;
  /** #1459: a first payment settles through the membership's `record-payment`. */
  first_payment?: boolean;
}

interface PageResult {
  items: BillingEvent[];
  total: number;
  limit: number;
  offset: number;
}

interface MemberHit { id: number; name: string; email: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function BillingEventsPage() {
  const t = useTranslations();
  const gymFmt = useGymFormatSettings();
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
  // #2553: one Assigned Plan's events (`?userMembershipId=`), shown as a chip.
  const [userMembershipId, setUserMembershipId] = useState<number | null>(
    searchParams.get('userMembershipId') ? Number(searchParams.get('userMembershipId')) : null,
  );
  const [planName] = useState<string>(searchParams.get('planName') ?? '');
  const [from, setFrom] = useState(searchParams.get('from') ?? '');
  const [to, setTo] = useState(searchParams.get('to') ?? '');
  const [status, setStatus] = useState<string[]>(
    (searchParams.get('status') ?? '').split(',').filter(Boolean),
  );
  // #779: `order=asc` is how the sidebar badge opens the failed list as a work
  // queue, oldest first. Carried through the URL like the filters, no control.
  const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  // #1521: `?id=` opens one specific event (the Member card's *View billing
  // event*), expanded; changing any filter leaves it (`pushParams` drops it).
  const eventIdParam = Number(searchParams.get('id'));
  const eventId = Number.isInteger(eventIdParam) && eventIdParam > 0 ? eventIdParam : null;
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState<BillingEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Sync filter state to URL
  function pushParams(params: { memberId?: number | null; memberName?: string; from?: string; to?: string; status?: string[]; userMembershipId?: number | null }) {
    const p = new URLSearchParams();
    const umId = params.userMembershipId !== undefined ? params.userMembershipId : userMembershipId;
    const mId = params.memberId !== undefined ? params.memberId : memberId;
    const mName = params.memberName !== undefined ? params.memberName : memberName;
    const f = params.from !== undefined ? params.from : from;
    const t2 = params.to !== undefined ? params.to : to;
    const s = params.status !== undefined ? params.status : status;
    if (mId) { p.set('memberId', String(mId)); p.set('memberName', mName); }
    if (umId) { p.set('userMembershipId', String(umId)); if (planName) p.set('planName', planName); }
    if (f) p.set('from', f);
    if (t2) p.set('to', t2);
    if (s.length > 0) p.set('status', s.join(','));
    if (order === 'asc') p.set('order', 'asc');
    router.replace(`/${locale}/payments/billing-events${p.toString() ? '?' + p.toString() : ''}`, { scroll: false });
  }

  const load = useCallback(async (off: number) => {
    if (!activeGymId) return;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ limit: String(DEFAULT_LIMIT), offset: String(off) });
      if (memberId) p.set('member_id', String(memberId));
      if (userMembershipId) p.set('user_membership_id', String(userMembershipId));
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      for (const s of status) p.append('status', s);
      if (order === 'asc') p.set('order', 'asc');
      if (eventId) p.set('id', String(eventId));
      const data = await apiFetch<PageResult>(`/payments/billing-events?${p}`);
      setItems(data.items);
      setTotal(data.total);
      setOffset(off);
      // collapse all on new page/filter — except the one event opened by link
      setExpanded(new Set(eventId && data.items.some((i) => i.id === eventId) ? [eventId] : []));
      closePendingRef.current();
    } catch {
      setError('Failed to load billing events.');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGymId, memberId, userMembershipId, from, to, status, order, eventId]);

  useEffect(() => { if (!gymLoading) load(0); }, [gymLoading, load]);

  /** Re-reads only the current page, keeping filters and expansion state. */
  const reloadCurrentPage = useCallback(() => { load(offset); }, [load, offset]);

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openDetails(id: number) {
    setExpanded((prev) => new Set(prev).add(id));
  }

  const { menuItems, modal, closePending, canWrite, readOnlyTitle } = useBillingEventActions<BillingEvent>({
    onChanged: reloadCurrentPage,
    openDetails,
  });
  const closePendingRef = useRef(closePending);
  closePendingRef.current = closePending;

  const statusLabel: Record<string, string> = {
    paid: t('billing_events_page.status_paid'),
    failed: t('billing_events_page.status_failed'),
    pending: t('billing_events_page.status_pending'),
    scheduled: t('billing_events_page.status_scheduled'),
    recorded: t('billing_events_page.status_recorded'),
    cancelled: t('billing_events_page.status_cancelled'),
  };

  return (
    <div>
      {modal}
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
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
            {t('billing_events_page.filter_status')}
          </label>
          <MultiSelectFilter
            label={t('billing_events_page.filter_status')}
            options={STATUS_VALUES.map((v) => ({ value: v, label: statusLabel[v] }))}
            selected={status}
            onChange={(next) => { setStatus(next); pushParams({ status: next }); }}
          />
        </div>
        {userMembershipId && (
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
              {t('billing_events_page.filter_plan')}
            </label>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
              {planName || `#${userMembershipId}`}
              <button
                type="button"
                aria-label={t('billing_events_page.filter_plan_remove')}
                onClick={() => { setUserMembershipId(null); pushParams({ userMembershipId: null }); }}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: '#6b7280' }}
              >✕</button>
            </span>
          </div>
        )}
        {(memberId || userMembershipId || from || to || status.length > 0) && (
          <button
            onClick={() => {
              setMemberId(null); setMemberName(''); setUserMembershipId(null); setFrom(''); setTo(''); setStatus([]);
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
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.header_method')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right' }}>{t('billing_events_page.header_attempts')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_date')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_created')}</th>
                <th style={{ padding: '8px 12px', textAlign: 'right' }}>{t('billing_events_page.col_amount')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_status')}</th>
                <th style={{ padding: '8px 12px' }}>{t('billing_events_page.col_normalized_payment_status')}</th>
                <th style={{ padding: '8px 12px', width: 48 }}>{t('billing_events_page.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={11} style={{ padding: '24px 12px', textAlign: 'center', color: '#888' }}>
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
                      <td style={{ padding: '8px 12px' }}>{row.payment_method_name ?? '—'}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{row.attempt_count ?? 0}</td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{fmtDate(row.billing_date, gymFmt)}</td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtDateTime(row.created_at, gymFmt)}
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {billingEventAmountLabel(row)}
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <BillingEventStatusBadge row={row} t={t} />
                      </td>
                      <td style={{ padding: '8px 12px' }}>
                        <NormalizedPaymentStatusBadge status={row.normalized_payment_status} t={t} />
                      </td>
                      <td style={{ padding: '8px 12px' }} onClick={(e) => e.stopPropagation()}>
                        {isExpandable && (
                          <ContextMenu items={menuItems(row)} ariaLabel={t('billing_events_page.col_actions')} />
                        )}
                      </td>
                    </tr>
                    {isExpanded && row.id != null && (
                      <tr key={`${rowKey}-expanded`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <ExpandedRow
                          key={`${row.id}-${row.status}-${row.refunded_amount ?? ''}`}
                          billingEvent={row}
                          onChanged={reloadCurrentPage}
                          canWrite={canWrite}
                          readOnlyTitle={readOnlyTitle}
                          t={t}
                        />
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
