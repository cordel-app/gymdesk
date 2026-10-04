'use client';

// #634 §1/§2 — MEMBERSHIP PLANS, the first of the Member's four independent
// Membership sections.
//
// It manages nothing but the Member's Membership Plans: Promotions, Additional
// Services and the Billing Simulation are siblings of this section, never
// nested inside a plan card (§13).
//
// #956 reversed §6/§14: a Member holds zero or one Membership Plan, so adding
// one to a Member who already has a live plan *replaces* it. The server is what
// decides that — it answers `409 active_plan_exists` and takes `confirm: true`
// — and this section's job is to show the warning the admin confirms, through
// the shared `ReplacePlanDialog`. Superseding a specific plan is still available
// as the explicit "Assign New Plan" action on the plan itself.
//
// Inline throughout (§15): "+ Add Membership Plan" opens a draft below the
// list, saved or discarded in place. No modal, no wizard, no separate page.
//
// #958 redesigns the section around one card per Assigned Membership Plan. Four
// of its answers are the rule rather than the implementation:
//
//  * **The card is a summary, the expansion is the snapshot.** Plan name, price,
//    Created by, Created at, Start date, End date and Status are on the card;
//    expanding it renders the shared Assigned Plan card body
//    (`components/assignedPlan/AssignedPlanExpandedRow`, `embedded`), which is
//    the very component the Assigned Plans page expands — so the sections, their
//    order and their terminology are one declaration and this card cannot grow a
//    simplified second rendering of a frozen configuration (Q3 `share`, #806).
//  * **Created by / Created at are columns** (migration 215), not an `audit_logs`
//    read: the ticket's Q4 answer is that key metadata belongs on the entity, and
//    it is what lets every card carry the actor without a subquery per row.
//  * **The actions stay in the `⋮` menu** (Q2 `menu`) — `Assign New Plan`,
//    `Details`, `Cancel Plan` — because that is the app's single entry point into
//    a row's actions (#797) and three buttons per card on a member with five past
//    plans is chrome, not clarity. A historical card offers `Details` alone: the
//    other two only make sense for a plan that is still live.
//  * **`+ Add Membership Plan` is absent while a live plan exists**, because
//    under #956 adding one *replaces* it, and that operation is named on the plan
//    it replaces rather than offered as a generic add. The replacement
//    confirmation stays the server's 409 either way: a Member covered by a family
//    plan somebody else owns still has one (#956 Q4).

import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { activePlanConflict, type ActivePlanConflict } from '@/lib/activePlanConflict';
import { ReplacePlanDialog } from '@/components/ReplacePlanDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { CardDetailRow } from '@/components/CardDetailRow';
import { AssignedPlanExpandedRow } from '@/components/assignedPlan/AssignedPlanExpandedRow';
import { AssignedPlanDetailsDialog } from '@/components/assignedPlan/AssignedPlanDetailsDialog';
import {
  cardExpandCaretStyle,
  cardExpandToggleStyle,
  cardHintStyle,
  cardMutedTextStyle,
  cardSubLabelStyle,
  dashedAddBtnStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  inlineEditorStyle,
  inlineEditorTitleStyle,
  innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import type { MemberPlanRow } from './membershipConfiguration';

interface AssignablePlan {
  id: number;
  name: string;
}

interface Props {
  memberId: number;
  plans: MemberPlanRow[];
  canWrite: boolean;
  /** Re-reads the Member's configuration and re-runs the Billing Simulation (§12). */
  onChanged: () => void;
  onAssignNewPlan: (plan: MemberPlanRow) => void;
  onCancelPlan: (plan: MemberPlanRow) => void;
  /** The inline "Assign New Plan" editor for a plan, rendered inside its card (#628). */
  renderAssignEditor: (plan: MemberPlanRow) => React.ReactNode;
  assignBusy: boolean;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * DD/MM/YYYY from the plain YYYY-MM-DD the configuration endpoint returns,
 * without going through `Date` — parsing a bare date as UTC midnight and then
 * formatting it locally shows the previous day west of Greenwich. Same helper
 * shape as `fmtDay` in MemberBillingSimulation.tsx.
 */
function fmtDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function MemberMembershipPlans({
  memberId, plans, canWrite, onChanged, onAssignNewPlan, onCancelPlan, renderAssignEditor, assignBusy,
}: Props) {
  const t = useTranslations('members');
  // `status.*` lives at the root of the message catalogue, not under `members`.
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const optionsLoadedRef = useRef(false);

  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<AssignablePlan[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [draftPlanId, setDraftPlanId] = useState<number | null>(null);
  const [draftStartsAt, setDraftStartsAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #956 stage 2: the replacement the admin has not confirmed yet. Holding the
  // 409 rather than a boolean is what lets the dialog name the plan it cancels.
  const [conflict, setConflict] = useState<ActivePlanConflict | null>(null);
  // #958: the Assigned Plan whose Details are open, if any — one dialog for the
  // whole section rather than one mounted per card.
  const [detailsPlanId, setDetailsPlanId] = useState<number | null>(null);

  // §2: only Active + Public Membership Plans may be offered. The server
  // enforces the same rule on assignment, so this filter only keeps the picker
  // from offering something the API would refuse.
  useEffect(() => {
    if (!adding || optionsLoadedRef.current) return;
    optionsLoadedRef.current = true;
    setOptionsLoading(true);
    apiFetch<AssignablePlan[]>('/membership-plans?lifecycle_status=active&enrollment_status=public')
      .then(setOptions)
      .catch(() => setOptions([]))
      .finally(() => setOptionsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  const live = plans.filter((p) => p.is_live);
  const history = plans.filter((p) => !p.is_live);
  // The Plan the Member already holds is left out of the picker: re-assigning
  // it would be a replacement with nothing to replace it with. Every *other*
  // Plan stays offered — under #956 picking one replaces the live plan, which
  // is what the confirmation dialog is for.
  const activePlanIds = new Set(live.map((p) => p.membership_plan_id).filter((id): id is number => id != null));
  const selectable = options.filter((o) => !activePlanIds.has(o.id));

  function startAdding() {
    setAdding(true);
    setDraftPlanId(null);
    setDraftStartsAt(todayISO());
    setError(null);
  }

  function cancelAdding() {
    setAdding(false);
    setDraftPlanId(null);
    setError(null);
    setConflict(null);
  }

  /**
   * #956 stage 2: `confirmReplacement` is the admin's answer to the dialog and
   * nothing else — the first attempt never sends it, so a member who already
   * has a plan cannot have it cancelled without the warning being shown, and
   * the resend carries the identical draft so Continue assigns exactly what was
   * confirmed. Cancel leaves the draft open and changes nothing.
   */
  async function save(confirmReplacement = false) {
    if (draftPlanId == null) { setError(t('add_membership_plan_error_no_plan')); return; }
    if (!draftStartsAt) { setError(t('assign_new_plan_error_no_start')); return; }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/user-memberships', {
        method: 'POST',
        body: JSON.stringify({
          member_id: memberId,
          membership_plan_id: draftPlanId,
          starts_at: draftStartsAt,
          ...(confirmReplacement ? { confirm: true } : {}),
        }),
      });
      setConflict(null);
      setAdding(false);
      setDraftPlanId(null);
      onChanged();
    } catch (err: any) {
      const replacement = confirmReplacement ? null : activePlanConflict(err);
      if (replacement) {
        setConflict(replacement);
      } else {
        setConflict(null);
        setError(apiErrorMessage(err) ?? t('error_generic'));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {live.length === 0 ? (
        <p style={dim}>{t('no_active_membership_plans')}</p>
      ) : (
        live.map((m) => (
          <PlanCard
            key={m.id}
            plan={m}
            canWrite={canWrite}
            assignBusy={assignBusy}
            onAssignNewPlan={onAssignNewPlan}
            onCancelPlan={onCancelPlan}
            onShowDetails={() => setDetailsPlanId(m.id)}
            onChanged={onChanged}
            t={t}
            statusLabel={(s) => tStatus(s as never)}
          >
            {renderAssignEditor(m)}
          </PlanCard>
        ))
      )}

      {/* #958: no generic add while the Member holds a plan — replacing it is
          `Assign New Plan` on the card of the plan being replaced. */}
      {canWrite && live.length === 0 && !adding && (
        <button onClick={startAdding} style={addBtn}>{t('add_membership_plan')}</button>
      )}

      {adding && (
        <div style={editorStyle}>
          <div style={editorTitle}>{t('add_membership_plan_title')}</div>

          <div style={labelStyle}>{t('assign_new_plan_label_plan')}</div>
          {optionsLoading ? (
            <p style={hint}>{t('add_membership_plan_loading')}</p>
          ) : selectable.length === 0 ? (
            <p style={hint}>{t('add_membership_plan_none')}</p>
          ) : (
            // §2: one Membership Plan per assignment, picked with radio buttons.
            <div role="radiogroup" aria-label={t('assign_new_plan_label_plan')} style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 12px' }}>
              {selectable.map((o) => (
                <label key={o.id} style={optionRow(draftPlanId === o.id)}>
                  <input
                    type="radio"
                    name={`add-plan-${memberId}`}
                    checked={draftPlanId === o.id}
                    disabled={saving}
                    onChange={() => setDraftPlanId(o.id)}
                    style={{ marginRight: 8 }}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </div>
          )}

          <div style={labelStyle}>{t('assign_new_plan_label_starts')}</div>
          <input
            type="date"
            value={draftStartsAt}
            onChange={(e) => setDraftStartsAt(e.target.value)}
            disabled={saving}
            style={inputStyle}
          />

          {error && <p style={errorStyle}>{error}</p>}

          <div style={actionsRow}>
            <button onClick={() => save()} disabled={saving || selectable.length === 0} style={saveBtn}>
              {saving ? t('saving') : t('add_membership_plan_submit')}
            </button>
            <button onClick={cancelAdding} disabled={saving} style={cancelBtn}>{t('cancel')}</button>
          </div>
        </div>
      )}

      <ReplacePlanDialog
        conflict={conflict}
        newPlanName={selectable.find((o) => o.id === draftPlanId)?.name ?? null}
        busy={saving}
        onConfirm={() => save(true)}
        onCancel={() => setConflict(null)}
      />

      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={subLabel}>{t('membership_plans_history')}</div>
          {history.map((m) => (
            <PlanCard
              key={m.id}
              plan={m}
              canWrite={false}
              assignBusy={assignBusy}
              onShowDetails={() => setDetailsPlanId(m.id)}
              onChanged={onChanged}
              t={t}
              statusLabel={(s) => tStatus(s as never)}
              dimmed
            />
          ))}
        </div>
      )}

      {/* The app's existing Assigned Plan Details modal, shared rather than
          re-drawn (§"Reuse existing Details UI"): what it shows is this
          assignment's own record, including the actor and the audit link. */}
      {detailsPlanId != null && (
        <AssignedPlanDetailsDialog assignedPlanId={detailsPlanId} onClose={() => setDetailsPlanId(null)} />
      )}
    </div>
  );
}

/**
 * One Assigned Membership Plan, as the ticket's card: its name and price in the
 * header, the seven summary fields under them, its actions in the `⋮`, and the
 * assignment's own frozen configuration one click away.
 *
 * The expansion is the shared Assigned Plan card body and not a rendering of its
 * own, so what an admin reads here is what they read on the Assigned Plans page:
 * the frozen benefit sections, the applied Promotions' snapshots, the Membership
 * Fee Simulation, the Billing Event Forecast and the Billing Events ledger. It
 * reads, it does not write — every control in that body belongs to the Edit mode
 * of its own card (#797/#897), which an `embedded` body has no `⋮` to enter.
 */
function PlanCard({
  plan, canWrite, assignBusy, onAssignNewPlan, onCancelPlan, onShowDetails, onChanged, t, statusLabel, dimmed, children,
}: {
  plan: MemberPlanRow;
  canWrite: boolean;
  assignBusy: boolean;
  onAssignNewPlan?: (plan: MemberPlanRow) => void;
  onCancelPlan?: (plan: MemberPlanRow) => void;
  onShowDetails: () => void;
  onChanged: () => void;
  t: ReturnType<typeof useTranslations>;
  statusLabel: (status: string) => string;
  dimmed?: boolean;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  // `Assign New Plan` and `Cancel Plan` are the live plan's lifecycle actions,
  // so a historical card carries neither — "the exact available actions should
  // follow the plan's status". `Details` is every card's: reading what a past
  // assignment was agreed with is the whole point of keeping it.
  const lifecycleItems = canWrite && onAssignNewPlan && onCancelPlan
    ? [
      {
        label: t('action_assign_new_plan'),
        onClick: () => onAssignNewPlan(plan),
        // #628: only one inline assignment editor at a time — they share a
        // single draft state.
        disabled: assignBusy,
        title: assignBusy ? t('assign_new_plan_busy_hint') : undefined,
      },
      ...(plan.status !== 'cancelled'
        ? [{ label: t('action_cancel_plan'), onClick: () => onCancelPlan(plan), danger: true }]
        : []),
    ]
    : [];

  return (
    <div style={{ ...card, opacity: dimmed ? 0.75 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, justifyContent: 'space-between' }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>{plan.plan_name ?? '—'}</div>
            {/* The price the assignment pays for the cycle it is next charged
                for (#635 stage 15) — a computed field, never a column. */}
            <div style={{ fontSize: 14 }}>
              {plan.membership_fee != null ? `€${plan.membership_fee.toFixed(2)}` : '—'}
            </div>
          </div>

          <div style={{ marginTop: 6 }}>
            <CardDetailRow label={t('membership_created_by')} value={plan.created_by_name ?? '—'} />
            <CardDetailRow
              label={t('membership_created_at')}
              value={plan.created_at ? fmtDate(plan.created_at) : '—'}
            />
            <CardDetailRow
              label={t('membership_start')}
              value={plan.starts_at ? fmtDate(plan.starts_at) : '—'}
            />
            <CardDetailRow
              label={t('membership_end')}
              value={plan.ends_at ? fmtDate(plan.ends_at) : '—'}
            />
            <CardDetailRow
              label={t('membership_status')}
              value={<StatusBadge status={plan.status} label={statusLabel(plan.status)} />}
            />
            {plan.is_live && plan.next_billing_date && (
              <CardDetailRow
                label={t('membership_next_billing')}
                value={fmtDate(plan.next_billing_date)}
              />
            )}
          </div>
          {/* #635 stage 4: the card listed the Plan's Included Services here
              (#511/#634) until the concept was retired (migration 177). Which
              activities the Member may book is the Activity Type's own
              eligible-plan list now, edited from the Activity Types page. */}
        </div>
        <ContextMenu
          ariaLabel={`Actions for ${plan.plan_name ?? 'plan'}`}
          items={[...lifecycleItems, { label: t('action_details'), onClick: onShowDetails }]}
        />
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          style={cardExpandToggleStyle}
        >
          <span style={cardExpandCaretStyle}>{expanded ? '▾' : '▸'}</span>
          <span style={{ fontSize: 13 }}>{t('membership_plan_snapshot')}</span>
        </button>
        {expanded && (
          <AssignedPlanExpandedRow assignedPlanId={plan.id} onChanged={onChanged} embedded />
        )}
      </div>

      {children}
    </div>
  );
}

// #929: the look is `components/formChrome.ts` — this section aliases the shared
// objects rather than restating them, so its cards, labels, inputs and its
// Save/Cancel pair are the same ones the Member card's other sections wear.
const dim = cardMutedTextStyle;
const hint = cardHintStyle;
const card = innerCardStyle;
const subLabel = cardSubLabelStyle;
const addBtn = dashedAddBtnStyle;
const editorStyle = inlineEditorStyle;
const editorTitle = inlineEditorTitleStyle;
const labelStyle = formFieldLabelStyle;
const inputStyle: CSSProperties = { ...formControlStyle, margin: '6px 0 12px' };
const errorStyle: CSSProperties = { ...formErrorStyle, margin: '0 0 10px' };
const saveBtn = primaryBtnSmall();
const cancelBtn = secondaryBtnSmall;
const actionsRow = inlineActionsRowStyle;

function optionRow(checked: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
    border: `1px solid ${checked ? '#bfdbfe' : '#e5e7eb'}`,
    background: checked ? '#eff6ff' : '#fff',
    color: checked ? '#1d4ed8' : 'inherit',
    cursor: 'pointer', fontSize: 13, userSelect: 'none',
  };
}
