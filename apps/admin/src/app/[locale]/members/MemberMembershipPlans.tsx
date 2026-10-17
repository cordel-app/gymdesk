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
// #1450/#1460: "+ Add Membership Plan" opens the Plans page's own Assign Plan
// to Member editor (`plans/AssignPlanToMembersEditor`, inline, no modal) with
// this Member preselected, so both entry points are one workflow. It creates a Draft that is configured and paid
// from its card; this section keeps no assignment form of its own.
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

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import type { AssignablePlan } from '../plans/AssignPlanToMembersEditor';
import { apiErrorMessage } from '@/lib/apiClient';
import { formControlStyle, formErrorStyle, inlineEditorStyle, secondaryBtnSmall } from '@/components/formChrome';
import type { ContextMenuItem } from '@/components/ContextMenu';
import { AssignPlanToMembersEditor } from '../plans/AssignPlanToMembersEditor';
import { AssignedPlansTable, type AssignedPlanRowHelpers } from '@/components/assignedPlan/AssignedPlansTable';
import { AssignedPlanDetailsDialog } from '@/components/assignedPlan/AssignedPlanDetailsDialog';
import { cardSubLabelStyle } from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';
import type { MemberPlanRow, ProductSetRow } from './membershipConfiguration';
import { canEditLivePlan, visiblePlans } from './membershipPlansView';


interface Props {
  memberId: number;
  /** The Member the add workflow is launched from — preselected in it (#1450). */
  memberName: string;
  memberEmail: string;
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

export function MemberMembershipPlans({
  memberId, memberName, memberEmail, plans, productSets = [], canWrite, onChanged, onAssignNewPlan, onCancelPlan, renderAssignEditor, assignBusy,
}: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const optionsLoadedRef = useRef(false);

  const [adding, setAdding] = useState(false);
  // #1533: the Draft just created from the picker — opened in Edit mode in the list.
  const [newDraftId, setNewDraftId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [options, setOptions] = useState<AssignablePlan[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
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
    setOptionsError(false);
    // #1659: Active (and Public, the server's assignability rule) plus Draft
    // plans, listed with their status; a Draft is shown but not selectable.
    apiFetch<(AssignablePlan & { enrollment_status?: string })[]>('/membership-plans')
      .then((rows) => setOptions(
        (Array.isArray(rows) ? rows : []).filter((p) => p.lifecycle_status === 'draft'
          || (p.lifecycle_status === 'active' && p.enrollment_status === 'public')),
      ))
      .catch(() => {
        // A failed load must not be remembered as "loaded": reopening retries.
        optionsLoadedRef.current = false;
        setOptions([]);
        setOptionsError(true);
      })
      .finally(() => setOptionsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  const live = plans.filter((p) => p.is_live);
  // #1538: one version at a time — a Draft replaces the Active snapshot in the view.
  const visible = visiblePlans(plans);
  const history = plans.filter((p) => !p.is_live);
  // The Plan the Member already holds is left out of the picker: re-assigning
  // it would be a replacement with nothing to replace it with. Every *other*
  // Plan stays offered — under #956 picking one replaces the live plan, which
  // is what the confirmation dialog is for.
  const activePlanIds = new Set(live.map((p) => p.membership_plan_id).filter((id): id is number => id != null));
  const selectable = options.filter((o) => !activePlanIds.has(o.id));

  // #1538 stage 3: `⋮ → Edit` on the running plan. Editing never touches the
  // Active version: it starts a Draft of the same plan (the existing Assign New
  // Plan route, frozen from the Plan as it stands today), which replaces the
  // Active row in the view and is opened in Edit mode. Cancel on the Draft
  // deletes it and the Active plan is back; Save & Pay commits it.
  async function editPlan(plan: MemberPlanRow) {
    if (plan.membership_plan_id == null) return;
    setCreating(true);
    setCreateError(null);
    try {
      const row = await apiFetch<{ id: number }>(`/user-memberships/${plan.id}/assign-new-plan`, {
        method: 'POST',
        body: JSON.stringify({
          membership_plan_id: plan.membership_plan_id,
          starts_at: new Date().toISOString().slice(0, 10),
        }),
      });
      setNewDraftId(row.id);
      onChanged();
    } catch (err: any) {
      setCreateError(apiErrorMessage(err) ?? t('edit_plan_error'));
    } finally {
      setCreating(false);
    }
  }

  function startAdding() {
    setAdding(true);
  }

  /**
   * The Member card's own actions on one of its plans. `Assign New Plan` and
   * `Cancel Plan` are the live plan's lifecycle actions, so a historical row
   * carries neither — "the exact available actions should follow the plan's
   * status". `Details` is every row's: reading what a past assignment was
   * agreed with is the whole point of keeping it.
   */
  function rowActions(plan: MemberPlanRow, helpers: AssignedPlanRowHelpers): ContextMenuItem[] {
    // #1191: a Linked plan is the owner's contract seen from another Member —
    // it offers no Assign New Plan or Cancel Plan, only Details.
    const lifecycleItems: ContextMenuItem[] = canWrite && plan.is_live && plan.assignment_relationship !== 'linked'
      ? [
        // #1725: a Draft is configured in place — the row's own Edit opens it.
        ...(plan.status === 'draft'
          ? [{ label: t('action_edit_plan'), onClick: () => helpers.startEdit(plan.id) }]
          : []),
        ...(canEditLivePlan(plan)
          ? [{ label: t('action_edit_plan'), onClick: () => void editPlan(plan), disabled: creating || assignBusy }]
          : []),
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
      {/* ACTIVE — the ticket's §4 split, over the Assigned Plans page's table. */}
      {/* #1703: an in-flight (Draft) plan carries no sub-label; the status badge says it. */}
      {visible.heading !== 'draft' && <div style={subLabel}>{t('membership_plans_active')}</div>}
      <AssignedPlansTable
        rows={visible.rows}
        loadingText={t('add_membership_plan_loading')}
        emptyText={t('no_active_membership_plans')}
        onChanged={onChanged}
        scope="member"
        embedded
        viewAsMemberId={memberId}
        rowActions={rowActions}
        openInEditId={newDraftId}
      />

      {createError && !adding && <p style={{ ...formErrorStyle, margin: '8px 0' }}>{createError}</p>}

      {/* #628: the inline Assign New Plan editor for whichever plan raised it —
          under the list it acts on, since a table row is not a card to nest it
          in. Only the plan being superseded renders anything. */}
      {live.map((m) => <React.Fragment key={m.id}>{renderAssignEditor(m)}</React.Fragment>)}

      {/* #958: no generic add while the Member holds a plan — replacing it is
          `Assign New Plan` on the row of the plan being replaced. */}
      {canWrite && live.length === 0 && !adding && (
        <button onClick={startAdding} style={addBtn}>{t('add_membership_plan')}</button>
      )}

      {/* #1450/#1460: the one Assign Plan to Member workflow (the Plans page's
          inline editor), launched with this Member selected. It creates a Draft, which
          appears in the list above and is configured and paid from its card. */}
      {adding && (
        <>
          {optionsLoading && <p style={{ margin: '8px 0' }}>{t('add_membership_plan_loading')}</p>}
          {!optionsLoading && selectable.length === 0 && (
            <div style={{ ...inlineEditorStyle, margin: '10px 0' }}>
              <p style={{ ...formErrorStyle, margin: 0 }}>
                {t(optionsError ? 'add_membership_plan_options_error' : 'no_assignable_membership_plans')}
              </p>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => setAdding(false)} style={secondaryBtnSmall}>{t('add_membership_plan_cancel')}</button>
              </div>
            </div>
          )}
          {!optionsLoading && selectable.length > 0 && (
            <AssignPlanToMembersEditor
              planOptions={selectable}
              initialMember={{ id: memberId, name: memberName, email: memberEmail }}
              onCancel={() => setAdding(false)}
              onAssigned={(created) => {
                setAdding(false);
                // #1692: open the card of the plan just assigned.
                if (created) setNewDraftId(created.id);
                onChanged();
              }}
            />
          )}
        </>
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
// objects rather than restating them.
const subLabel = cardSubLabelStyle;
const addBtn = primaryBtnSmall();
