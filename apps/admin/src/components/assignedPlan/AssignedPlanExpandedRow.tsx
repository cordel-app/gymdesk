'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { BILLING_FREQUENCY_NAMESPACE, cadenceFrequencyLabel } from '@/lib/billingFrequency';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CardDetailRow } from '@/components/CardDetailRow';
import { CardSection } from '@/components/CardSection';
import {
  cardMutedTextStyle,
  cardTextLinkStyle,
  formErrorStyle,
} from '@/components/formChrome';
import { AssignedPlanDetailsModal } from './AssignedPlanDetailsModal';
import { AdditionalPeriodicServices } from './AdditionalPeriodicServices';
import { AssignedPlanConfiguration } from './AssignedPlanConfiguration';
import { AssignedPlanPromotions } from './AssignedPlanPromotions';
import { ExampleTimeline } from '@/components/ExampleTimeline';
import { BillingEventSimulation } from '@/components/BillingEventSimulation';
import {
  exampleTimelineCycleNote,
  exampleTimelineRowCycle,
  exampleTimelineRowTone,
  formatExampleTimelineBilling,
} from '@/lib/exampleTimeline';
import {
  ASSIGNED_PLAN_TIMELINE_CYCLE_NOTE_KEYS,
  ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS,
} from './types';
import type { AssignedPlanDetail } from './types';

// #786: an assignment is `active` from creation, so there is no pre-activation
// status left to Submit from. The dates-and-discount Edit form that only a
// `draft`/`awaiting_payment` assignment could open went with them; the
// assignment's commercial configuration is edited section by section in
// `AssignedPlanConfiguration` below.
//
// #924 stage 5 puts that editing behind the #797/#897 split the Membership Plan
// and Promotion cards already follow: expanding the row *reads* the assignment —
// every section read-only, no input, no checkbox, no section `Edit` button — and
// `⋮ → Edit` is the single entry point into Edit mode. The card-level flag below
// is what every writable section asks, so a section's controls are **absent**
// outside the mode rather than disabled, and leaving the mode closes every
// section editor with it.
// Mirrors CLOSEABLE_FROM in api/src/api/user-memberships.ts. #1108 stage 1:
// `draft` is in it because closing is how a Draft is discarded — there is no
// expiry sweep (Q1a), so staff need a way out of a Draft that is not activation.
// Stage 2 adds `pending_payment` for the same reason: a committed plan nobody
// pays for is discarded, never unlocked back into a Draft.
const CLOSEABLE_STATUSES = ['draft', 'pending_payment', 'active', 'paused'];

// The statuses whose configuration can still be edited at all — a cancelled or
// expired assignment bills nothing further, so Edit mode has nothing to offer
// and the action is not shown. Mirrors SNAPSHOT_EDITABLE_STATUSES in
// api/src/api/user-memberships.ts, which #1108 §2 widened with `draft`: a Draft
// is the pre-checkout configuration state and is *fully* editable.
//
// `pending_payment` is deliberately absent (#1108 stage 2 §6): Save & Pay is the
// point of no return, so a committed plan's configuration is locked and every
// section's `PUT` refuses it — offering Edit mode over controls the server would
// reject is the one thing worse than not offering it.
const EDITABLE_STATUSES = ['draft', 'active', 'paused'];

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
}

// The timeline's dates are plain `YYYY-MM-DD` strings, so they are formatted in
// the viewer's locale without going through a Date that would shift them by a
// timezone (the Plan card's `fmtTimelineDate` does the same).
function fmtTimelineDate(ymd: string, locale: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function fmtMoney(v: string | number | null) {
  return v != null ? `€${parseFloat(String(v)).toFixed(2)}` : '—';
}

/**
 * #958 (Q3 `share`) — the Assigned Plan card body, rendered by both hosts:
 * the Assigned Plans page's own list and the Member card's MEMBERSHIP PLANS
 * section, which expands a plan card into exactly these sections. That is
 * #806's rule applied to a read surface — one section list, one set of locale
 * keys, one snapshot read — and the reason the ticket's §"Snapshot structure"
 * can promise that `Membership Plan → Details` and
 * `Member → Assigned plan → Expanded` are understood through the same shape.
 *
 * `embedded` is the only difference between the two hosts, and it is about the
 * chrome around the sections rather than about any of their contents: the
 * Member's plan card already carries the plan's name, its status, its dates and
 * its own `⋮` (Assign new plan · Cancel · Details), so an embedded body renders
 * neither a second summary header nor a second context menu — and therefore
 * holds no Edit mode either, since `⋮ → Edit` is the single entry point into one
 * (#797). Expanding a plan on the Member page reads it; editing the assignment
 * stays on the Assigned Plans page, which is where its own card lives.
 */
export function AssignedPlanExpandedRow({ assignedPlanId, onChanged, embedded = false }: {
  assignedPlanId: number;
  onChanged: () => void;
  embedded?: boolean;
}) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');
  // #1128: the Plan's cadence reads in the one billing-frequency vocabulary
  // ("Monthly", "Every 4 weeks"), never as the stored pair ("1 / month").
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const loadedRef = useRef(false);

  const [detail, setDetail] = useState<AssignedPlanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showDetails, setShowDetails] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [closeStep, setCloseStep] = useState<'none' | 'confirm' | 'warn'>('none');
  const [closeWarnings, setCloseWarnings] = useState<string[]>([]);

  // #613: impersonation-aware; actions that apply to the plan's status are shown, disabled when not permitted.
  const { canWrite: canWritePayments, isAdmin, readOnlyTitle } = useModuleAccess('PAYMENTS');

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadDetail() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<AssignedPlanDetail>(`/user-memberships/${assignedPlanId}`);
      setDetail(data);
    } catch {
      setError(t('expanded_error'));
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action: 'pause' | 'reactivate') {
    setActionBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/${action}`, { method: 'POST' });
      await loadDetail();
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmClose() {
    setActionBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/close`, { method: 'POST', body: JSON.stringify({}) });
      setCloseStep('none');
      await loadDetail();
      onChanged();
    } catch (err: any) {
      if (err.status === 409 && Array.isArray(err.body?.warnings)) {
        setCloseWarnings(err.body.warnings);
        setCloseStep('warn');
      } else {
        setCloseStep('none');
        toast(err.message ?? t('error_generic'));
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmCloseWithWarnings() {
    setActionBusy(true);
    try {
      await apiFetch(`/user-memberships/${assignedPlanId}/close`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
      setCloseStep('none');
      await loadDetail();
      onChanged();
    } catch (err: any) {
      setCloseStep('none');
      toast(err.message ?? t('error_generic'));
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) {
    return <div style={panel}><p style={dim}>{t('expanded_loading')}</p></div>;
  }
  if (error || !detail) {
    return (
      <div style={panel}>
        <p style={{ ...formErrorStyle, margin: 0 }}>
          {error}{' '}
          <button onClick={loadDetail} style={cardTextLinkStyle}>{t('retry')}</button>
        </p>
      </div>
    );
  }

  // An embedded body has no `⋮`, so it can never be in Edit mode — every
  // section's controls are absent rather than disabled, exactly as they are on
  // the Assigned Plans page outside the mode (#897).
  const editing = !embedded && isEditing;

  // #1108 stage 2: committing is the Member window's **Save & Pay** (§7), so this
  // card no longer offers an Activate of its own — stage 1's `⋮ → Activate` was
  // the placeholder that kept assignment working between the two stages, and a
  // second commit entry point inside the Membership Plans section is exactly what
  // §7 rules out. What a Draft still offers here is editing it and discarding it.
  const canPause = detail.status === 'active';
  const canReactivate = detail.status === 'paused';
  const canClose = CLOSEABLE_STATUSES.includes(detail.status);
  const canEnterEdit = EDITABLE_STATUSES.includes(detail.status);
  const write = { disabled: !canWritePayments, title: readOnlyTitle };
  const adminOnly = { disabled: !isAdmin, title: isAdmin ? undefined : readOnlyTitle };

  // #797: the context menu is the single entry point into Edit mode, and the
  // same item leaves it again — the card has no main form whose Cancel could,
  // since every one of an Assigned Plan's own fields is derived or frozen.
  const menuItems = [
    ...(canEnterEdit
      ? [{
        label: isEditing ? t('action_done_editing') : t('action_edit'),
        onClick: () => setIsEditing(!isEditing),
        ...write,
      }]
      : []),
    { label: t('action_details'), onClick: () => setShowDetails(true) },
    ...(canPause ? [{ label: t('action_pause'), onClick: () => runAction('pause'), ...write }] : []),
    ...(canReactivate ? [{ label: t('action_reactivate'), onClick: () => runAction('reactivate'), ...write }] : []),
    ...(canClose ? [{ label: t('action_close'), onClick: () => setCloseStep('confirm'), danger: true, ...adminOnly }] : []),
  ];

  return (
    <div style={panel}>
      {!embedded && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{detail.plan_name ?? '—'}</div>
            <div style={{ marginTop: 4 }}>
              <StatusBadge status={detail.lifecycle_status} label={tStatus(detail.lifecycle_status as any)} />
            </div>
          </div>
          <ContextMenu ariaLabel={t('actions_for', { plan: detail.plan_name ?? '' })} items={menuItems} />
        </div>
      )}

      {/* The sections below are ASSIGNED_PLAN_SECTION_ORDER, in that order
          (assignedPlanProfile.ts) — the Membership Plan card's own order with
          the three things only an assignment has. */}
      <CardSection label={t('section_members')} first>
        {detail.members.map((m) => (
          <div key={m.member_id} style={{ fontSize: 14, marginBottom: 2 }}>
            {m.name} {m.is_owner ? <span style={{ color: '#888', fontSize: 12 }}>({t('label_owner')})</span> : null}
          </div>
        ))}
      </CardSection>

      <CardSection label={t('section_pricing')}>
        <CardDetailRow label={t('detail_effective_price')} value={fmtMoney(detail.membership_fee)} />
        {detail.billing_policy && (
          <CardDetailRow
            label={t('label_billing_frequency')}
            value={cadenceFrequencyLabel(
              detail.billing_policy.recurring_billing_interval,
              detail.billing_policy.recurring_billing_unit,
              tFreq,
            )}
          />
        )}
        <CardDetailRow label={t('label_start_date')} value={fmtDate(detail.starts_at)} />
        <CardDetailRow label={t('label_end_date')} value={detail.ends_at ? fmtDate(detail.ends_at) : t('open_ended')} />
        {detail.closed_at && <CardDetailRow label={t('label_closure_date')} value={fmtDate(detail.closed_at)} />}
        {detail.next_billing_date && (
          <CardDetailRow label={t('label_next_billing_date')} value={fmtDate(detail.next_billing_date)} />
        )}
        {detail.discount_reason && (
          <CardDetailRow label={t('label_discount_reason')} value={detail.discount_reason} />
        )}
      </CardSection>

      {/* #635 stage 6: the five sections the assignment's own snapshot owns —
          Billing & Duration, the Personal Membership Fee Benefit and the three
          benefit kinds as they were captured at assignment time, which since
          stage 3 is also what it bills. A later edit of the Plan or of a
          Product never moves these lines (§13/§17).

          #924 stage 5: they are the card's own sections now, not a nested group
          under a `MEMBERSHIP PLAN CONFIGURATION` heading the Plan card has no
          counterpart for (§1) — the component renders the contiguous slice of
          the order declaration named ASSIGNED_PLAN_CONFIGURATION_SECTIONS. */}
      <AssignedPlanConfiguration
        assignedPlanId={assignedPlanId}
        planStatus={detail.status}
        snapshot={detail.snapshot}
        cardEditing={editing}
        canWrite={canWritePayments}
        readOnlyTitle={readOnlyTitle}
        onChanged={() => { loadDetail(); onChanged(); }}
      />

      {/* #635 stage 7 (§16): one expandable card per applied Promotion, each
          showing the configuration *that application* froze — never the
          Promotion's current definition, which may have been edited or
          deleted since. */}
      <CardSection label={t('section_promotions')}>
        <AssignedPlanPromotions
          assignedPlanId={assignedPlanId}
          promotions={detail.promotions}
          cardEditing={editing}
          canWrite={canWritePayments}
          readOnlyTitle={readOnlyTitle}
          onChanged={() => { loadDetail(); onChanged(); }}
        />
      </CardSection>

      {/* #924 stage 3 (§7) — the MEMBERSHIP FEE SIMULATION: the Membership Plan
          card's Example Timeline, for this contract. One row per billing period
          of the assignment's own cadence, from the period containing today,
          each row's Status and Billing decided server-side by the very call the
          nightly run prices a cycle with (`resolveMembershipFee()`), so the
          table cannot advertise a charge the run does not make. An applied
          Promotion and the Personal Membership Fee Benefit are already in those
          numbers. Read-only by nature: computed on every read, persisted
          nowhere, and it charges nothing. */}
      <CardSection label={t('section_fee_simulation')}>
        {detail.example_timeline?.available ? (
          <>
            {detail.example_timeline.anchorDate && (
              <p style={{ ...cardMutedTextStyle, fontSize: 12, margin: '0 0 8px' }}>
                {t('timeline_anchor_note', {
                  date: fmtTimelineDate(detail.example_timeline.anchorDate, locale),
                })}
              </p>
            )}
            <ExampleTimeline
              labels={{
                // #1130 stage 2 — the Cycle column, rendered only for the rows
                // the server reports an iteration for.
                cycle: t('col_cycle'),
                period: t('col_period'),
                dates: t('col_dates'),
                status: t('col_status'),
                billing: t('col_billing'),
              }}
              rows={detail.example_timeline.periods.map((row, i) => ({
                key: row.period,
                cycle: exampleTimelineRowCycle(
                  detail.example_timeline!.periods, detail.example_timeline!.cycle, i,
                ),
                period: row.endsOn ? String(row.period) : `${row.period}+`,
                dates: row.endsOn
                  ? `${fmtTimelineDate(row.startsOn, locale)} – ${fmtTimelineDate(row.endsOn, locale)}`
                  : t('timeline_dates_from', { date: fmtTimelineDate(row.startsOn, locale) }),
                status: t(ASSIGNED_PLAN_TIMELINE_STATUS_LABEL_KEYS[row.status] as any),
                billing: formatExampleTimelineBilling(
                  row,
                  t('timeline_no_charge'),
                  t('tax_included_suffix'),
                  // #946 — the first Pre-paid period collects the whole Pre-paid
                  // Duration, so the cell says how many periods its amount covers.
                  row.prepaidPeriods != null
                    ? t('timeline_prepaid_periods', { count: row.prepaidPeriods })
                    : null,
                ),
                tone: exampleTimelineRowTone(row),
              }))}
              cycleNote={(() => {
                // Whether this contract's cycle starts again is the engine's
                // answer (`auto_renew`, frozen onto the assignment) — the card
                // only words it.
                const note = exampleTimelineCycleNote(detail.example_timeline?.cycle ?? null);
                return note ? t(ASSIGNED_PLAN_TIMELINE_CYCLE_NOTE_KEYS[note] as any) : null;
              })()}
              footnotes={
                <p style={{ margin: '8px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>
                  {t('timeline_disclaimer')}
                </p>
              }
            />
          </>
        ) : (
          // The server's `reason` is a single, known condition (this assignment
          // has no billing frequency), so it is said in the viewer's language
          // rather than relayed in English.
          <p style={dim}>{t('timeline_unavailable')}</p>
        )}
      </CardSection>

      {/* #924 stage 4 (§8/§9/§10) — the BILLING EVENT FORECAST: one group per
          billing *date*, listing every line that falls on it — the Membership
          Fee plus each Product and Additional Periodic Service this
          contract carries — where the Membership Fee Simulation above is one
          row per billing *period* about the fee alone. Neither replaces the
          other and neither may grow into the other.

          It is the Membership Plan card's own Billing Event Simulation, over
          the same engine and rendered by the same component, with this
          assignment as the context: its real `starts_at`, its applied
          Promotions, its frozen benefit lines and its Personal Membership Fee
          Benefit are all in the server's numbers. The page formats, it never
          prices (#817). Read-only: computed on every read, persisted nowhere,
          and it charges nothing. */}
      <CardSection label={t('section_billing_forecast')}>
        <BillingEventSimulation
          simulation={detail.billing_event_simulation}
          t={(key, values) => t(key as any, values as any)}
          formatDate={(date) => fmtTimelineDate(date, locale)}
          cycleNote={(() => {
            // #1130 stage 3 — the same marker the Membership Fee Simulation
            // above carries: whether this contract's cycle starts again is the
            // engine's answer, and the card only words it.
            const note = exampleTimelineCycleNote(detail.billing_event_simulation?.cycle ?? null);
            return note ? t(ASSIGNED_PLAN_TIMELINE_CYCLE_NOTE_KEYS[note] as any) : null;
          })()}
        />
      </CardSection>

      {/* #631: Additional Products belong to the Assigned Plan itself — not to
          the Membership Plan and not to the Promotions above it. #924 §11 keeps
          the section and the thread's Q4 answer renames it. */}
      <CardSection label={t('section_additional_services')}>
        <AdditionalPeriodicServices
          assignedPlanId={assignedPlanId}
          planStartsAt={detail.starts_at}
          planStatus={detail.status}
          services={detail.additional_services ?? []}
          editing={editing}
          canWrite={canWritePayments}
          readOnlyTitle={readOnlyTitle}
          onChanged={() => { loadDetail(); onChanged(); }}
        />
      </CardSection>

      <CardSection label={t('section_billing_events')}>
        {!detail.billing_events.available ? (
          <p style={dim}>{detail.billing_events.reason}</p>
        ) : detail.billing_events.events.length === 0 ? (
          <p style={dim}>{t('no_billing_events')}</p>
        ) : (
          <div>
            {detail.billing_events.events.map((ev, i) => (
              <div key={i} style={ledgerRowStyle}>
                <span>
                  {fmtDate(ev.date)}
                  {ev.promotion_affected && (
                    <span style={ledgerPromotionTagStyle}>({t('billing_event_promotion_affected')})</span>
                  )}
                </span>
                <span>{fmtMoney(ev.amount)}</span>
              </div>
            ))}
          </div>
        )}
      </CardSection>

      {showDetails && (
        <AssignedPlanDetailsModal detail={detail} onClose={() => setShowDetails(false)} />
      )}

      {/* #630: the menu action reads "Cancel" now, so the dialog can't label both
          its buttons with it — the confirm button spells out what it cancels and
          the dismiss button says what happens instead of a second "Cancel". */}
      <ConfirmDialog
        open={closeStep === 'confirm'}
        message={t('confirm_close')}
        confirmLabel={t('action_close_confirm')}
        cancelLabel={t('action_close_dismiss')}
        onConfirm={confirmClose}
        onCancel={() => setCloseStep('none')}
        busy={actionBusy}
      />
      <ConfirmDialog
        open={closeStep === 'warn'}
        message={t('confirm_close_with_warnings', { warnings: closeWarnings.join(', ') })}
        confirmLabel={t('action_close_confirm')}
        cancelLabel={t('action_close_dismiss')}
        onConfirm={confirmCloseWithWarnings}
        onCancel={() => setCloseStep('none')}
        busy={actionBusy}
      />
    </div>
  );
}

const panel: React.CSSProperties = { padding: '16px 24px' };

// #929/#924 stage 5: the card's chrome comes from `components/formChrome.ts`,
// so nothing here restates a muted sentence, a text link or an error line.
const dim = cardMutedTextStyle;

// The ledger's own structure — a date on the left, the amount on the right —
// which stays with the section (#929: what is shared is the chrome, not a
// section's layout).
const ledgerRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0',
  borderBottom: '1px solid var(--gd-card-border, #f4f4f6)',
};

const ledgerPromotionTagStyle: React.CSSProperties = {
  marginLeft: 8, color: 'var(--gd-link, #6c63ff)', fontSize: 11,
};
