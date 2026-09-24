'use client';

// #635 stage 7 — the Promotions an Assigned Plan was agreed with.
//
// The issue thread asks for one expandable card per applied Promotion, showing
// its created at / created by / status, and inside it "the same parameters and
// fields of the promotion". Everything rendered here is the application's own
// snapshot (§16): the name, the window, the Billing & Duration and the granted
// Sellable Items at the prices they were agreed at. Editing or deleting the
// Promotion afterwards cannot move any of it — which is exactly why the grant
// lines show their own `unit_price` rather than the catalogue's.
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

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cardSurfaceStyle } from '@/components/ui';
import type { AppliedPromotion, AppliedPromotionGrant } from './types';

const GRANT_SECTIONS: {
  key: 'oneoff_grants' | 'session_grants' | 'periodical_grants';
  titleKey: string;
  emptyKey: string;
  showFrequency: boolean;
}[] = [
  { key: 'oneoff_grants', titleKey: 'benefits_oneoff', emptyKey: 'no_oneoff_benefits', showFrequency: false },
  { key: 'session_grants', titleKey: 'benefits_session', emptyKey: 'no_session_benefits', showFrequency: false },
  { key: 'periodical_grants', titleKey: 'benefits_period', emptyKey: 'no_period_benefits', showFrequency: true },
];

const DURATION_FIELDS = ['free_months', 'paid_months', 'bonus_months'] as const;

interface Props {
  assignedPlanId: number;
  promotions: AppliedPromotion[];
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Re-reads the expanded card, and with it the Billing Events section. */
  onChanged: () => void;
}

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
}

function fmtMoney(v: number | null) {
  return v != null ? `€${v.toFixed(2)}` : '—';
}

export function AssignedPlanPromotions({
  assignedPlanId, promotions, canWrite, readOnlyTitle, onChanged,
}: Props) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');
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
          <div key={p.id} style={cardSt}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
              <button
                onClick={() => setExpanded(isOpen ? null : p.id)}
                disabled={!standing}
                aria-expanded={isOpen}
                style={{ ...titleBtnSt, cursor: standing ? 'pointer' : 'default' }}
              >
                {standing && <span style={{ color: '#888', fontSize: 11 }}>{isOpen ? '▾' : '▸'}</span>}
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
                  <DetailRow label={t('label_start_date')} value={fmtDate(p.starts_at ?? null)} />
                  <DetailRow label={t('label_end_date')} value={fmtDate(p.ends_at ?? null)} />
                  {DURATION_FIELDS.map((field) => (
                    <DetailRow
                      key={field}
                      label={t(`label_${field}` as any)}
                      value={p[field] != null ? t('months_value', { n: p[field] as number }) : t('not_configured')}
                    />
                  ))}
                  {p.revoked_at && <DetailRow label={t('promo_revoked_at')} value={fmtDate(p.revoked_at)} />}
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
                        <DetailRow
                          label={t('promo_action')}
                          value={b.action ? t(`promo_action_${b.action}` as any) : t('not_configured')}
                        />
                        <DetailRow label={t('promo_value')} value={b.value != null ? String(b.value) : '—'} />
                        <DetailRow
                          label={t('promo_duration')}
                          value={b.duration_months != null
                            ? t('months_value', { n: b.duration_months })
                            : t('promo_duration_unbounded')}
                        />
                      </div>
                    ))
                  )}
                </SubSection>

                {GRANT_SECTIONS.map(({ key, titleKey, emptyKey, showFrequency }) => (
                  <SubSection key={key} title={t(titleKey as any)}>
                    <GrantTable
                      rows={p[key] ?? []}
                      emptyLabel={t(emptyKey as any)}
                      showFrequency={showFrequency}
                      t={t}
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
 * The Sellable Items one section of the Promotion granted. Every column is the
 * frozen one — the price above all (§17), which is what makes this table
 * different from the Promotions page's own view of the same benefit.
 */
function GrantTable({ rows, emptyLabel, showFrequency, t }: {
  rows: AppliedPromotionGrant[];
  emptyLabel: string;
  showFrequency: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (rows.length === 0) return <p style={dimSt}>{emptyLabel}</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={thSt}>{t('col_sellable_item')}</th>
          <th style={thSt}>{t('col_quantity')}</th>
          {showFrequency && <th style={thSt}>{t('col_frequency')}</th>}
          <th style={thSt}>{t('col_snapshot_price')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.gym_charge_id ?? 'gone'}-${i}`}>
            <td style={tdSt}>{r.item_name}</td>
            <td style={tdSt}>{r.quantity}</td>
            {showFrequency && (
              <td style={tdSt}>
                {r.item_billing_frequency ? t(`frequency_${r.item_billing_frequency}` as any) : '—'}
              </td>
            )}
            <td style={tdSt}>{fmtMoney(r.unit_price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={subLabelSt}>{title}</div>
      {children}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: 4 }}>
      <span style={{ color: '#888', minWidth: 140, fontSize: 13 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

const cardSt: React.CSSProperties = {
  ...cardSurfaceStyle,
  padding: '10px 14px', marginBottom: 8,
};
const titleBtnSt: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, background: 'none',
  border: 'none', padding: 0, textAlign: 'left', flex: 1, color: 'inherit',
};
const metaSt: React.CSSProperties = { color: '#888', fontSize: 12, whiteSpace: 'nowrap' };
const descSt: React.CSSProperties = { color: '#666', fontSize: 13, margin: '0 0 10px' };
const dimSt: React.CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const subLabelSt: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase',
  letterSpacing: '0.07em', marginBottom: 6,
};
const thSt: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px 4px 0', fontSize: 11, fontWeight: 600,
  color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const tdSt: React.CSSProperties = { padding: '4px 8px 4px 0', fontSize: 13 };
