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
import { SectionEditButton } from '@/components/SectionEditButton';
import { primaryBtnSmall } from '@/components/ui';
import { GOAL_API_ROOTS, GoalListResponse, GoalRow, goalAvailability, goalDisplayName } from '@/components/goalLibrary/goalProfile';
import { AddReadingModal } from './AddReadingModal';
import { AssignedPersonalGoalForm, GoalOption } from './AssignedPersonalGoalForm';
import { GoalReadingHeader } from './GoalReadingHeader';
import { GoalReadingChart } from './GoalReadingChart';
import { GoalReadingHistory } from './GoalReadingHistory';
import { GoalReadingsResponse, ReadingKind } from './goalReadings';
import {
  ASSIGNED_PERSONAL_GOALS_ROOT, AssignedPersonalGoalFormValues,
  AssignedPersonalGoalListResponse, AssignedPersonalGoalRow,
  assignedPersonalGoalFormError, emptyAssignedPersonalGoalForm, formatGoalPeriod, formatTarget,
  toAssignedPersonalGoalCreatePayload, toAssignedPersonalGoalFormValues,
  toAssignedPersonalGoalUpdatePayload,
} from './assignedPersonalGoalProfile';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

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
export function MemberPersonalGoals({ memberId, canWrite }: {
  memberId: number;
  canWrite: boolean;
}) {
  const gymFmt = useGymFormatSettings();
  const t = useTranslations('assigned_personal_goals');
  // A System goal's label was written in `goal_library` (#947).
  const tGoals = useTranslations('goal_library');
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  // #1428: the section's own Edit mode (the Member card has no global one any
  // more). The add/edit/unassign actions belong to it and are absent outside it.
  const [editing, setEditing] = useState(false);
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
  const [removeBusy, setRemoveBusy] = useState(false);

  // #1037 — each goal's reading history, loaded with the section: these cards are
  // open by default (the Member card has no per-goal expansion), so the history
  // accordion is there to be unfolded rather than fetched on demand.
  const [readings, setReadings] = useState<Record<number, GoalReadingsResponse>>({});
  const [reading, setReading] = useState<{ row: AssignedPersonalGoalRow; kind: ReadingKind } | null>(null);

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

  const loadReadings = useCallback(async (ids: number[]) => {
    const histories = await Promise.all(ids.map(async (id) => {
      try {
        return [id, await apiFetch<GoalReadingsResponse>(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${id}/readings`)] as const;
      } catch {
        // A failed history read leaves the card's own figures standing — they are
        // the row's, derived on the list read.
        return null;
      }
    }));
    setReadings((prev) => {
      const next = { ...prev };
      for (const entry of histories) if (entry) next[entry[0]] = entry[1];
      return next;
    });
  }, [apiFetch]);

  useEffect(() => {
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) loadReadings(ids);
  }, [rows, loadReadings]);

  // The catalogue the picker offers — only needed once Edit mode is open, which is
  // also the only moment it can be stale enough to matter.
  useEffect(() => {
    if (!editing) return;
    apiFetch<GoalListResponse>(`${GOAL_API_ROOTS.gym.personal}?limit=200`)
      // #1181 — a goal the gym deactivated is not offered for a new assignment
      // (the server refuses it either way); the picker lists what it may pick.
      .then((data) => setGoals(data.items.filter((goal) => goalAvailability(goal) === 'active')))
      .catch(() => {});
  }, [apiFetch, editing]);

  // Leaving Edit mode discards a half-typed draft, exactly as the card's own
  // sections do (#924 stage 5).
  useEffect(() => {
    if (editing) return;
    setCreating(false); setNewError(null);
    setEditingId(null); setEditError(null);
    // The reading dialog is one of the mode's controls too, so leaving the mode
    // closes it rather than leaving it mounted over a read-only card.
    setReading(null);
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
        target_type: g.target_type ?? 'absolute',
      }))
      .sort((a, b) => a.name.localeCompare(b.name, locale)),
    [goals, tGoals, locale],
  );

  const canEdit = canWrite && editing;

  async function saveNew(): Promise<boolean> {
    const invalid = assignedPersonalGoalFormError(newForm);
    if (invalid) { setNewError(t(invalid as any)); return false; }
    setNewSaving(true); setNewError(null);
    try {
      await apiFetch(ASSIGNED_PERSONAL_GOALS_ROOT, {
        method: 'POST',
        body: JSON.stringify(toAssignedPersonalGoalCreatePayload(newForm)),
      });
      setCreating(false);
      load();
      return true;
    } catch (e: any) {
      setNewError(e.message ?? t('error_generic'));
      return false;
    } finally { setNewSaving(false); }
  }

  async function saveEdit(row: AssignedPersonalGoalRow): Promise<boolean> {
    const invalid = assignedPersonalGoalFormError(editForm);
    if (invalid) { setEditError(t(invalid as any)); return false; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify(toAssignedPersonalGoalUpdatePayload(editForm)),
      });
      setEditingId(null);
      load();
      return true;
    } catch (e: any) {
      setEditError(e.message ?? t('error_generic'));
      return false;
    } finally { setEditSaving(false); }
  }

  // #1489: the section's Save persists whichever inline form is open and leaves
  // Edit mode only when every save succeeded; a failure keeps the mode open with
  // the draft and its error line intact. Everything else in the section already
  // persisted through its own route.
  async function saveSection() {
    if (creating && !(await saveNew())) return;
    const open = editingId === null ? null : rows.find((r) => r.id === editingId);
    if (open && !(await saveEdit(open))) return;
    setEditing(false);
  }

  // Cancel discards the open drafts without saving; the mode-exit effect clears
  // them.
  function cancelSection() { setEditing(false); }

  // #1428 §2.3: unassigning is a permanent delete of the assignment and its
  // readings (one transaction, server-side). A second click while it runs is
  // ignored, and the section refreshes only on success.
  async function confirmRemove() {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${removing.id}/permanent`, { method: 'DELETE' });
      setRemoving(null);
      toast(t('unassigned_toast'));
      load();
    } catch (e: any) {
      toast(e.message ?? t('error_generic'));
      setRemoving(null);
    } finally { setRemoveBusy(false); }
  }

  if (loading) return <p style={cardMutedTextStyle}>{t('loading')}</p>;

  return (
    <div>
      {canWrite && (
        <div style={{ marginBottom: 8 }}>
          {editing ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={{ ...primaryBtnSmall(), opacity: newSaving || editSaving ? 0.6 : 1 }}
                disabled={newSaving || editSaving}
                onClick={saveSection}
              >
                {t('save')}
              </button>
              <button type="button" style={secondaryBtnSmall} disabled={newSaving || editSaving} onClick={cancelSection}>
                {t('cancel')}
              </button>
            </div>
          ) : (
            <SectionEditButton label={t('edit')} onClick={() => setEditing(true)} />
          )}
        </div>
      )}
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
              {/* #1037 §5 — the five structured fields, the Status badge beside
                  them. The goal's name is one of those fields rather than a
                  heading above them: rendering it twice is the pipe-separated
                  sentence §5 rejects wearing a different shape. */}
              <GoalReadingHeader
                goalName={nameOfGoal(row)}
                target={formatTarget(row)}
                unit={row.target_unit}
                summary={row}
                label={(key) => t(key as any)}
                trailing={<StatusBadge status={row.status} label={t(`status_${row.status}` as any)} />}
              />
              {/* The card's own `Label: Value` row (#929), never a second one. */}
              <CardDetailRow label={t('label_period')} value={formatGoalPeriod(row, locale, gymFmt)} />
              {row.notes && <CardDetailRow label={t('label_notes')} value={row.notes} />}
              {/* §12 — the chart between the header and the history. */}
              <div style={{ marginTop: 8 }}>
                <GoalReadingChart
                  readings={readings[row.id]?.readings ?? []}
                  unit={row.target_unit}
                  target={row.effective_target}
                  locale={locale}
                  labels={{
                    title: t('section_progress_chart'),
                    ariaLabel: t('chart_aria_label'),
                    // No target, no caption and no reference line — a line
                    // labelled `Target —` explains nothing.
                    target: row.target_value === null
                      ? null
                      : t('chart_target', { value: formatTarget(row) }),
                  }}
                />
              </div>
              {/* §12/§18 — the history under the header, collapsed until asked for. */}
              <div style={{ marginTop: 8 }}>
                <GoalReadingHistory
                  readings={readings[row.id]?.readings ?? []}
                  unit={row.target_unit}
                  locale={locale}
                  label={(key) => t(key as any)}
                />
              </div>
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
                  {/* #1037 §3/§21 — a measurement and a new baseline, two
                      writers rather than one with a flag. They belong to Edit
                      mode like every other control in this section (#797/#957):
                      absent outside it, not disabled. */}
                  <button type="button" style={secondaryBtnSmall} onClick={() => setReading({ row, kind: 'reading' })}>
                    {t('add_reading')}
                  </button>
                  <button type="button" style={secondaryBtnSmall} onClick={() => setReading({ row, kind: 'initial' })}>
                    {t('set_initial_reading')}
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
          {t('member_add_goal')}
        </button>
      )}

      {reading && (
        <AddReadingModal
          assignmentId={reading.row.id}
          kind={reading.kind}
          goalName={nameOfGoal(reading.row)}
          unit={reading.row.target_unit}
          label={(key) => t(key as any)}
          onClose={() => setReading(null)}
          onSaved={async () => {
            const id = reading.row.id;
            setReading(null);
            // §30 — the header and the history both refresh, with no manual reload.
            await Promise.all([load(), loadReadings([id])]);
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          open
          message={t('member_unassign_title')}
          details={<p style={{ margin: '8px 0 0', fontSize: 14 }}>{t('member_unassign_message')}</p>}
          busy={removeBusy}
          confirmLabel={t('member_unassign_confirm_label')}
          cancelLabel={t('cancel')}
          onConfirm={confirmRemove}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
