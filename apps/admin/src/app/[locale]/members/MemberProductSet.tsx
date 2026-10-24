'use client';

// #1463 — the Products tab organised around the Member's current ProductSet.
//
// Four read-only pieces over one version: its metadata (+ Membership Plan), its
// One-off and Recurring Products, and its Billing Events Forecast; plus the
// Past Product Sets card. Everything is the server's: the version, its frozen
// configuration (`GET /product-sets/:id`) and its forecast
// (`/product-sets/:id/billing-event-simulation`, the engine the nightly run
// prices from). Nothing here creates a Billing Event — configuring, saving and
// paying stay on the existing `/product-sets` workflow (ProductSetsInFlight).

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { StatusBadge } from '@/components/StatusBadge';
import { CardDetailRow } from '@/components/CardDetailRow';
import { BillingEventSimulationChart } from '@/components/BillingEventSimulationChart';
import { BillingEventSimulation, type BillingEventSimulationData } from '@/components/BillingEventSimulation';
import { BILLING_FREQUENCY_NAMESPACE, billingFrequencyLabel } from '@/lib/billingFrequency';
import { cardHintStyle, cardSectionLabelStyle, innerCardStyle } from '@/components/formChrome';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import type { ProductSetSummary } from './membershipConfiguration';
import {
  productSetName,
  productSetProductCount,
  productSetStatusKey,
  splitProductSetProducts,
  type ProductSetConfigurationLike,
  type ProductSetProductLine,
} from './productSetView';

function fmtYmd(ymd: string | null, settings: GymFormatSettings): string | null {
  if (!ymd) return null;
  const out = formatGymDateOnly(ymd, settings);
  return out === '—' ? null : out;
}

function useStatusLabel() {
  const t = useTranslations('members');
  return (set: ProductSetSummary) => {
    const key = productSetStatusKey(set.status, set.expired);
    return key ? t(key as any) : set.status;
  };
}

/** Section: the metadata of the current ProductSet and the Membership Plan it carries. */
export function CurrentProductSetHeader({ set }: { set: ProductSetSummary | null }) {
  const t = useTranslations('members');
  const gymFmt = useGymFormatSettings();
  const statusLabel = useStatusLabel();
  if (!set) return <p style={cardHintStyle}>{t('product_set_none')}</p>;
  const dash = '—';
  return (
    <div>
      <CardDetailRow label={t('product_set_label_name')} value={productSetName(set, t('product_set_no_plan'))} />
      <CardDetailRow label={t('product_set_label_plan')} value={set.plan_name ?? t('product_set_no_plan')} />
      <CardDetailRow label={t('product_set_label_start')} value={fmtYmd(set.starts_at, gymFmt) ?? dash} />
      <CardDetailRow label={t('product_set_label_end')} value={fmtYmd(set.ends_at, gymFmt) ?? t('product_set_open_ended')} />
      <CardDetailRow label={t('product_set_label_created_at')} value={fmtYmd(set.created_at, gymFmt) ?? dash} />
      <CardDetailRow label={t('product_set_label_created_by')} value={set.created_by ?? dash} />
      <CardDetailRow
        label={t('product_set_label_status')}
        value={<StatusBadge status={set.status} label={statusLabel(set)} />}
      />
    </div>
  );
}

/** One group of Product lines — the same component renders One-off and Recurring. */
function ProductLines({ lines }: { lines: ProductSetProductLine[] }) {
  const t = useTranslations('members');
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  if (lines.length === 0) return <p style={cardHintStyle}>{t('product_set_no_products')}</p>;
  return (
    <div>
      {lines.map((l) => {
        const freq = billingFrequencyLabel(l.billingFrequency, (k) => tFreq(k as any));
        return (
          <CardDetailRow
            key={l.key}
            label={l.name}
            value={`${l.quantity} × €${l.unitPrice.toFixed(2)}${freq ? ` · ${freq}` : ''}`}
          />
        );
      })}
    </div>
  );
}

interface ProductSetDetail { configuration?: ProductSetConfigurationLike | null }

/**
 * The version's frozen configuration and forecast, read once per version and
 * status. `render` receives the two groups and the forecast so the host places
 * them under its own section headings.
 */
export function useProductSetDetail(set: ProductSetSummary | null, reloadKey: unknown) {
  const { apiFetch } = useApiClient();
  const [state, setState] = useState<{
    loading: boolean;
    error: boolean;
    products: { oneOff: ProductSetProductLine[]; recurring: ProductSetProductLine[] };
    forecast: BillingEventSimulationData | null;
  }>({ loading: false, error: false, products: { oneOff: [], recurring: [] }, forecast: null });

  const id = set?.id ?? null;
  const status = set?.status ?? null;
  useEffect(() => {
    if (id == null) {
      setState({ loading: false, error: false, products: { oneOff: [], recurring: [] }, forecast: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: false }));
    (async () => {
      try {
        const [detail, forecast] = await Promise.all([
          apiFetch<ProductSetDetail>(`/product-sets/${id}`),
          apiFetch<BillingEventSimulationData>(`/product-sets/${id}/billing-event-simulation`),
        ]);
        if (cancelled) return;
        setState({ loading: false, error: false, products: splitProductSetProducts(detail?.configuration), forecast });
      } catch {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: true }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status, reloadKey]);

  return state;
}

export function ProductSetProducts({ lines, loading, error }: { lines: ProductSetProductLine[]; loading: boolean; error: boolean }) {
  const t = useTranslations('members');
  if (loading) return <p style={cardHintStyle}>{t('product_set_loading')}</p>;
  if (error) return <p style={cardHintStyle}>{t('product_set_error')}</p>;
  return <ProductLines lines={lines} />;
}

/** The Billing Events Forecast: expected events, computed on read and persisted nowhere. */
export function ProductSetForecast({ forecast, loading, error, chartSimulation }: {
  forecast: BillingEventSimulationData | null; loading: boolean; error: boolean;
  /** #1951 — the unfiltered simulation the chart plots; defaults to `forecast`. */
  chartSimulation?: BillingEventSimulationData | null;
}) {
  const t = useTranslations('members');
  const tPlan = useTranslations('assigned_plans_page');
  const gymFmt = useGymFormatSettings();
  if (loading) return <p style={cardHintStyle}>{t('product_set_loading')}</p>;
  if (error) return <p style={cardHintStyle}>{t('product_set_error')}</p>;
  const translate = (key: string, values?: Record<string, string | number>) => tPlan(key as any, values as any);
  const formatDate = (date: string) => fmtYmd(date, gymFmt) ?? date;
  return (
    <>
      {/* #1951 — the chart plots every period, €0.00 ones included, whatever the
          list below hides: it is fed the unfiltered simulation with showZero. */}
      <BillingEventSimulationChart
        simulation={chartSimulation ?? forecast}
        showZero
        t={translate}
        formatDate={formatDate}
      />
      <BillingEventSimulation simulation={forecast} t={translate} formatDate={formatDate} />
    </>
  );
}

/** The Past Product Sets card: previous versions, clearly history, newest first. */
export function PastProductSets({ sets }: { sets: ProductSetSummary[] }) {
  const t = useTranslations('members');
  const gymFmt = useGymFormatSettings();
  const [open, setOpen] = useState(false);
  if (sets.length === 0) return <p style={cardHintStyle}>{t('product_set_past_none')}</p>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', fontSize: 13 }}
      >
        {open ? '▾' : '▸'} {t('product_set_past_count', { count: sets.length })}
      </button>
      {open && sets.map((s) => (
        <div key={s.id} data-product-set-id={s.id} style={{ marginTop: 8, opacity: 0.85 }}>
          <CardDetailRow
            label={productSetName(s, t('product_set_no_plan'))}
            value={`${fmtYmd(s.starts_at, gymFmt) ?? '—'} → ${fmtYmd(s.ends_at, gymFmt) ?? t('product_set_open_ended')} · ${t('product_set_status_superseded')}`}
          />
        </div>
      ))}
    </div>
  );
}

/** The Membership Plan's own lifecycle status, kept apart from the version's (#1490). */
function planStatusLabel(status: string | null | undefined, t: (k: string) => string): string {
  if (!status) return '—';
  const key = `product_set_plan_status_${status}`;
  return ['active', 'inactive', 'expired'].includes(status) ? t(key) : status;
}

/**
 * #1490 — the current ProductSet as one card titled *Recurring*: a header (plan,
 * product count, created at/by, Membership Plan status), a `⋮` with Details and
 * Edit, and three cards inside — Membership Plan, Recurring Products and Past
 * Product Sets. Presentation only: Edit hands over to the existing Assigned Plan
 * workflow (`onEdit`) and nothing here writes a Billing Event or Payment Request.
 */
export function CurrentProductSetCard({
  set, products, loading, error, pastSets, canWrite, onEdit,
}: {
  set: ProductSetSummary | null;
  products: { oneOff: ProductSetProductLine[]; recurring: ProductSetProductLine[] };
  loading: boolean;
  error: boolean;
  pastSets: ProductSetSummary[];
  canWrite: boolean;
  onEdit: () => void;
}) {
  const t = useTranslations('members');
  const gymFmt = useGymFormatSettings();
  const statusLabel = useStatusLabel();
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!set) {
    return (
      <div style={innerCardStyle}>
        <div style={cardSectionLabelStyle}>{t('product_set_card_title')}</div>
        <p style={cardHintStyle}>{t('product_set_none')}</p>
        <PastProductSetsCard sets={pastSets} />
      </div>
    );
  }
  const dash = '—';
  const count = productSetProductCount(products);
  const editable = canWrite && set.status !== 'superseded' && !set.expired;
  return (
    <div style={innerCardStyle} data-product-set-id={set.id}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={cardSectionLabelStyle}>{t('product_set_card_title')}</div>
          <CardDetailRow label={t('product_set_label_name')} value={set.plan_name ?? t('product_set_no_plan')} />
          <CardDetailRow label={t('product_set_label_product_count')} value={loading || error ? dash : String(count)} />
          <CardDetailRow label={t('product_set_label_created_at')} value={fmtYmd(set.created_at, gymFmt) ?? dash} />
          <CardDetailRow label={t('product_set_label_created_by')} value={set.created_by ?? dash} />
          <CardDetailRow label={t('product_set_label_plan_status')} value={planStatusLabel(set.plan_status, (k) => t(k as any))} />
        </div>
        <ContextMenu
          ariaLabel={t('product_set_card_title')}
          items={[
            { label: t('action_details'), onClick: () => setDetailsOpen(true) },
            { label: t('edit'), onClick: onEdit, disabled: !editable },
          ]}
        />
      </div>

      <div style={innerCardStyle}>
        <div style={cardSectionLabelStyle}>{t('product_set_card_plan')}</div>
        <CardDetailRow label={t('product_set_label_plan')} value={set.plan_name ?? t('product_set_no_plan')} />
        <CardDetailRow label={t('product_set_label_start')} value={fmtYmd(set.starts_at, gymFmt) ?? dash} />
        <CardDetailRow label={t('product_set_label_end')} value={fmtYmd(set.ends_at, gymFmt) ?? t('product_set_open_ended')} />
        <CardDetailRow label={t('product_set_label_plan_status')} value={planStatusLabel(set.plan_status, (k) => t(k as any))} />
      </div>

      <div style={innerCardStyle}>
        <div style={cardSectionLabelStyle}>{t('section_recurring_products')}</div>
        <ProductSetProducts lines={products.recurring} loading={loading} error={error} />
      </div>

      <PastProductSetsCard sets={pastSets} />

      <CrudModal
        open={detailsOpen}
        title={t('product_set_details_title')}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetailsOpen(false)}
        onSave={() => setDetailsOpen(false)}
        extraFooter={<ViewAuditLogButton entityType="product_set" entityId={set.id} onNavigate={() => setDetailsOpen(false)} />}
      >
        <CurrentProductSetHeader set={set} />
        <CardDetailRow label={t('product_set_label_plan_status')} value={planStatusLabel(set.plan_status, (k) => t(k as any))} />
        <CardDetailRow label={t('product_set_label_product_count')} value={String(count)} />
        <p style={{ ...cardHintStyle, marginTop: 8 }}>{statusLabel(set)}</p>
      </CrudModal>
    </div>
  );
}

function PastProductSetsCard({ sets }: { sets: ProductSetSummary[] }) {
  const t = useTranslations('members');
  return (
    <div style={innerCardStyle}>
      <div style={cardSectionLabelStyle}>{t('section_past_product_sets')}</div>
      <PastProductSets sets={sets} />
    </div>
  );
}
