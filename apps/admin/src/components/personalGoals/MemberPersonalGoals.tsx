'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import {
  cardMutedTextStyle, dashedAddBtnStyle, innerCardStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { CardDetailRow } from '@/components/CardDetailRow';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { GOAL_API_ROOTS, GoalListResponse, GoalRow, goalDisplayName } from '@/components/goalLibrary/goalProfile';
import { AssignedPersonalGoalForm, GoalOption } from './AssignedPersonalGoalForm';
import {
  ASSIGNED_PERSONAL_GOALS_ROOT, AssignedPersonalGoalFormValues,
  AssignedPersonalGoalListResponse, AssignedPersonalGoalRow,
  assignedPersonalGoalFormError, emptyAssignedPersonalGoalForm, formatGoalPeriod, formatTarget,
  toAssignedPersonalGoalCreatePayload, toAssignedPersonalGoalFormValues,
  toAssignedPersonalGoalUpdatePayload,
} from './assignedPersonalGoalProfile';

/**
 * #948 §4 — the Member card's **PERSONAL GOALS** section: the goals this member
 * holds, and (in Edit mode) the controls to assign, edit and unassign one.
 *
 * Goals *are* assigned on a Member directly, which the ticket thread settles
 * explicitly — the opposite of #931's answer for Promotions, and the reason this
 * section exists beside the gym-wide Assigned Personal Goals page rather than
 * instead of it.
 *
 * Two app-wide rules shape it, and neither is this component's to reinterpret:
 *
 * * **Expanding a card reads; `⋮ → Edit` writes** (#797/#957). Every control here
 *   keys off the `editing` flag the card hands down, so the read-only view carries
 *   no `+ Assign`, no `Edit`, no `Remove` and no form — absent rather than
 *   disabled. `canWrite` is the permission and `editing` is the mode; both must
 *   hold.
 * * **One editor for an entity administered from two screens** (#806). The form
 *   body is the gym-wide section's own `AssignedPersonalGoalForm` over the same
 *   declaration, so a field added there appears here, and the member is fixed
 *   rather than a dropdown that could assign to somebody else from inside this
 *   member's card.
 */
export function MemberPersonalGoals({ memberId, canWrite, editing }: {
  memberId: number;
  canWrite: boolean;
  /** The Member card's Edit mode — the add/edit/remove actions belong to it. */
  editing: boolean;
}) {
  const t = useTranslations('assigned_personal_goals');
  // A System goal's label was written in `goal_library` (#947).
  const tGoals = useTranslations('goal_library');
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<AssignedPersonalGoalRow[]>([]);
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState<AssignedPersonalGoalFormValues>(emptyAssignedPersonalGoalForm(memberId));
  const [newError, setNewError] = useState<string | null>(null);
  const [newSaving, setNewSaving] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<AssignedPersonalGoalFormValues>(emptyAssignedPersonalGoalForm(memberId));
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const [removing, setRemoving] = useState<AssignedPersonalGoalRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<AssignedPersonalGoalListResponse>(
        `${ASSIGNED_PERSONAL_GOALS_ROOT}?member_id=${memberId}&limit=200`,
      );
      setRows(data.items);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally { setLoading(false); }
    // `t`/`toast` excluded for the reason every list in the app excludes them:
    // a new identity per render would re-run this effect for ever.
  }, [apiFetch, memberId]);

  useEffect(() => { load(); }, [load]);

  // The catalogue the picker offers — only needed once Edit mode is open, which is
  // also the only moment it can be stale enough to matter.
  useEffect(() => {
    if (!editing) return;
    apiFetch<GoalListResponse>(`${GOAL_API_ROOTS.gym.personal}?limit=200`)
      .then((data) => setGoals(data.items))
      .catch(() => {});
  }, [apiFetch, editing]);

  // Leaving Edit mode discards a half-typed draft, exactly as the card's own
  // sections do (#924 stage 5).
  useEffect(() => {
    if (editing) return;
    setCreating(false); setNewError(null);
    setEditingId(null); setEditError(null);
  }, [editing]);

  const nameOfGoal = useCallback(
    (row: Pick<AssignedPersonalGoalRow, 'goal_slug' | 'goal_name'>) =>
      goalDisplayName({ slug: row.goal_slug, name: row.goal_name }, 'personal', (key) => tGoals(key as any)),
    [tGoals],
  );

  const goalOptions: GoalOption[] = useMemo(
    () => goals
      .map((g) => ({
        id: g.id,
        name: goalDisplayName(g, 'personal', (key) => tGoals(key as any)),
        gym_id: g.gym_id,
        // #1034: the catalogue's own target, so the picker pre-fills it.
        target_value: g.target_value ?? null,
        target_unit: g.target_unit ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [goals, tGoals, locale],
  );

  const canEdit = canWrite && editing;

  async function saveNew() {
    const invalid = assignedPersonalGoalFormError(newForm);
    if (invalid) { setNewError(t(invalid as any)); return; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch(ASSIGNED_PERSONAL_GOALS_ROOT, {
        method: 'POST',
        body: JSON.stringify(toAssignedPersonalGoalCreatePayload(newForm)),
      });
      setCreating(false);
      load();
    } catch (e: any) {
      setNewError(e.message ?? t('error_generic'));
    } finally { setNewSaving(false); }
  }

  async function saveEdit(row: AssignedPersonalGoalRow) {
    const invalid = assignedPersonalGoalFormError(editForm);
    if (invalid) { setEditError(t(invalid as any)); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify(toAssignedPersonalGoalUpdatePayload(editForm)),
      });
      setEditingId(null);
      load();
    } catch (e: any) {
      setEditError(e.message ?? t('error_generic'));
    } finally { setEditSaving(false); }
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${removing.id}`, { method: 'DELETE' });
      setRemoving(null);
      load();
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
      setRemoving(null);
    }
  }

  if (loading) return <p style={cardMutedTextStyle}>{t('loading')}</p>;

  return (
    <div>
      {rows.length === 0 && !creating && <p style={cardMutedTextStyle}>{t('member_empty')}</p>}

      {rows.map((row) => (
        <div key={row.id} style={innerCardStyle}>
          {editingId === row.id ? (
            <AssignedPersonalGoalForm
              mode="edit"
              form={editForm}
              goals={goalOptions}
              memberName={row.member_name}
              goalName={nameOfGoal(row)}
              error={editError}
              saving={editSaving}
              label={(key) => t(key as any)}
              onChange={setEditForm}
              onCancel={() => { setEditingId(null); setEditError(null); }}
              onSave={() => saveEdit(row)}
              saveLabel={t('save')}
            />
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>{nameOfGoal(row)}</div>
                <StatusBadge status={row.status} label={t(`status_${row.status}` as any)} />
              </div>
              {/* The card's own `Label: Value` row (#929), never a second one. */}
              <CardDetailRow label={t('label_target')} value={formatTarget(row)} />
              <CardDetailRow label={t('label_period')} value={formatGoalPeriod(row, locale)} />
              {row.notes && <CardDetailRow label={t('label_notes')} value={row.notes} />}
              {/* Both actions belong to Edit mode: absent outside it, not disabled. */}
              {canEdit && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={secondaryBtnSmall}
                    onClick={() => {
                      setEditingId(row.id);
                      setEditForm(toAssignedPersonalGoalFormValues(row));
                      setEditError(null);
                    }}
                  >
                    {t('edit')}
                  </button>
                  <button type="button" style={secondaryBtnSmall} onClick={() => setRemoving(row)}>
                    {t('unassign')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {creating && (
        <div style={innerCardStyle}>
          <AssignedPersonalGoalForm
            mode="create"
            form={newForm}
            goals={goalOptions}
            error={newError}
            saving={newSaving}
            label={(key) => t(key as any)}
            onChange={setNewForm}
            onCancel={() => { setCreating(false); setNewError(null); }}
            onSave={saveNew}
            saveLabel={t('create')}
          />
        </div>
      )}

      {canEdit && !creating && (
        // `+ Add …` is the dashed secondary affordance every card section uses
        // (#929/#971), not a filled primary button: the card's own Save is that.
        <button
          type="button"
          style={dashedAddBtnStyle}
          onClick={() => {
            setNewForm(emptyAssignedPersonalGoalForm(memberId));
            setNewError(null);
            setCreating(true);
          }}
        >
          {t('member_add')}
        </button>
      )}

      {removing && (
        <ConfirmDialog
          open
          message={t('unassign_confirm')}
          confirmLabel={t('unassign')}
          cancelLabel={t('cancel')}
          onConfirm={confirmRemove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
