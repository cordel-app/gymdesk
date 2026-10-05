'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { MemberDialog } from '@/components/MemberDialog';
import {
  destructiveButtonStyle,
  inputStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionCardStyle,
  statusPillStyle,
  statusTone,
} from '@/lib/memberChrome';
import {
  AssignableGoal,
  GoalFormValues,
  MemberGoal,
  emptyGoalForm,
  formForAssignableGoal,
  formForMemberGoal,
  formatGoalTarget,
  goalDisplayName,
  goalFormError,
  goalStatusKey,
  goalStatusToneKey,
  toGoalCreatePayload,
  toGoalUpdatePayload,
} from '@/lib/memberGoals';

/**
 * #1036 — **My Goals**.
 *
 * The member's own Personal Goals: the ones they are pursuing, the ones that
 * are over, and the three actions §4 allows — assign an existing Gym Goal to
 * themselves, edit the target they agreed, remove it again. What they cannot do
 * is create a Goal **definition** (§4, §6): the picker is a read of the gym's
 * catalogue and there is no free-text name anywhere on this page.
 *
 * Every decision — the label a goal is shown under, what its target reads as,
 * which list a row belongs in, what a form submits and which field is wrong —
 * is `lib/memberGoals.ts`'s, and every colour, surface and button is
 * `lib/memberChrome.ts`'s (#983). This file is markup, state and requests.
 */

interface GoalsResponse { goals: MemberGoal[]; past_goals: MemberGoal[] }

type Editing =
  | { kind: 'add' }
  | { kind: 'edit'; goal: MemberGoal }
  | { kind: 'remove'; goal: MemberGoal }
  | null;

export default function GoalsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading, isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [goals, setGoals] = useState<MemberGoal[]>([]);
  const [pastGoals, setPastGoals] = useState<MemberGoal[]>([]);
  const [available, setAvailable] = useState<AssignableGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [form, setForm] = useState<GoalFormValues>(emptyGoalForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [mine, options] = await Promise.all([
      apiFetch<GoalsResponse>('/me/personal-goals'),
      apiFetch<{ goals: AssignableGoal[] }>('/me/personal-goals/available'),
    ]);
    setGoals(mine.goals ?? []);
    setPastGoals(mine.past_goals ?? []);
    setAvailable(options.goals ?? []);
  }, [apiFetch]);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    // Superadmins bypass member_web.* flags only in their native capacity —
    // while impersonating, visibility must reflect that member's flags (#439).
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.my_goals')) {
      router.replace(`/${locale}`);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? t('goals.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  function openAdd() {
    setForm(emptyGoalForm);
    setFormError(null);
    setNotice(null);
    setEditing({ kind: 'add' });
  }

  function openEdit(goal: MemberGoal) {
    setForm(formForMemberGoal(goal));
    setFormError(null);
    setNotice(null);
    setEditing({ kind: 'edit', goal });
  }

  function closeDialog() {
    setEditing(null);
    setFormError(null);
  }

  /** Picking a goal pre-fills the target it carries (§5). */
  function selectGoal(id: string) {
    const goal = available.find((g) => String(g.id) === id);
    setForm(goal ? formForAssignableGoal(goal) : { ...form, personal_goal_id: id });
  }

  async function submit() {
    if (!editing || editing.kind === 'remove') return;
    const invalid = goalFormError(form, { requireGoal: editing.kind === 'add' });
    if (invalid) { setFormError(t(invalid as any)); return; }

    setSaving(true);
    setFormError(null);
    try {
      if (editing.kind === 'add') {
        await apiFetch('/me/personal-goals', { method: 'POST', body: JSON.stringify(toGoalCreatePayload(form)) });
        setNotice(t('goals.added'));
      } else {
        await apiFetch(`/me/personal-goals/${editing.goal.id}`, {
          method: 'PUT', body: JSON.stringify(toGoalUpdatePayload(form)),
        });
        setNotice(t('goals.saved'));
      }
      await load();
      setEditing(null);
    } catch (err: any) {
      // The dialog stays open with the member's input intact — the server's
      // message is the duplicate 409, a refused target or a lost connection,
      // and all three are worth reading beside the field that caused them.
      setFormError(err?.message ?? t('goals.error'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(goal: MemberGoal) {
    setSaving(true);
    setFormError(null);
    try {
      await apiFetch(`/me/personal-goals/${goal.id}`, { method: 'DELETE' });
      await load();
      setEditing(null);
      setNotice(t('goals.removed'));
    } catch (err: any) {
      setFormError(err?.message ?? t('goals.error'));
    } finally {
      setSaving(false);
    }
  }

  const nameOf = (goal: MemberGoal) => goalDisplayName(goal, t as unknown as (key: string) => string);

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('goals.loading')}</p></main>;
  }

  if (error) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{error}</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('goals.title')}</h1>

      {notice && <p style={{ ...noticeStyle('success'), marginBottom: 14 }}>{notice}</p>}

      {goals.length === 0 ? (
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎯</div>
          <p style={styles.hint}>{t('goals.empty')}</p>
          <button type="button" style={styles.primaryBtn} onClick={openAdd}>{t('goals.add')}</button>
        </div>
      ) : (
        <>
          <section style={styles.section}>
            {goals.map((goal) => (
              <article key={goal.id} style={styles.card}>
                <p style={styles.goalName}>{nameOf(goal)}</p>
                {formatGoalTarget(goal) && <p style={styles.goalTarget}>{formatGoalTarget(goal)}</p>}
                {goal.notes && <p style={styles.goalNotes}>{goal.notes}</p>}
                <div style={styles.cardActions}>
                  <button type="button" style={styles.secondaryBtn} onClick={() => openEdit(goal)}>
                    {t('goals.edit')}
                  </button>
                  <button
                    type="button"
                    style={styles.destructiveBtn}
                    onClick={() => { setNotice(null); setFormError(null); setEditing({ kind: 'remove', goal }); }}
                  >
                    {t('goals.remove')}
                  </button>
                </div>
              </article>
            ))}
          </section>
          <button type="button" style={{ ...styles.primaryBtn, width: '100%' }} onClick={openAdd}>
            {t('goals.add')}
          </button>
        </>
      )}

      {/* `Q4` — the goals that are over: removed, achieved or abandoned. Read
          only: there is nothing to edit on a goal that has ended, and assigning
          it again is `Add goal`, which creates a new one rather than reviving
          this record (§12). */}
      {pastGoals.length > 0 && (
        <section style={{ ...styles.section, marginTop: 28 }}>
          <h2 style={styles.h2}>{t('goals.past_title')}</h2>
          {pastGoals.map((goal) => (
            <article key={goal.id} style={{ ...styles.card, ...styles.pastCard }}>
              <div style={styles.pastHeader}>
                <p style={styles.goalName}>{nameOf(goal)}</p>
                <span style={statusPillStyle(statusTone(goalStatusToneKey(goal)))}>
                  {t(goalStatusKey(goal) as any)}
                </span>
              </div>
              {formatGoalTarget(goal) && <p style={styles.goalTarget}>{formatGoalTarget(goal)}</p>}
              <p style={styles.goalDates}>
                {[
                  goal.start_date ? t('goals.started_on', { date: goal.start_date }) : null,
                  goal.end_date ? t('goals.ended_on', { date: goal.end_date }) : null,
                ].filter(Boolean).join(' · ')}
              </p>
            </article>
          ))}
        </section>
      )}

      {/* Add / Edit */}
      {editing && editing.kind !== 'remove' && (
        <MemberDialog
          labelledBy="goal-dialog-title"
          title={editing.kind === 'add' ? t('goals.add') : t('goals.edit_title')}
          onClose={saving ? () => {} : closeDialog}
          actions={(
            <>
              <button type="button" style={styles.dialogSecondary} onClick={closeDialog} disabled={saving}>
                {t('goals.cancel')}
              </button>
              <button type="button" style={styles.dialogPrimary} onClick={submit} disabled={saving}>
                {saving ? t('goals.saving') : (editing.kind === 'add' ? t('goals.add') : t('goals.save'))}
              </button>
            </>
          )}
        >
          {editing.kind === 'add' ? (
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_goal')}</span>
              {/* §6 — a select over the gym's own catalogue, never a text
                  field: the member picks an existing Gym Goal or nothing. The
                  options are the server's `available` list, which already
                  leaves out the retired ones and the ones they hold (§7). */}
              <select
                style={styles.control}
                value={form.personal_goal_id}
                onChange={(e) => selectGoal(e.target.value)}
              >
                <option value="">{t('goals.select_placeholder')}</option>
                {available.map((goal) => (
                  <option key={goal.id} value={goal.id}>
                    {goalDisplayName(goal, t as unknown as (key: string) => string)}
                  </option>
                ))}
              </select>
              {available.length === 0 && <span style={styles.help}>{t('goals.none_available')}</span>}
            </label>
          ) : (
            <div style={styles.field}>
              <span style={styles.label}>{t('goals.field_goal')}</span>
              {/* The goal itself is immutable on an edit (§12), so it reads as
                  a value rather than as a control the `PUT` would ignore. */}
              <p style={styles.readOnlyValue}>{nameOf(editing.goal)}</p>
            </div>
          )}

          <div style={styles.fieldRow}>
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_target')}</span>
              <input
                style={styles.control}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={form.target_value}
                onChange={(e) => setForm({ ...form, target_value: e.target.value })}
              />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_unit')}</span>
              <input
                style={styles.control}
                type="text"
                maxLength={20}
                value={form.target_unit}
                onChange={(e) => setForm({ ...form, target_unit: e.target.value })}
              />
            </label>
          </div>

          <div style={styles.fieldRow}>
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_start_date')}</span>
              <input
                style={styles.control}
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_target_date')}</span>
              <input
                style={styles.control}
                type="date"
                value={form.target_date}
                onChange={(e) => setForm({ ...form, target_date: e.target.value })}
              />
            </label>
          </div>

          <label style={styles.field}>
            <span style={styles.label}>{t('goals.field_notes')}</span>
            <textarea
              style={{ ...styles.control, minHeight: 72, resize: 'vertical' }}
              maxLength={1000}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </label>

          {formError && <p style={styles.error}>{formError}</p>}
        </MemberDialog>
      )}

      {/* §11 — the confirmation a destructive action gets everywhere else in
          the app, in the app's own dialog rather than a second overlay style. */}
      {editing && editing.kind === 'remove' && (
        <MemberDialog
          labelledBy="goal-remove-title"
          title={t('goals.remove_title')}
          onClose={saving ? () => {} : closeDialog}
          actions={(
            <>
              <button type="button" style={styles.dialogSecondary} onClick={closeDialog} disabled={saving}>
                {t('goals.cancel')}
              </button>
              <button
                type="button"
                style={{ ...styles.dialogDestructive, ...(saving ? styles.busy : null) }}
                onClick={() => remove(editing.goal)}
                disabled={saving}
              >
                {saving ? t('goals.saving') : t('goals.remove')}
              </button>
            </>
          )}
        >
          <p style={styles.confirmText}>{t('goals.remove_confirm', { name: nameOf(editing.goal) })}</p>
          {formError && <p style={styles.error}>{formError}</p>}
        </MemberDialog>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:  { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:      { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1 },
  h2:         { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: memberTheme.title2, textTransform: 'uppercase', letterSpacing: '0.05em' },
  section:    { marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  card:       { ...sectionCardStyle, padding: '14px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  pastCard:   { opacity: 0.85 },
  pastHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  goalName:   { margin: 0, fontSize: 16, fontWeight: 700, color: memberTheme.text },
  goalTarget: { margin: '4px 0 0', fontSize: 14, color: memberTheme.textSecondary },
  goalNotes:  { margin: '6px 0 0', fontSize: 12, color: memberTheme.textMuted, fontStyle: 'italic' },
  goalDates:  { margin: '6px 0 0', fontSize: 12, color: memberTheme.textMuted },
  cardActions:{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' },
  primaryBtn: { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600 },
  secondaryBtn: { ...secondaryButtonStyle, padding: '8px 16px', fontSize: 13, fontWeight: 600 },
  destructiveBtn: { ...destructiveButtonStyle, padding: '8px 16px', fontSize: 13, fontWeight: 600 },
  dialogPrimary: { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  dialogSecondary: { ...secondaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  dialogDestructive: { ...destructiveButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  busy:       { opacity: 0.6, cursor: 'default' },
  field:      { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 0 },
  fieldRow:   { display: 'flex', gap: 12, flexWrap: 'wrap' },
  label:      { fontSize: 12, fontWeight: 600, color: memberTheme.textSecondary },
  control:    { ...inputStyle, padding: '9px 10px', fontSize: 14, width: '100%', boxSizing: 'border-box' },
  readOnlyValue: { margin: 0, padding: '9px 0', fontSize: 14, color: memberTheme.text },
  help:       { fontSize: 12, color: memberTheme.textMuted },
  error:      { margin: 0, fontSize: 13, color: memberTheme.statusError },
  confirmText:{ margin: 0, fontSize: 14, color: memberTheme.textSecondary },
  emptyCard:  { ...sectionCardStyle, padding: '40px 24px', textAlign: 'center' },
  hint:       { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
