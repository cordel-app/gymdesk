'use client';

// #635 stage 7 — the Promotions an Assigned Plan was agreed with.
//
// The issue thread asks for one expandable card per applied Promotion, showing
// its created at / created by / status, and inside it "the same parameters and
// fields of the promotion". Everything rendered here is the application's own
// snapshot (§16): the name, the window, the Billing & Duration and the granted
// Products at the prices they were agreed at. Editing or deleting the
// Promotion afterwards cannot move any of it — which is exactly why the grant
// lines are priced from their own frozen `unit_price` and frozen treatment
// rather than from the catalogue (#924 stage 2: the server does that pricing,
// through the one module every Product section quotes from).
//
// A revoked application reads as `inactive`: its checkbox is cleared and its
// card does not expand, because it is no longer part of what this member is
// billed. Clearing the checkbox of a standing one revokes it; ticking a spent
// one back agrees the Promotion again (#635 stage 9 — the thread's Q2 answer,
// "Promotions can be selectable and deselectable"). Either way the server
// recomputes the assignment's price, so the Billing Simulation and the Billing
// Events section below move with it.
//
// Re-applying does not revive the old card: the server writes a *new*
// application with its own snapshot, so the spent one stays on the list as the
// history of what was agreed before. Whether a spent card may be ticked at all
// is the server's `can_reapply` — never re-derived here.
//
// Nothing is computed here (CLAUDE.md: no business logic in the frontend);
// `display_status` is decided server-side by `promotionApplicationStatus()`.
//
// #924 stage 5 — the checkbox is the only write control on this card, so it
// exists only while the card is in Edit mode (#797/#897): expanding the row
// *reads* what the member was agreed, and the revoke/re-apply affordance is
// absent rather than disabled until `⋮ → Edit`. Expanding one application's own
// card is reading and stays available in both modes, as the Membership Plan
// card's collapsible Price History does.

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CardDetailRow } from '@/components/CardDetailRow';
import {
  cardExpandCaretStyle,
  cardExpandToggleStyle,
  cardMutedTextStyle,
  cardSubLabelStyle,
  innerCardStyle,
} from '@/components/formChrome';
import {
  ProductBenefitRow,
  ProductBenefitView,
} from '@/components/ProductBenefits';
import type { AppliedPromotion, AppliedPromotionGrant } from './types';

const GRANT_SECTIONS: {
  key: 'oneoff_grants' | 'session_grants' | 'periodical_grants';
  titleKey: string;
  emptyKey: string;
}[] = [
  // #815 — these headers name the *Promotion*'s granted Products, so they
  // read "One-off / Session / Periodical Promotion". The assignment's own
  // benefit sections (AssignedPlanConfiguration) come from the Membership Plan
  // and keep the Plan's terminology, which is why the keys are promotion-scoped
  // rather than shared with that component.
  //
  // #924 stage 2: there is no `showFrequency` per section any more. All three
  // render the full shared grid, as the Promotion card's own sections do since
  // #919/#920 — a One-off line keeps its Frequency cell with a "—" instead of
  // dropping the column and shifting every column after it out of line (#916).
  { key: 'oneoff_grants', titleKey: 'promo_benefits_oneoff', emptyKey: 'promo_no_oneoff_benefits' },
  { key: 'session_grants', titleKey: 'promo_benefits_session', emptyKey: 'promo_no_session_benefits' },
  { key: 'periodical_grants', titleKey: 'promo_benefits_period', emptyKey: 'promo_no_period_benefits' },
];

/**
 * #896 §3/§4 inside one namespace.
 *
 * The shared grid resolves the treatment under one key name and lets the
 * calling page's messages decide the words — "Promotion" / "No promotion" where
 * a Promotion configures the line, "Benefit" / "No benefit" where a Membership
 * Plan does. Both halves live on *this* page: the sections above come from the
 * Plan and keep `item_action_*`, so the applied-Promotion sections ask for the
 * promotion-voiced `promo_*` keys beside them. Every other key the grid needs
 * (the item, quantity, frequency and price columns) says the same thing in both
 * sections and is shared as it stands.
 */
const PROMOTION_VOICED_KEYS = /^(col_item_action|item_action_)/;

const DURATION_FIELDS = ['free_months', 'paid_months', 'bonus_months'] as const;

interface Props {
  assignedPlanId: number;
  promotions: AppliedPromotion[];
  /**
   * Whether the card is in Edit mode (#797/#897) — the revoke / re-apply
   * checkbox is rendered only inside it.
   */
  cardEditing: boolean;
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Re-reads the expanded card, and with it the Billing Events section. */
  onChanged: () => void;
}

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

export function AssignedPlanPromotions({
  assignedPlanId, promotions, cardEditing, canWrite, readOnlyTitle, onChanged,
}: Props) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');
  // The shared grid's own keys, in this card's two voices — see
  // PROMOTION_VOICED_KEYS above.
  const grantT = (key: string, values?: Record<string, unknown>) =>
    t((PROMOTION_VOICED_KEYS.test(key) ? `promo_${key}` : key) as any, values as any);
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [expanded, setExpanded] = useState<number | null>(null);
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
      if (expanded === promotion.id) setExpanded(null);
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

  if (promotions.length === 0) return <p style={dimSt}>{t('no_promotions')}</p>;

  return (
    <div>
      {promotions.map((p) => {
        const standing = p.display_status !== 'inactive';
        const isOpen = expanded === p.id;
        return (
          <div key={p.id} style={innerCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {cardEditing && (
                <input
                  type="checkbox"
                  checked={standing}
                  disabled={!canWrite || (!standing && !p.can_reapply)}
                  title={!canWrite
                    ? readOnlyTitle
                    : standing
                      ? t('promo_revoke_hint')
                      : p.can_reapply ? t('promo_reapply_hint') : t('promo_reapply_unavailable')}
                  aria-label={t('promo_toggle_label', { promotion: p.promotion_name })}
                  onChange={() => (standing ? setRevoking(p) : setReapplying(p))}
                />
              )}
              <button
                onClick={() => setExpanded(isOpen ? null : p.id)}
                disabled={!standing}
                aria-expanded={isOpen}
                style={{ ...titleBtnSt, cursor: standing ? 'pointer' : 'default' }}
              >
                {standing && <span style={cardExpandCaretStyle}>{isOpen ? '▾' : '▸'}</span>}
                <span style={{ fontWeight: 500, fontSize: 14 }}>{p.promotion_name}</span>
              </button>
              <span style={metaSt}>{t('promo_created_at', { at: fmtDate(p.applied_at) })}</span>
              <span style={metaSt}>{t('promo_created_by', { by: p.applied_by_name ?? t('detail_unknown') })}</span>
              <StatusBadge status={p.display_status} label={tStatus(p.display_status as any)} />
            </div>

            {isOpen && (
              <div style={{ marginTop: 10, paddingLeft: 26 }}>
                {p.promotion_description && <p style={descSt}>{p.promotion_description}</p>}

                {/* The window and durations this member's Promotion was agreed
                    with — the Promotion's own dates may have moved since. */}
                <SubSection title={t('section_billing_duration')}>
                  <CardDetailRow label={t('label_start_date')} value={fmtDate(p.starts_at ?? null)} />
                  <CardDetailRow label={t('label_end_date')} value={fmtDate(p.ends_at ?? null)} />
                  {DURATION_FIELDS.map((field) => (
                    <CardDetailRow
                      key={field}
                      label={t(`label_${field}` as any)}
                      value={p[field] != null ? t('months_value', { n: p[field] as number }) : t('not_configured')}
                    />
                  ))}
                  {p.revoked_at && <CardDetailRow label={t('promo_revoked_at')} value={fmtDate(p.revoked_at)} />}
                </SubSection>

                {/* §6 keeps Membership Fee Benefits off Plans and Assigned
                    Plans — but a *Promotion* has one, and it is the part of the
                    agreement that changes what the membership fee bills, so
                    the card that reproduces the Promotion shows it. */}
                <SubSection title={t('promo_membership_fee_benefit')}>
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
                </SubSection>

                {GRANT_SECTIONS.map(({ key, titleKey, emptyKey }) => (
                  <SubSection key={key} title={t(titleKey as any)}>
                    {/* #924 stage 2 — the one shared Product grid, as the
                        Promotion card's own three sections render it since
                        #919/#920: Product, Quantity, Frequency,
                        Promotion, Agreed Price, Final Price, at the same
                        horizontal positions as the assignment's Plan benefit
                        sections above. What stays this card's own is where the
                        numbers come from — each line's frozen price and frozen
                        treatment (§16/§17), never the Promotion as it stands
                        today.

                        `benefitContext="promotion"` is the option set these
                        grants were configured in (all five, #896 §16), and
                        `frequencyColumn` stays the default `'item'`: #918's
                        renewal Frequency is a Membership Plan Session
                        Benefit's, and a Promotion grant has none. */}
                    <ProductBenefitView
                      t={grantT}
                      emptyKey={emptyKey}
                      rows={(p[key] ?? []).map(toGrantRow)}
                      showFrequency
                      benefitContext="promotion"
                      showPrices
                    />
                  </SubSection>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDialog
        open={revoking !== null}
        message={t('promo_confirm_revoke', { promotion: revoking?.promotion_name ?? '' })}
        confirmLabel={t('promo_revoke_confirm')}
        cancelLabel={t('promo_revoke_dismiss')}
        onConfirm={() => revoking && revoke(revoking)}
        onCancel={() => setRevoking(null)}
        busy={busy}
      />

      {/* Its own confirmation, because the consequence is the opposite one and
          worth stating: the Promotion is agreed again as it stands today, not
          as it was when the spent application froze it. */}
      <ConfirmDialog
        open={reapplying !== null}
        message={t('promo_confirm_reapply', { promotion: reapplying?.promotion_name ?? '' })}
        confirmLabel={t('promo_reapply_confirm')}
        cancelLabel={t('cancel')}
        onConfirm={() => reapplying && reapply(reapplying)}
        onCancel={() => setReapplying(null)}
        busy={busy}
      />
    </div>
  );
}

/**
 * One frozen grant line as the shared grid's row.
 *
 * #924 stage 2: every column is the application's own — the name and Frequency
 * as they were agreed, the treatment the grant was agreed with and the two
 * prices the server computed from the frozen `unit_price` (§17), which is what
 * makes this section different from the Promotions page's own view of the same
 * benefit. `product_status` is 'active' because the snapshot does not carry
 * the catalogue's current state and a frozen line is never "inactive" as far as
 * this application goes; `product_type` likewise is not part of what the
 * snapshot froze, and the grid does not render it.
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


/**
 * One grouping *inside* an application's card — a level below the card's own
 * sections, so it wears `cardSubLabelStyle` rather than the section heading
 * (#929).
 */
function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={subLabelSt}>{title}</div>
      {children}
    </div>
  );
}

// The card an application sits in is #929's `innerCardStyle`, used directly:
// the same one the Member card's plans and the Plan card's nested cards wear.
// #958 — the expand affordance itself is `formChrome`'s now, shared with the
// Member card's Assigned Membership Plan cards; what stays here is this card's
// own use of it (the title fills the row, so the meta and the badge sit right).
const titleBtnSt: React.CSSProperties = { ...cardExpandToggleStyle, flex: 1 };
const metaSt: React.CSSProperties = { color: '#888', fontSize: 12, whiteSpace: 'nowrap' };
const descSt: React.CSSProperties = { color: '#666', fontSize: 13, margin: '0 0 10px' };
const dimSt = cardMutedTextStyle;
const subLabelSt = cardSubLabelStyle;
