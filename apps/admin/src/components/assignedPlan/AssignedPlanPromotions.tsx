'use client';

// #2478 — the Promotions an Assigned Plan was agreed with, drawn where they act.
//
// Until this ticket every application was a card in a separate Promotions
// section under the Products. Now each application is a nested, indented row
// directly under every Product line one of its grants names (an application
// that names none — a Membership Fee Promotion — sits under the Membership
// Fee), and its full configuration is a detail modal opened from its circular
// thumbnail or its name. `promotionPlacement.ts` decides where a row goes; this
// file draws the row, the checkbox and the two modals.
//
// What did not move (#635 stages 7/9, #924 stage 5): everything shown is the
// application's own snapshot (§16) — its name, window, Membership Fee Benefit
// and the granted Products at the prices they were agreed at — except the two
// illustrations and the targeted plans, which no snapshot froze and which are
// display only. The checkbox is the only write control, it exists only while
// the card is in Edit mode, clearing it revokes the standing application and
// ticking a spent one re-applies the Promotion as it stands today, each behind
// its own confirmation; `can_reapply` and `display_status` are the server's.
// One application drawn under two Products is still one application: both rows
// drive the same revoke, so its effect is never counted twice. Nothing is
// priced here (#817).

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, formatGymDateOnly, type GymFormatSettings } from '@/lib/gymFormat';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CardDetailRow } from '@/components/CardDetailRow';
import { NavIcon } from '@/components/icons/NavIcons';
import type { NavIconName } from '@/components/icons/navIconNames';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';
import { cardMutedTextStyle, cardSubLabelStyle } from '@/components/formChrome';
import {
  ProductBenefitRow,
  ProductBenefitView,
  benefitTreatmentLabel,
} from '@/components/ProductBenefits';
import { thumbnailSrc } from './promotionPlacement';
import type { AppliedPromotion, AppliedPromotionGrant, AssignedPlanSnapshotBenefit } from './types';

const GRANT_SECTIONS: {
  key: 'oneoff_grants' | 'session_grants' | 'periodical_grants';
  titleKey: string;
  emptyKey: string;
}[] = [
  // #815 — these headers name the *Promotion*'s granted Products, so they
  // read "One-off / Session / Periodical Promotion", never the Plan's wording.
  // #924 stage 2: all three render the full shared grid, a One-off line keeping
  // its Frequency cell with a "—" (#916).
  { key: 'oneoff_grants', titleKey: 'promo_benefits_oneoff', emptyKey: 'promo_no_oneoff_benefits' },
  { key: 'session_grants', titleKey: 'promo_benefits_session', emptyKey: 'promo_no_session_benefits' },
  { key: 'periodical_grants', titleKey: 'promo_benefits_period', emptyKey: 'promo_no_period_benefits' },
];

/**
 * #896 §3/§4 inside one namespace: the grid resolves the treatment under one
 * key name, so the applied-Promotion grids ask for the promotion-voiced
 * `promo_*` keys ("Promotion" / "No promotion") while the Plan's own sections
 * keep `item_action_*` ("Benefit").
 */
const PROMOTION_VOICED_KEYS = /^(col_item_action|item_action_)/;

const DURATION_FIELDS = ['free_months', 'paid_months', 'bonus_months'] as const;

function fmtDate(iso: string | null, s: GymFormatSettings) {
  return iso ? formatGymDate(iso, s) : '—';
}

/** A stored calendar day (not an instant): never moved across a time zone. */
function fmtDay(iso: string | null, s: GymFormatSettings) {
  return iso ? formatGymDateOnly(iso, s) : '—';
}

// ─── The checkbox: revoke / re-apply ──────────────────────────────────────────

export interface PromotionToggleGate {
  /** Whether the card is in Edit mode (#797/#897) — outside it there is no checkbox. */
  cardEditing: boolean;
  canWrite: boolean;
  readOnlyTitle?: string;
}

/**
 * The revoke / re-apply control and its two confirmations, once per card: every
 * nested row of one application draws `checkbox(p)` against the same state, so
 * revoking from either Product row revokes the one application.
 */
export function useAppliedPromotionToggle(assignedPlanId: number, onChanged: () => void) {
  const t = useTranslations('assigned_plans_page');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [revoking, setRevoking] = useState<AppliedPromotion | null>(null);
  const [reapplying, setReapplying] = useState<AppliedPromotion | null>(null);
  const [busy, setBusy] = useState(false);

  async function revoke(promotion: AppliedPromotion) {
    setBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/promotions/${promotion.promotion_id}`, {
        method: 'DELETE',
      });
      setRevoking(null);
      onChanged();
    } catch (err: any) {
      setRevoking(null);
      toast(err.message ?? t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  // The apply endpoint, not a resurrection of this application: the server
  // creates a new one, snapshotting the Promotion as it stands today, and
  // refuses it with its own message when the Promotion no longer qualifies.
  async function reapply(promotion: AppliedPromotion) {
    setBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/promotions`, {
        method: 'POST',
        body: JSON.stringify({ promotion_id: promotion.promotion_id }),
      });
      setReapplying(null);
      onChanged();
    } catch (err: any) {
      setReapplying(null);
      toast(err.message ?? t('error_generic'));
    } finally {
      setBusy(false);
    }
  }

  function checkbox(p: AppliedPromotion, gate: PromotionToggleGate): React.ReactNode {
    if (!gate.cardEditing) return null;
    const standing = p.display_status !== 'inactive';
    return (
      <input
        type="checkbox"
        checked={standing}
        disabled={!gate.canWrite || (!standing && !p.can_reapply)}
        title={!gate.canWrite
          ? gate.readOnlyTitle
          : standing
            ? t('promo_revoke_hint')
            : p.can_reapply ? t('promo_reapply_hint') : t('promo_reapply_unavailable')}
        aria-label={t('promo_toggle_label', { promotion: p.promotion_name })}
        onChange={() => (standing ? setRevoking(p) : setReapplying(p))}
      />
    );
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={revoking !== null}
        message={t('promo_confirm_revoke', { promotion: revoking?.promotion_name ?? '' })}
        confirmLabel={t('promo_revoke_confirm')}
        cancelLabel={t('promo_revoke_dismiss')}
        onConfirm={() => revoking && revoke(revoking)}
        onCancel={() => setRevoking(null)}
        busy={busy}
      />
      {/* Its own confirmation, because the consequence is the opposite one:
          the Promotion is agreed again as it stands today, not as it was when
          the spent application froze it. */}
      <ConfirmDialog
        open={reapplying !== null}
        message={t('promo_confirm_reapply', { promotion: reapplying?.promotion_name ?? '' })}
        confirmLabel={t('promo_reapply_confirm')}
        cancelLabel={t('cancel')}
        onConfirm={() => reapplying && reapply(reapplying)}
        onCancel={() => setReapplying(null)}
        busy={busy}
      />
    </>
  );

  return { checkbox, dialogs };
}

// ─── Thumbnail ────────────────────────────────────────────────────────────────

/**
 * A circular thumbnail that opens a detail modal. Nothing at all — no
 * placeholder, no reserved space — when there is no image. Its own button,
 * and the click stops there, so it never selects, edits or ticks anything.
 */
export function CircularThumbnail({ src, label, onOpen, size = 28 }: {
  src: string | null;
  label: string;
  onOpen: () => void;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(); }}
      style={{ ...thumbButtonSt, width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src} alt="" loading="lazy" onError={() => setBroken(true)}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block' }}
      />
    </button>
  );
}

// ─── The nested row ───────────────────────────────────────────────────────────

/**
 * One application, indented under the Product it affects (or under the
 * Membership Fee): checkbox, thumbnail, name, the grant's discount and the
 * status. Secondary type so the Product stays the primary item.
 */
export function NestedPromotionRow({ promotion, grant, checkbox, onOpen }: {
  promotion: AppliedPromotion;
  /** The application's grant for the parent Product; absent under the Membership Fee. */
  grant?: AppliedPromotionGrant;
  checkbox: React.ReactNode;
  onOpen: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  const tp = useTranslations('promotions');
  const tStatus = useTranslations('status');
  const discount = grant
    ? benefitTreatmentLabel(tp as any, 'promotion', { action: grant.action, value: grant.value } as any)
    : feeBenefitLabel(promotion, t);
  return (
    <div style={nestedRowSt}>
      {checkbox}
      <CircularThumbnail
        src={thumbnailSrc(promotion.promotion_image_thumbnail_url, promotion.promotion_image_url)}
        label={t('promo_open_details', { promotion: promotion.promotion_name })}
        onOpen={onOpen}
        size={24}
      />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        title={t('promo_open_details', { promotion: promotion.promotion_name })}
        style={nameBtnSt}
      >
        {promotion.promotion_name}
      </button>
      {discount && <span style={metaSt}>{discount}</span>}
      <StatusBadge status={promotion.display_status} label={tStatus(promotion.display_status as any)} />
    </div>
  );
}

/** The Membership Fee Benefit an application carries, in a few words; null when none. */
function feeBenefitLabel(
  p: AppliedPromotion, t: ReturnType<typeof useTranslations>,
): string | null {
  const b = p.membership_fee_benefits.find((x) => x.enabled && x.action && x.action !== 'no_benefit');
  if (!b) return null;
  const action = t(`promo_action_${b.action}` as any);
  return b.value != null ? `${action} ${b.value}` : action;
}

// ─── Detail modals ────────────────────────────────────────────────────────────

/** A modal section: its own icon from the app's icon set, then the title. */
function DetailSection({ icon, title, children }: {
  icon: NavIconName; title: string; children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 18 }}>
      <div style={sectionHeadSt}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: '#666' }}><NavIcon name={icon} /></span>
        <span style={subLabelSt}>{title}</span>
      </div>
      {children}
    </section>
  );
}

/** A Product line's detail: its image at full resolution, name and description. */
export function ProductDetailModal({ product, onClose }: {
  product: AssignedPlanSnapshotBenefit | null;
  onClose: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  return (
    <ProfessionalServiceImageModal
      target={product ? {
        name: product.item_name,
        imageUrl: product.image_url ?? null,
        description: product.description ?? null,
      } : null}
      onClose={onClose}
      closeLabel={t('close')}
      noImageLabel={t('detail_no_image')}
      noDescriptionLabel={t('detail_no_description')}
    />
  );
}

/**
 * An application's detail: image, name, description, its agreed window, the
 * Membership Plans and Products it includes with their discounts.
 */
export function PromotionDetailModal({ promotion, onClose }: {
  promotion: AppliedPromotion | null;
  onClose: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');
  const gymFmt = useGymFormatSettings();
  const grantT = (key: string, values?: Record<string, unknown>) =>
    t((PROMOTION_VOICED_KEYS.test(key) ? `promo_${key}` : key) as any, values as any);
  const p = promotion;
  return (
    <ProfessionalServiceImageModal
      target={p ? {
        name: p.promotion_name,
        imageUrl: p.promotion_image_url ?? null,
        description: p.promotion_description,
      } : null}
      onClose={onClose}
      closeLabel={t('close')}
      noImageLabel={t('detail_no_image')}
      noDescriptionLabel={t('detail_no_description')}
    >
      {p && (
        <>
          {/* The window and durations this member's Promotion was agreed
              with — the Promotion's own dates may have moved since. */}
          <DetailSection icon="calendar" title={t('promo_detail_validity')}>
            <CardDetailRow label={t('label_start_date')} value={fmtDay(p.starts_at ?? null, gymFmt)} />
            <CardDetailRow label={t('label_end_date')} value={fmtDay(p.ends_at ?? null, gymFmt)} />
            {DURATION_FIELDS.map((field) => (
              <CardDetailRow
                key={field}
                label={t(`label_${field}` as any)}
                value={p[field] != null ? t('months_value', { n: p[field] as number }) : t('not_configured')}
              />
            ))}
          </DetailSection>

          <DetailSection icon="shield" title={t('promo_detail_application')}>
            <CardDetailRow label={t('promo_detail_status')} value={tStatus(p.display_status as any)} />
            <CardDetailRow label={t('promo_detail_applied_at')} value={fmtDate(p.applied_at, gymFmt)} />
            <CardDetailRow label={t('promo_detail_applied_by')} value={p.created_by ?? t('detail_unknown')} />
            {p.revoked_at && <CardDetailRow label={t('promo_revoked_at')} value={fmtDate(p.revoked_at, gymFmt)} />}
          </DetailSection>

          {/* Membership Plans: the plans the Promotion targets and the
              discount it gives their Membership Fee (the application's own
              frozen Membership Fee Benefit). */}
          <DetailSection icon="creditCard" title={t('promo_detail_included_plans')}>
            {(p.included_plans ?? []).length === 0 ? (
              <p style={dimSt}>{t('promo_detail_no_plans')}</p>
            ) : (
              <ul style={listSt}>
                {(p.included_plans ?? []).map((plan) => <li key={plan.id}>{plan.name}</li>)}
              </ul>
            )}
            {p.membership_fee_benefits.length === 0 ? (
              <p style={dimSt}>{t('promo_no_membership_fee_benefit')}</p>
            ) : (
              p.membership_fee_benefits.map((b, i) => (
                <div key={i}>
                  <CardDetailRow
                    label={t('promo_action')}
                    value={b.action ? t(`promo_action_${b.action}` as any) : t('not_configured')}
                  />
                  <CardDetailRow label={t('promo_value')} value={b.value != null ? String(b.value) : '—'} />
                  <CardDetailRow
                    label={t('promo_duration')}
                    value={b.duration_months != null
                      ? t('months_value', { n: b.duration_months })
                      : t('promo_duration_unbounded')}
                  />
                </div>
              ))
            )}
          </DetailSection>

          {/* Products: each grant at the price and with the treatment it was
              agreed with (§16/§17), in the Promotion's option set. */}
          <DetailSection icon="banknote" title={t('promo_detail_included_products')}>
            {GRANT_SECTIONS.map(({ key, titleKey, emptyKey }) => (
              <div key={key} style={{ marginBottom: 10 }}>
                <div style={grantTitleSt}>{t(titleKey as any)}</div>
                <ProductBenefitView
                  t={grantT}
                  emptyKey={emptyKey}
                  rows={(p[key] ?? []).map(toGrantRow)}
                  showFrequency
                  benefitContext="promotion"
                  showPrices
                />
              </div>
            ))}
          </DetailSection>
        </>
      )}
    </ProfessionalServiceImageModal>
  );
}

/**
 * One frozen grant line as the shared grid's row — every column the
 * application's own (#924 stage 2). `product_status` is 'active' because the
 * snapshot does not carry the catalogue's current state.
 */
function toGrantRow(g: AppliedPromotionGrant): ProductBenefitRow {
  return {
    product_id: g.product_id ?? 0,
    quantity: g.quantity,
    product_name: g.item_name,
    product_type: '',
    product_billing_frequency: g.item_billing_frequency,
    product_status: 'active',
    action: g.action,
    value: g.value,
    original_price_incl_tax: g.original_price_incl_tax,
    final_price_incl_tax: g.final_price_incl_tax,
    original_line_price_incl_tax: g.original_line_price_incl_tax,
    final_line_price_incl_tax: g.final_line_price_incl_tax,
  };
}

const thumbButtonSt: React.CSSProperties = {
  padding: 0, border: 'none', background: 'none', cursor: 'pointer',
  borderRadius: '50%', flexShrink: 0, lineHeight: 0,
};
const nestedRowSt: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  margin: '0 0 4px 16px', padding: '4px 0 4px 10px', borderLeft: '2px solid #e5e5e5',
  fontSize: 12.5, color: '#555',
};
const nameBtnSt: React.CSSProperties = {
  padding: 0, border: 'none', background: 'none', cursor: 'pointer',
  font: 'inherit', color: 'inherit', fontWeight: 500, textAlign: 'left',
};
const metaSt: React.CSSProperties = { color: '#888', fontSize: 12 };
const sectionHeadSt: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
};
const grantTitleSt: React.CSSProperties = { fontSize: 12, color: '#666', margin: '6px 0 2px' };
const listSt: React.CSSProperties = { margin: '0 0 8px', paddingLeft: 18, fontSize: 13 };
const dimSt = cardMutedTextStyle;
const subLabelSt = cardSubLabelStyle;
