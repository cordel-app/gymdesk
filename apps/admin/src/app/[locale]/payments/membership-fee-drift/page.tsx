'use client';

/**
 * #635 stage 14: Payments → Membership Fee Drift.
 *
 * Stage 12 corrected "what does the Membership Fee cost on this date" and put
 * the correction behind `billing.date_aware_membership_fee` (seeded off,
 * migration 186), because switching it on moves real money: an assignment whose
 * Promotion's months have elapsed stops being discounted. The thread asked for
 * that impact to be *surfaced and reviewed* before the nightly run acts on it,
 * and stage 12 produced the report as an API endpoint. This page is where it is
 * read — the endpoint alone is not something a gym admin can review.
 *
 * Read-only end to end: it issues one GET and has no write control, no flag
 * switch and no "apply". Switching the flag on stays a deliberate act elsewhere
 * (Cordel → Feature Flags), with this page as the evidence for it.
 *
 * Every number comes from the API, which prices each cycle with the nightly
 * run's own `priceDueMembershipFee()` under both rules: there is exactly one
 * implementation of the Membership Fee (#635 stage 12), so nothing here
 * re-derives a price the run would not produce.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, FilterField, filterButtonStyle, filterControlStyle } from '@/components/FilterBar';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { cardSurfaceStyle } from '@/components/ui';

// ── Types (the shape of GET /user-memberships/reports/membership-fee-drift) ───

interface DriftPromotion {
  user_membership_promotion_id: number;
  promotion_id: number;
  name: string | null;
  applied_at: string;
  free_months: number;
  paid_months: number;
  bonus_months: number;
  /** Last date the Promotion's timeline covers; null when it has no months. */
  benefit_ends_on: string | null;
  has_membership_fee_benefit: boolean;
}

interface DriftItem {
  user_membership_id: number;
  member_id: number;
  member_name: string | null;
  plan_name: string | null;
  billing_date: string;
  stored_final_price: number | null;
  regular_fee: number | null;
  charged_amount: number;
  resolved_amount: number;
  difference: number;
  promotions: DriftPromotion[];
}

interface MembershipFeeDriftReport {
  date_aware_pricing_enabled: boolean;
  examined: number;
  items: DriftItem[];
  total_difference: number;
}

type DirectionFilter = 'all' | 'increase' | 'decrease';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtAmount = (n: number | null) => (n == null || isNaN(n) ? '—' : n.toFixed(2));

/** A signed amount, so "would pay more" and "would pay less" read differently. */
const fmtSigned = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}`;

function fmtDate(isoDate: string | null, locale: string) {
  if (!isoDate) return '—';
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return '—';
  // The API's dates are plain YYYY-MM-DD billing dates, so they are formatted in
  // UTC — a billing date must not shift a day because of the viewer's zone.
  return d.toLocaleDateString(locale, { dateStyle: 'medium', timeZone: 'UTC' });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MembershipFeeDriftPage() {
  const t = useTranslations('membership_fee_drift');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, isSuperadmin, loading: gymLoading } = useGym();
  const { isImpersonating } = useImpersonation();
  const { flags, loading: flagsLoading } = useFeatureFlags();
  const { canRead } = useModuleAccess('PAYMENTS');
  const { toast } = useToast();

  const [report, setReport] = useState<MembershipFeeDriftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Same rule the sidebar applies (#439): the superadmin flag bypass only holds
  // in native capacity — while impersonating, the impersonated user's flags win.
  const flagEnabled = (isSuperadmin && !isImpersonating)
    || (flags['payments'] !== false && flags['payments.membership_fee_drift'] !== false);

  useEffect(() => {
    if (gymLoading || flagsLoading) return;
    if (!canRead || !flagEnabled) router.replace(`/${locale}`);
  }, [gymLoading, flagsLoading, canRead, flagEnabled]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setReport(await apiFetch<MembershipFeeDriftReport>('/user-memberships/reports/membership-fee-drift'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGymId]);

  useEffect(() => {
    if (!gymLoading && !flagsLoading && canRead && flagEnabled) load();
  }, [activeGymId, gymLoading, flagsLoading]);

  // Filtering is client-side on purpose: the endpoint returns the whole report
  // (one row per *affected* assignment, so a handful at most) and re-fetching it
  // per keystroke would re-price every assignment of the gym.
  const rows = useMemo(() => {
    const items = report?.items ?? [];
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (direction === 'increase' && i.difference <= 0) return false;
      if (direction === 'decrease' && i.difference >= 0) return false;
      if (!q) return true;
      return (i.member_name ?? '').toLowerCase().includes(q)
        || (i.plan_name ?? '').toLowerCase().includes(q);
    });
  }, [report, search, direction]);

  const hasFilters = search.trim() !== '' || direction !== 'all';

  function toggleExpand(row: DriftItem) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(row.user_membership_id)) next.delete(row.user_membership_id);
      else next.add(row.user_membership_id);
      return next;
    });
  }

  const increases = report?.items.filter((i) => i.difference > 0).length ?? 0;

  const cards = report ? [
    { key: 'examined', value: String(report.examined), hint: t('card_examined_hint') },
    { key: 'affected', value: String(report.items.length), hint: t('card_affected_hint') },
    { key: 'increases', value: String(increases), hint: t('card_increases_hint') },
    { key: 'total_difference', value: fmtSigned(report.total_difference), hint: t('card_total_difference_hint') },
  ] : [];

  const columns: Column<DriftItem>[] = [
    {
      header: t('col_member'),
      render: (row) => (
        <>
          <div style={{ fontWeight: 500 }}>{row.member_name ?? '—'}</div>
          <div style={{ fontWeight: 400, fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>
            {t('label_assignment')}: #{row.user_membership_id}
          </div>
        </>
      ),
    },
    {
      header: t('col_plan'),
      render: (row) => <span style={{ color: 'var(--gd-text-muted, #6b7280)' }}>{row.plan_name ?? '—'}</span>,
    },
    {
      header: t('col_billing_date'),
      render: (row) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDate(row.billing_date, locale)}</span>,
    },
    {
      header: t('col_charged'),
      render: (row) => <span style={numberCellStyle}>{fmtAmount(row.charged_amount)}</span>,
    },
    {
      header: t('col_resolved'),
      render: (row) => <span style={numberCellStyle}>{fmtAmount(row.resolved_amount)}</span>,
    },
    {
      header: t('col_difference'),
      render: (row) => (
        <span style={{ ...numberCellStyle, fontWeight: 600, color: differenceColor(row.difference) }}>
          {fmtSigned(row.difference)}
        </span>
      ),
    },
    {
      header: t('col_promotions'),
      render: (row) => (
        <span style={{ color: 'var(--gd-text-muted, #6b7280)' }}>
          {row.promotions.length === 0
            ? t('no_promotions')
            : row.promotions.map((p) => p.name ?? `#${p.promotion_id}`).join(', ')}
        </span>
      ),
    },
  ];

  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 20px', color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('subtitle')}</p>

      {report && (
        <div style={report.date_aware_pricing_enabled ? bannerLiveStyle : bannerPendingStyle}>
          <strong>
            {report.date_aware_pricing_enabled ? t('banner_live_title') : t('banner_pending_title')}
          </strong>
          <div style={{ marginTop: 4 }}>
            {report.date_aware_pricing_enabled ? t('banner_live_body') : t('banner_pending_body')}
          </div>
        </div>
      )}

      {report && (
        <div style={gridStyle}>
          {cards.map((card) => (
            <div key={card.key} style={cardStyle}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--gd-text, #1a1a2e)' }}>
                {t(`card_${card.key}`)}
              </div>
              <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--gd-text, #1a1a2e)', marginTop: 12, lineHeight: 1.1 }}>
                {card.value}
              </div>
              <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginTop: 4 }}>{card.hint}</div>
            </div>
          ))}
        </div>
      )}

      <h2 style={sectionTitleStyle}>{t('affected_assignments')}</h2>

      {/* The shared labelled filter bar (#724) — no second look for this list. */}
      <FilterBar>
        <FilterField label={t('filter_search')} htmlFor="drift-search">
          <input
            id="drift-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('filter_search_placeholder')}
            style={{ ...filterControlStyle, minWidth: 200 }}
          />
        </FilterField>
        <FilterField label={t('filter_direction')} htmlFor="drift-direction">
          <select
            id="drift-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as DirectionFilter)}
            style={filterControlStyle}
          >
            <option value="all">{t('direction_all')}</option>
            <option value="increase">{t('direction_increase')}</option>
            <option value="decrease">{t('direction_decrease')}</option>
          </select>
        </FilterField>
        {hasFilters && (
          <button onClick={() => { setSearch(''); setDirection('all'); }} style={filterButtonStyle}>
            {t('filter_clear')}
          </button>
        )}
      </FilterBar>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.user_membership_id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={hasFilters ? t('no_matches') : t('empty')}
        expandedRowKeys={expandedIds}
        onToggleExpand={toggleExpand}
        renderExpanded={(row) => <DriftDetails row={row} locale={locale} />}
      />
    </div>
  );
}

// ── Expanded row ──────────────────────────────────────────────────────────────

/**
 * Why this assignment drifts: the stored price it is charged from, the regular
 * fee the corrected rule discounts from, and each applied Promotion's own
 * timeline with the date its Membership Fee Benefit stops.
 */
function DriftDetails({ row, locale }: { row: DriftItem; locale: string }) {
  const t = useTranslations('membership_fee_drift');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        <Field label={t('det_stored_final_price')}>{fmtAmount(row.stored_final_price)}</Field>
        <Field label={t('det_regular_fee')}>{fmtAmount(row.regular_fee)}</Field>
        <Field label={t('det_billing_date')}>{fmtDate(row.billing_date, locale)}</Field>
        <Field label={t('det_difference')}>
          <span style={{ fontWeight: 600, color: differenceColor(row.difference) }}>{fmtSigned(row.difference)}</span>
        </Field>
      </div>

      <div>
        <div style={sectionTitleStyle}>{t('det_promotions')}</div>
        {row.promotions.length === 0 ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--gd-text-muted, #6b7280)' }}>{t('no_promotions')}</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {row.promotions.map((p) => (
              // Keyed per *application* (#635 stage 9) — an assignment may hold
              // the same Promotion more than once over time.
              <li key={p.user_membership_promotion_id}>
                <strong>{p.name ?? `#${p.promotion_id}`}</strong>
                {' — '}
                {t('det_applied_at')}: {fmtDate(p.applied_at, locale)}
                {' · '}
                {t('det_timeline', { free: p.free_months, paid: p.paid_months, bonus: p.bonus_months })}
                {' · '}
                {t('det_benefit_ends_on')}: {p.benefit_ends_on ? fmtDate(p.benefit_ends_on, locale) : t('det_no_timeline')}
                {!p.has_membership_fee_benefit && (
                  <span style={{ color: 'var(--gd-text-muted, #6b7280)' }}> · {t('det_no_fee_benefit')}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <ViewAuditLogButton entityType="user_membership" entityId={row.user_membership_id} size="small" />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{children}</div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

/** Positive means the member would pay more once the correction is live. */
const differenceColor = (n: number) =>
  n > 0 ? 'var(--gd-danger, #b91c1c)' : n < 0 ? 'var(--gd-success, #15803d)' : 'inherit';

const numberCellStyle: React.CSSProperties = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 12px', fontSize: 12, fontWeight: 600, color: 'var(--gd-section-heading-text, #888888)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};

const gridStyle: React.CSSProperties = {
  display: 'grid', gap: 16, marginBottom: 24,
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
};

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, padding: '18px 20px' };

const bannerBase: React.CSSProperties = {
  ...cardSurfaceStyle, padding: '14px 16px', marginBottom: 20, fontSize: 14,
  borderLeftWidth: 4, borderLeftStyle: 'solid',
};

const bannerPendingStyle: React.CSSProperties = { ...bannerBase, borderLeftColor: 'var(--gd-warning, #b45309)' };

const bannerLiveStyle: React.CSSProperties = { ...bannerBase, borderLeftColor: 'var(--gd-success, #15803d)' };
