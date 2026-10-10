'use client';

// #634 §1/§2 — the Member's Membership Plans.
//
// It manages nothing but the Member's Membership Plans: Additional Products and
// the Billing Simulation are siblings of this section, never nested inside a
// plan (§13).
//
// #956 reversed §6/§14: a Member holds zero or one Membership Plan. Since
// #1325 PR 3b "+ Add Membership Plan" creates a ProductSet version (`POST
// /product-sets`) and commits it, and the server refuses a Member who is already
// on a plan with `409 active_plan_exists` — there is no confirmation to send
// from here. Superseding a specific plan is the explicit "Assign New Plan"
// action on the plan itself, which stays on the assignment flow for now.
//
// Inline throughout (§15): "+ Add Membership Plan" opens a draft below the
// list, saved or discarded in place. No modal, no wizard, no separate page.
//
// #1051 replaced the presentation. The section used to draw one metadata card
// per assignment — plan name and price in a header, six `CardDetailRow`s under
// them, its own `▸/▾` toggle — which was a second rendering of the very rows the
// Assigned Plans page lists. It now renders that page's own table
// (`components/assignedPlan/AssignedPlansTable`), so the columns, their
// headers, the chevron, the Status badge and the body they expand into are one
// declaration for both screens and a change to either reaches both. Four of its
// answers are the rule rather than the implementation:
//
//  * **Two tables, Active and Past** (§4), split on `is_live` exactly as the two
//    card groups were — the same assignments, in the same order, under the same
//    `Past plans` heading they already had.
//  * **The Member column is dropped** and the Plan names the row. On a list
//    already scoped to one person their name identifies nothing, and #1011
//    would have pinned it on a phone while hiding the Plan behind it. Every
//    other column is the Assigned Plans page's, including its locale keys.
//  * **The actions stay in the `⋮`** (#958's Q2 `menu`) — `Assign New Plan`,
//    `Cancel Plan`, `Details` — handed to the table as `rowActions` rather than
//    declared by it, because they are the Member card's actions and not the
//    list's. A historical row offers `Details` alone.
//  * **The expansion still reads** (`embedded`, #958): editing an assignment
//    stays on the Assigned Plans page, where its own card lives, since `⋮ →
//    Edit` is the single entry point into an Edit mode (#797).
//
// Nothing the cards showed is lost: the price and the next billing date are the
// expanded body's PRICING section, and Created by / Created at are in
// `⋮ → Details` with the audit link — which is where #799 puts an actor.

import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { commitProductSetVersion } from '@/lib/productSetCommit';
import type { ContextMenuItem } from '@/components/ContextMenu';
import { AssignedPlansTable } from '@/components/assignedPlan/AssignedPlansTable';
import { AssignedPlanDetailsDialog } from '@/components/assignedPlan/AssignedPlanDetailsDialog';
import {
  cardHintStyle,
  cardSubLabelStyle,
  dashedAddBtnStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  inlineActionsRowStyle,
  inlineEditorStyle,
  inlineEditorTitleStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import type { MemberPlanRow, ProductSetRow } from './membershipConfiguration';
import { ProductSetsInFlight } from './ProductSetsInFlight';

interface AssignablePlan {
  id: number;
  name: string;
}

interface Props {
  memberId: number;
  plans: MemberPlanRow[];
  /** #1325 PR 3b: the member's in-flight ProductSet versions. */
  productSets?: ProductSetRow[];
  canWrite: boolean;
  /** Re-reads the Member's configuration and re-runs the Billing Simulation (§12). */
  onChanged: () => void;
  onAssignNewPlan: (plan: MemberPlanRow) => void;
  onCancelPlan: (plan: MemberPlanRow) => void;
  /** The inline "Assign New Plan" editor for a plan, rendered under the list (#628). */
  renderAssignEditor: (plan: MemberPlanRow) => React.ReactNode;
  assignBusy: boolean;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function MemberMembershipPlans({
  memberId, plans, productSets = [], canWrite, onChanged, onAssignNewPlan, onCancelPlan, renderAssignEditor, assignBusy,
}: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const optionsLoadedRef = useRef(false);

  const [adding, setAdding] = useState(false);
  const [options, setOptions] = useState<AssignablePlan[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [draftPlanId, setDraftPlanId] = useState<number | null>(null);
  const [draftStartsAt, setDraftStartsAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #958: the Assigned Plan whose Details are open, if any — one dialog for the
  // whole section rather than one mounted per row.
  const [detailsPlanId, setDetailsPlanId] = useState<number | null>(null);
  // #1107: Past plans is a collapsible card, collapsed whenever the section mounts.
  const [pastOpen, setPastOpen] = useState(false);

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
  }

  /**
   * #1325 PR 3b: the plan is added as a ProductSet version and committed in one
   * go. There is no confirmation to send — the server refuses a Member who is
   * already on a plan (#956) with `409 active_plan_exists`, and replacing a plan
   * is the explicit `Assign New Plan` action on the plan itself.
   */
  async function save() {
    if (draftPlanId == null) { setError(t('add_membership_plan_error_no_plan')); return; }
    if (!draftStartsAt) { setError(t('assign_new_plan_error_no_start')); return; }
    setSaving(true);
    setError(null);
    try {
      // #1325 PR 3b: the plan is a ProductSet version. The server decides what
      // happens next — nothing owed activates it; a payment owed makes it
      // Pending Payment — and the editing lock, the one-in-flight rule and the
      // one-plan rule are all the server's, so this never sends `confirm`.
      const created = await apiFetch<{ id: number }>('/product-sets', {
        method: 'POST',
        body: JSON.stringify({ member_id: memberId, membership_plan_id: draftPlanId, starts_at: draftStartsAt }),
      });
      await commitProductSetVersion(apiFetch, created.id);
      setAdding(false);
      setDraftPlanId(null);
      onChanged();
    } catch (err: any) {
      // A conflict (`active_plan_exists`, `edit_locked`, `in_flight`) is the
      // server's answer and is shown as its sentence: there is nothing here to
      // confirm — replacing a plan is a new version, never an overwrite.
      setError(apiErrorMessage(err) ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  /**
   * The Member card's own actions on one of its plans. `Assign New Plan` and
   * `Cancel Plan` are the live plan's lifecycle actions, so a historical row
   * carries neither — "the exact available actions should follow the plan's
   * status". `Details` is every row's: reading what a past assignment was
   * agreed with is the whole point of keeping it.
   */
  function rowActions(plan: MemberPlanRow): ContextMenuItem[] {
    // #1191: a Linked plan is the owner's contract seen from another Member —
    // it offers no Assign New Plan or Cancel Plan, only Details.
    const lifecycleItems: ContextMenuItem[] = canWrite && plan.is_live && plan.assignment_relationship !== 'linked'
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
    return [...lifecycleItems, { label: t('action_details'), onClick: () => setDetailsPlanId(plan.id) }];
  }

  return (
    <div>
      {/* #1325 PR 3b — versions still in flight (no assignment until activation). */}
      <ProductSetsInFlight productSets={productSets} canWrite={canWrite} onChanged={onChanged} />

      {/* ACTIVE — the ticket's §4 split, over the Assigned Plans page's table. */}
      <div style={subLabel}>{t('membership_plans_active')}</div>
      <AssignedPlansTable
        rows={live}
        loadingText={t('add_membership_plan_loading')}
        emptyText={t('no_active_membership_plans')}
        onChanged={onChanged}
        scope="member"
        embedded
        viewAsMemberId={memberId}
        rowActions={rowActions}
      />

      {/* #628: the inline Assign New Plan editor for whichever plan raised it —
          under the list it acts on, since a table row is not a card to nest it
          in. Only the plan being superseded renders anything. */}
      {live.map((m) => <React.Fragment key={m.id}>{renderAssignEditor(m)}</React.Fragment>)}

      {/* #958: no generic add while the Member holds a plan — replacing it is
          `Assign New Plan` on the row of the plan being replaced. */}
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

      {/* PAST — the same table, so a terminated assignment reads exactly as a
          live one does. Absent rather than empty, as the card group was. */}
      {history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setPastOpen((o) => !o)}
            aria-expanded={pastOpen}
            style={{
              ...subLabel, display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', textAlign: 'left',
            }}
          >
            <span>{t('membership_plans_history')}</span>
            <span>({history.length})</span>
            <span aria-hidden="true" style={{ marginLeft: 'auto' }}>{pastOpen ? '▾' : '▸'}</span>
          </button>
          {pastOpen && (
            <AssignedPlansTable
              rows={history}
              loadingText={t('add_membership_plan_loading')}
              emptyText={t('no_active_membership_plans')}
              onChanged={onChanged}
              scope="member"
              embedded
              viewAsMemberId={memberId}
              rowActions={rowActions}
            />
          )}
        </div>
      )}

      {/* The app's existing Assigned Plan Details modal, shared rather than
          re-drawn: what it shows is this assignment's own record, including the
          actor and the audit link. */}
      {detailsPlanId != null && (
        <AssignedPlanDetailsDialog assignedPlanId={detailsPlanId} viewAsMemberId={memberId} onClose={() => setDetailsPlanId(null)} />
      )}
    </div>
  );
}

// #929: the look is `components/formChrome.ts` — this section aliases the shared
// objects rather than restating them, so its labels, inputs and its Save/Cancel
// pair are the same ones the Member card's other sections wear.
const hint = cardHintStyle;
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
