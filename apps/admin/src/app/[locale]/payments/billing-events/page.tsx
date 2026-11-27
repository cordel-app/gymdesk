'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useLocale } from 'next-intl';
import { MultiSelectFilter } from '@/components/MultiSelectFilter';
import { FilterBar, FilterField, filterButtonStyle, filterControlStyle } from '@/components/FilterBar';
import {
  EMPTY_BILLING_EVENT_FILTERS, appendApiFilters, billingEventIdFilter, filtersFromUrl, filtersToUrl, hasActiveFilter,
  type BillingEventFilters,
} from './billingEventFilters';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymDateTime, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { readOnlyStyle } from '@/components/ui';
import { StatusBadge, fmtAmount, type Transaction, type BillingEventDetails } from './BillingEventExpandedRow';
import {
  BILLING_EVENT_STATUS_VALUES, BillingEventsTable, useBillingEventActions,
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
  status: 'paid' | 'failed' | 'pending' | 'scheduled' | 'waived' | 'cancelled' | null;
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

/** #2886: what `GET /payments/billing-events/filter-options` offers. */
interface FilterOptions {
  processed_by: string[];
  payment_methods: Array<{ code: string; name: string }>;
}

/** Keeps a value taken from the URL selectable even when it is not offered. */
function withCurrent(values: string[], current: string): string[] {
  return current && !values.includes(current) ? [...values, current] : values;
}

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

  // #2886: every filter is one state object, synced with the URL.
  const [filters, setFilters] = useState<BillingEventFilters>(() => filtersFromUrl(searchParams));
  // Free-text and number inputs are typed into a draft and committed after a pause.
  const [draft, setDraft] = useState({ id: filters.id, product: filters.product, amountMin: filters.amountMin, amountMax: filters.amountMax });
  const [options, setOptions] = useState<FilterOptions>({ processed_by: [], payment_methods: [] });
  // #779: `order=asc` is how the sidebar badge opens the failed list as a work
  // queue, oldest first. Carried through the URL like the filters, no control.
  const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
  // #1521 / #3510: `?id=` is the ID filter. A link (the Member card's *View
  // billing event*) opens that event expanded; the field edits or clears it.
  const idFilter = billingEventIdFilter(filters.id);
  const eventId = idFilter.kind === 'valid' ? idFilter.id : null;
  const [offset, setOffset] = useState(0);

  const [items, setItems] = useState<BillingEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Sync filter state to URL
  function applyFilters(next: BillingEventFilters) {
    setFilters(next);
    const p = filtersToUrl(next);
    if (order === 'asc') p.set('order', 'asc');
    router.replace(`/${locale}/payments/billing-events${p.toString() ? '?' + p.toString() : ''}`, { scroll: false });
  }
  function patchFilters(patch: Partial<BillingEventFilters>) {
    applyFilters({ ...filters, ...patch });
  }

  useEffect(() => {
    if (draft.id === filters.id && draft.product === filters.product && draft.amountMin === filters.amountMin && draft.amountMax === filters.amountMax) return;
    const timer = setTimeout(() => patchFilters(draft), 400);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    if (!activeGymId) return;
    apiFetch<FilterOptions>('/payments/billing-events/filter-options')
      .then(setOptions)
      .catch(() => setOptions({ processed_by: [], payment_methods: [] }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGymId]);

  const load = useCallback(async (off: number) => {
    if (!activeGymId) return;
    setLoading(true);
    setError(null);
    if (idFilter.kind === 'invalid') {
      // #3510: an ID no event can have reads as no results, not an error.
      setItems([]); setTotal(0); setOffset(0); setExpanded(new Set()); setLoading(false);
      return;
    }
    try {
      const p = new URLSearchParams({ limit: String(DEFAULT_LIMIT), offset: String(off) });
      appendApiFilters(p, filters);
      if (order === 'asc') p.set('order', 'asc');
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
  }, [activeGymId, filters, order]);

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
    waived: t('billing_events_page.status_waived'),
    cancelled: t('billing_events_page.status_cancelled'),
  };

  return (
    <div>
      {modal}
      <h1 style={{ margin: '0 0 16px' }}>{t('billing_events_page.title')}</h1>

      {/* Filter bar — #2886: each filter narrows server-side; they combine with AND. */}
      <FilterBar>
        <FilterField label={t('billing_events_page.filter_id')} htmlFor="be-filter-id">
          <input
            id="be-filter-id"
            type="search"
            inputMode="numeric"
            value={draft.id}
            placeholder={t('billing_events_page.filter_id_placeholder')}
            onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
            style={{ ...filterControlStyle, width: 110 }}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_member')}>
          <MemberFilter
            value={filters.memberName}
            placeholder={t('billing_events_page.filter_member')}
            onSelect={(m) => patchFilters({ memberId: m.id, memberName: m.name })}
            onClear={() => patchFilters({ memberId: null, memberName: '' })}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_product')} htmlFor="be-filter-product">
          <input
            id="be-filter-product"
            type="search"
            value={draft.product}
            placeholder={t('billing_events_page.filter_product_placeholder')}
            onChange={(e) => setDraft((d) => ({ ...d, product: e.target.value }))}
            style={{ ...filterControlStyle, minWidth: 180 }}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_processed_by')} htmlFor="be-filter-processed-by">
          <select
            id="be-filter-processed-by"
            value={filters.processedBy}
            onChange={(e) => patchFilters({ processedBy: e.target.value })}
            style={filterControlStyle}
          >
            <option value="">{t('billing_events_page.filter_any')}</option>
            {withCurrent(options.processed_by, filters.processedBy).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </FilterField>
        <FilterField label={t('billing_events_page.filter_payment_method')} htmlFor="be-filter-method">
          <select
            id="be-filter-method"
            value={filters.paymentMethod}
            onChange={(e) => patchFilters({ paymentMethod: e.target.value })}
            style={filterControlStyle}
          >
            <option value="">{t('billing_events_page.filter_any')}</option>
            {options.payment_methods.map((m) => (
              <option key={m.code} value={m.code}>{m.name}</option>
            ))}
            {filters.paymentMethod && !options.payment_methods.some((m) => m.code === filters.paymentMethod) && (
              <option value={filters.paymentMethod}>{filters.paymentMethod}</option>
            )}
          </select>
        </FilterField>
        <FilterField label={t('billing_events_page.filter_from')} htmlFor="be-filter-from">
          <input
            id="be-filter-from"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => patchFilters({ from: e.target.value })}
            style={filterControlStyle}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_to')} htmlFor="be-filter-to">
          <input
            id="be-filter-to"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => patchFilters({ to: e.target.value })}
            style={filterControlStyle}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_amount_min')} htmlFor="be-filter-amount-min">
          <input
            id="be-filter-amount-min"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={draft.amountMin}
            onChange={(e) => setDraft((d) => ({ ...d, amountMin: e.target.value }))}
            style={{ ...filterControlStyle, width: 110 }}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_amount_max')} htmlFor="be-filter-amount-max">
          <input
            id="be-filter-amount-max"
            type="number"
            inputMode="decimal"
            step="0.01"
            value={draft.amountMax}
            onChange={(e) => setDraft((d) => ({ ...d, amountMax: e.target.value }))}
            style={{ ...filterControlStyle, width: 110 }}
          />
        </FilterField>
        <FilterField label={t('billing_events_page.filter_status')}>
          <MultiSelectFilter
            label={t('billing_events_page.filter_status')}
            options={STATUS_VALUES.map((v) => ({ value: v, label: statusLabel[v] }))}
            selected={filters.status}
            onChange={(next) => patchFilters({ status: next })}
          />
        </FilterField>
        {filters.userMembershipId && (
          <FilterField label={t('billing_events_page.filter_plan')}>
            <span style={{ ...filterControlStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {filters.planName || `#${filters.userMembershipId}`}
              <button
                type="button"
                aria-label={t('billing_events_page.filter_plan_remove')}
                onClick={() => patchFilters({ userMembershipId: null, planName: '' })}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'inherit' }}
              >✕</button>
            </span>
          </FilterField>
        )}
        {hasActiveFilter(filters) && (
          <button
            type="button"
            onClick={() => {
              setDraft({ id: '', product: '', amountMin: '', amountMax: '' });
              applyFilters(EMPTY_BILLING_EVENT_FILTERS);
            }}
            style={filterButtonStyle}
          >
            {t('billing_events_page.filter_clear')}
          </button>
        )}
      </FilterBar>

      {/* Table */}
      {loading && <p style={{ color: '#888', fontSize: 14 }}>{t('billing_events_page.loading')}</p>}
      {error && <p style={{ color: 'red', fontSize: 14 }}>{error}</p>}

      {!loading && !error && (
        <>
          <BillingEventsTable
            rows={items}
            gym={gymFmt}
            t={t}
            expanded={expanded}
            onToggle={toggleExpand}
            menuItems={menuItems}
            onChanged={reloadCurrentPage}
            canWrite={canWrite}
            readOnlyTitle={readOnlyTitle}
            emptyLabel={t('billing_events_page.empty')}
          />

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
