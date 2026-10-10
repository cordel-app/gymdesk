'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { MemberDialog } from '@/components/MemberDialog';
import { MemberGoalCard, type MemberGoalCardMenuItem } from '@/components/MemberGoalCard';
import { GoalHeaderFields, GoalReadingHistory } from '@/components/GoalReadings';
import { GoalReadingChart } from '@/components/GoalReadingChart';
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
  GOAL_HEADER_FIELDS,
  GoalFormValues,
  GoalReadingsResponse,
  MemberGoal,
  READING_ENDPOINTS,
  READING_MARKER_KEYS,
  ReadingFormValues,
  ReadingKind,
  emptyReadingForm,
  formatProgressPercent,
  formatReadingValue,
  newGoalForm,
  readingFormError,
  toReadingPayload,
  formForAssignableGoal,
  formForMemberGoal,
  formatGoalTarget,
  goalDisplayName,
  goalFormError,
  goalStatusKey,
  goalStatusToneKey,
  goalSummaryLine,
  toGoalCreatePayload,
  toGoalUpdatePayload,
} from '@/lib/memberGoals';

/**
 * #1036 — **My Goals**, as #1115's cards.
 *
 * The member's own Personal Goals: the ones they are pursuing, the ones that
 * are over, and the three actions §4 allows — assign an existing Gym Goal to
 * themselves, edit the target they agreed, remove it again. What they cannot do
 * is create a Goal **definition** (§4, §6): the picker is a read of the gym's
 * catalogue and there is no free-text name anywhere on this page.
 *
 * Since #1115 each live goal is an individual **card**, collapsed by default,
 * whose header carries the one line a member scans (name · target · progress)
 * and whose body is the progress content underneath. Creating and editing are
 * **inline, in the card** — no dialog — so the only overlays left on this
 * screen are the two that are not forms over a goal's own fields: #1037's Add
 * reading and the removal confirmation.
 *
 * Every decision — the label a goal is shown under, what its target reads as,
 * which list a row belongs in, what a form submits and which field is wrong —
 * is `lib/memberGoals.ts`'s, every colour, surface and button is
 * `lib/memberChrome.ts`'s (#983), and the card's own shape is
 * `components/MemberGoalCard.tsx`'s. This file is markup, state and requests.
 */

interface GoalsResponse { goals: MemberGoal[]; past_goals: MemberGoal[] }

type Editing =
  // #1115 §2/§3 — both are inline states of a card, never a dialog: `add` is
  // the draft card at the top of the section, `edit` turns one existing card's
  // body into its form.
  | { kind: 'add' }
  | { kind: 'edit'; goal: MemberGoal }
  | { kind: 'remove'; goal: MemberGoal }
  // #1037 §3/§21 — a measurement and a new baseline. Two dialogs over two
  // routes, never one with a flag: nothing the browser submits says which, so a
  // member cannot re-baseline a goal by passing a field through.
  | { kind: 'reading'; goal: MemberGoal; reading: ReadingKind }
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
  const [form, setForm] = useState<GoalFormValues>(newGoalForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // #1115 §1 — which cards the member has opened. Collapsed is the default, so
  // an id absent from this map is a closed card and a goal added later opens
  // closed like every other.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // #1037 — each goal's reading history, keyed by assignment. The five header
  // fields are already on the row (the API derives them on every read), so this
  // is only the list §18 unfolds.
  const [readings, setReadings] = useState<Record<number, GoalReadingsResponse>>({});
  const [readingForm, setReadingForm] = useState<ReadingFormValues>(() => emptyReadingForm());

  const loadReadings = useCallback(async (ids: number[]) => {
    const histories = await Promise.all(ids.map(async (id) => {
      try {
        return [id, await apiFetch<GoalReadingsResponse>(`/me/personal-goals/${id}/readings`)] as const;
      } catch {
        // A failed history read leaves the card's own figures standing: they came
        // with the goal, and an empty accordion beats an error over a correct card.
        return null;
      }
    }));
    setReadings((prev) => {
      const next = { ...prev };
      for (const entry of histories) if (entry) next[entry[0]] = entry[1];
      return next;
    });
  }, [apiFetch]);

  const load = useCallback(async () => {
    const [mine, options] = await Promise.all([
      apiFetch<GoalsResponse>('/me/personal-goals'),
      apiFetch<{ goals: AssignableGoal[] }>('/me/personal-goals/available'),
    ]);
    setGoals(mine.goals ?? []);
    setPastGoals(mine.past_goals ?? []);
    setAvailable(options.goals ?? []);
    const live = (mine.goals ?? []).map((goal) => goal.id);
    // The histories come with the page rather than with the first expand:
    // opening a card is presentation and fetches nothing (#955's rule).
    if (live.length > 0) await loadReadings(live);
  }, [apiFetch, loadReadings]);

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

  /** §2 — the draft card, with today's date already in Start date. */
  function openAdd() {
    setForm(newGoalForm());
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

  /**
   * §3 — the dialog that records a measurement, and §21's that moves the
   * baseline. One form, two routes: the unit is the goal's own and is never a
   * field, so the member types a number and a date and nothing else.
   */
  function openReading(goal: MemberGoal, reading: ReadingKind) {
    setReadingForm(emptyReadingForm());
    setFormError(null);
    setNotice(null);
    setEditing({ kind: 'reading', goal, reading });
  }

  /**
   * §2/§3 — Cancel. A draft card disappears with its unsaved values; an edited
   * card goes back to the state it was displayed in, with the stored values
   * intact because nothing was written.
   */
  function closeEditing() {
    setEditing(null);
    setFormError(null);
  }

  function toggleCard(id: number) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  /**
   * §30 — a saved reading updates the header, the history and the progress with
   * no manual refresh: the goals read re-derives the five fields and the history
   * read re-lists the rows.
   */
  async function submitReading(goal: MemberGoal, kind: ReadingKind) {
    const invalid = readingFormError(readingForm);
    if (invalid) { setFormError(t(invalid as any)); return; }
    setSaving(true);
    setFormError(null);
    try {
      await apiFetch(`/me/personal-goals/${goal.id}/${READING_ENDPOINTS[kind]}`, {
        method: 'POST',
        body: JSON.stringify(toReadingPayload(readingForm)),
      });
      await load();
      setEditing(null);
      setNotice(t(kind === 'initial' ? 'goals.initial_reading_saved' : 'goals.reading_added'));
    } catch (err: any) {
      // The dialog stays open with the number intact, so the server's message is
      // read beside the field that caused it.
      setFormError(err?.message ?? t('goals.error'));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Picking a goal pre-fills the target it carries (§5), over the draft the
   * member is already filling in — so the Start date §2 put there survives it.
   */
  function selectGoal(id: string) {
    const goal = available.find((g) => String(g.id) === id);
    setForm(goal ? formForAssignableGoal(goal, form) : { ...form, personal_goal_id: id });
  }

  async function submit() {
    if (!editing || editing.kind === 'remove' || editing.kind === 'reading') return;
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
      // The card stays in its editing state with the member's input intact —
      // the server's message is the duplicate 409, a refused target or a lost
      // connection, and all three are worth reading beside the fields.
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

  /**
   * §5's five fields for one goal, resolved and formatted here so the shared
   * component renders strings and decides nothing (`NutritionItemRow`'s rule).
   * A figure the server could not compute reads `—`, never `0` or `0%`.
   */
  function headerFields(goal: MemberGoal) {
    const values: Record<(typeof GOAL_HEADER_FIELDS)[number], string | null> = {
      'goals.field_goal': nameOf(goal),
      'goals.label_initial_reading': formatReadingValue(goal.initial_reading, goal.target_unit),
      'goals.field_target': formatGoalTarget(goal),
      'goals.label_latest_reading': formatReadingValue(goal.latest_reading, goal.target_unit),
      'goals.label_progress': formatProgressPercent(goal.progress_percent),
    };
    return GOAL_HEADER_FIELDS.map((key) => ({
      key, label: t(key as any), value: values[key] ?? '—',
    }));
  }

  /**
   * #1115 §1 — the card header's own line: the target the goal was agreed at
   * and how far along it is. Either half may be missing (a qualitative goal has
   * no target; a goal nobody has measured has no percentage), and the lib leaves
   * out what is absent rather than placeholdering it.
   */
  function cardSummary(goal: MemberGoal): string | null {
    const target = formatGoalTarget(goal);
    return goalSummaryLine([
      target === null ? null : t('goals.summary_target', { value: target }),
      formatProgressPercent(goal.progress_percent),
    ]);
  }

  /** §4 — what the card's `⋮` offers. Edit and Remove are the two §4 requires. */
  function cardMenu(goal: MemberGoal): MemberGoalCardMenuItem[] {
    return [
      { key: 'reading', label: t('goals.add_reading'), onSelect: () => openReading(goal, 'reading') },
      { key: 'initial', label: t('goals.set_initial_reading'), onSelect: () => openReading(goal, 'initial') },
      { key: 'edit', label: t('goals.edit'), onSelect: () => openEdit(goal) },
      {
        key: 'remove',
        label: t('goals.remove'),
        danger: true,
        onSelect: () => { setNotice(null); setFormError(null); setEditing({ kind: 'remove', goal }); },
      },
    ];
  }

  /** A past goal's one extra line: what it was last measured at, if ever. */
  function pastSummary(goal: MemberGoal): string | null {
    const latest = formatReadingValue(goal.latest_reading, goal.target_unit);
    if (!latest) return null;
    const progress = formatProgressPercent(goal.progress_percent);
    return progress
      ? t('goals.past_summary', { latest, progress })
      : t('goals.past_summary_latest', { latest });
  }

  /**
   * The chart's three strings. The chart resolves none of them itself, like
   * every other Members App component (#932's rule), and the target is
   * interpolated here — a goal with no target gets no caption and no reference
   * line rather than one reading `Target —`.
   */
  function chartLabels(goal: MemberGoal) {
    // #1229: the line is drawn at the effective target (baseline + change for a relative goal).
    const target = formatReadingValue(goal.effective_target ?? goal.target_value, goal.target_unit);
    return {
      title: t('goals.section_progress_chart'),
      ariaLabel: t('goals.chart_aria_label'),
      target: target === null ? null : t('goals.chart_target', { value: target }),
    };
  }

  const historyLabels = {
    title: t('goals.section_reading_history'),
    empty: t('goals.readings_empty'),
    markers: {
      [READING_MARKER_KEYS.initial]: t('goals.marker_initial'),
      [READING_MARKER_KEYS.new_initial]: t('goals.marker_new_initial'),
    },
  };

  /**
   * §2/§3 — the one form behind both inline states, so the create card and the
   * edit card cannot drift apart: the only difference is the goal itself, which
   * is a picker while adding and a value once assigned (§12 — the assignment's
   * goal is immutable).
   *
   * The **unit** is read-only in both (§1): it belongs to the Gym Goal, so it is
   * shown beside the target rather than asked for, exactly as the Add reading
   * dialog shows it.
   */
  function goalForm(mode: 'add' | 'edit', goal?: MemberGoal) {
    const unit = form.target_unit.trim();
    return (
      <div style={styles.formBody}>
        {mode === 'add' ? (
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
              {available.map((option) => (
                <option key={option.id} value={option.id}>
                  {goalDisplayName(option, t as unknown as (key: string) => string)}
                </option>
              ))}
            </select>
            {available.length === 0 && <span style={styles.help}>{t('goals.none_available')}</span>}
          </label>
        ) : (
          <div style={styles.field}>
            <span style={styles.label}>{t('goals.field_goal')}</span>
            <p style={styles.readOnlyValue}>{goal ? nameOf(goal) : ''}</p>
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
          <div style={styles.field}>
            <span style={styles.label}>{t('goals.field_unit')}</span>
            {/* Read-only (§1): the unit is the goal's own, so it reads as a
                value rather than as a control. A target the member clears takes
                it with it, which `toGoalUpdatePayload()` decides. */}
            <p style={styles.readOnlyValue}>{unit === '' ? '—' : unit}</p>
          </div>
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

        {/* §2/§3 — Save and Cancel close the form they belong to, under the
            fields they commit rather than in a dialog footer. */}
        <div style={styles.formActions}>
          <button type="button" style={styles.primarySmallBtn} onClick={submit} disabled={saving}>
            {saving ? t('goals.saving') : t('goals.save')}
          </button>
          <button type="button" style={styles.secondaryBtn} onClick={closeEditing} disabled={saving}>
            {t('goals.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('goals.loading')}</p></main>;
  }

  if (error) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{error}</p></main>;
  }

  const adding = editing?.kind === 'add';

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('goals.title')}</h1>

      {notice && <p style={{ ...noticeStyle('success'), marginBottom: 14 }}>{notice}</p>}

      {goals.length === 0 && !adding ? (
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎯</div>
          <p style={styles.hint}>{t('goals.empty')}</p>
          {/* §6 — the empty state's CTA opens the same inline card. */}
          <button type="button" style={styles.primaryBtn} onClick={openAdd}>{t('goals.add')}</button>
        </div>
      ) : (
        <>
          <section style={styles.section}>
            {/* §2 — the draft sits at the top of the section, in its editing
                state, rather than in an overlay over it. */}
            {adding && (
              <MemberGoalCard title={t('goals.add')} expanded>
                {goalForm('add')}
              </MemberGoalCard>
            )}

            {goals.map((goal) => {
              const isEditing = editing?.kind === 'edit' && editing.goal.id === goal.id;
              return isEditing ? (
                // §3 — the card itself becomes the form. No menu while it is
                // open: `⋮ → Edit` is what opened it, and Save/Cancel is what
                // leaves it.
                <MemberGoalCard key={goal.id} title={nameOf(goal)} expanded>
                  {goalForm('edit', goal)}
                </MemberGoalCard>
              ) : (
                <MemberGoalCard
                  key={goal.id}
                  title={nameOf(goal)}
                  summary={cardSummary(goal)}
                  expanded={Boolean(expanded[goal.id])}
                  onToggle={() => toggleCard(goal.id)}
                  menu={{ label: t('goals.menu_label'), items: cardMenu(goal) }}
                >
                  {/* §5 — the five structured fields, not a pipe-separated line.
                      The goal's name is one of them rather than a heading above
                      them, so it is not rendered twice. */}
                  <GoalHeaderFields fields={headerFields(goal)} />
                  {goal.notes && <p style={styles.goalNotes}>{goal.notes}</p>}
                  {/* §12 — chart, then history: the chart is what the member
                      reads at a glance, the history is the log under it. */}
                  <GoalReadingChart
                    readings={readings[goal.id]?.readings ?? []}
                    unit={goal.target_unit}
                    target={goal.effective_target ?? goal.target_value}
                    locale={locale}
                    labels={chartLabels(goal)}
                  />
                  {/* §18 — collapsed until the member asks. */}
                  <GoalReadingHistory
                    readings={readings[goal.id]?.readings ?? []}
                    unit={goal.target_unit}
                    locale={locale}
                    labels={historyLabels}
                  />
                </MemberGoalCard>
              );
            })}
          </section>
          {!adding && (
            <button type="button" style={{ ...styles.primaryBtn, width: '100%' }} onClick={openAdd}>
              {t('goals.add')}
            </button>
          )}
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
              {/* A past goal is read-only and has no actions, so it keeps its
                  compact summary — the target it was agreed at and, where it was
                  measured, where it got to. The five-field header belongs to the
                  card the member is still working on. */}
              {formatGoalTarget(goal) && <p style={styles.goalTarget}>{formatGoalTarget(goal)}</p>}
              {pastSummary(goal) && <p style={styles.goalTarget}>{pastSummary(goal)}</p>}
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

      {/* §3 / §21 — Add reading, and the same dialog for a new baseline. The
          unit is the goal's and is shown beside the input rather than asked
          for, and the date defaults to today and cannot be in the future.
          It stays a dialog: it is not a form over the goal's own fields, and
          #1115 §2/§3 is about creating and editing a goal. */}
      {editing && editing.kind === 'reading' && (
        <MemberDialog
          labelledBy="goal-reading-title"
          title={t(editing.reading === 'initial' ? 'goals.set_initial_reading' : 'goals.add_reading')}
          onClose={saving ? () => {} : closeEditing}
          actions={(
            <>
              <button type="button" style={styles.dialogSecondary} onClick={closeEditing} disabled={saving}>
                {t('goals.cancel')}
              </button>
              <button
                type="button"
                style={styles.dialogPrimary}
                onClick={() => submitReading(editing.goal, editing.reading)}
                disabled={saving}
              >
                {saving ? t('goals.saving') : t('goals.save')}
              </button>
            </>
          )}
        >
          <div style={styles.field}>
            <span style={styles.label}>{t('goals.field_goal')}</span>
            <p style={styles.readOnlyValue}>{nameOf(editing.goal)}</p>
          </div>

          {editing.reading === 'initial' && (
            <p style={styles.help}>{t('goals.help_initial_reading')}</p>
          )}

          <div style={styles.fieldRow}>
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_reading')}</span>
              <div style={styles.readingInputRow}>
                <input
                  style={{ ...styles.control, flex: 1, minWidth: 0 }}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={readingForm.value}
                  onChange={(e) => setReadingForm({ ...readingForm, value: e.target.value })}
                />
                {/* §3 — the goal's own unit, as text. The member never types it. */}
                {editing.goal.target_unit && <span style={styles.unit}>{editing.goal.target_unit}</span>}
              </div>
            </label>
            <label style={styles.field}>
              <span style={styles.label}>{t('goals.field_reading_date')}</span>
              <input
                style={styles.control}
                type="date"
                value={readingForm.recorded_at}
                onChange={(e) => setReadingForm({ ...readingForm, recorded_at: e.target.value })}
              />
            </label>
          </div>

          {formError && <p style={styles.error}>{formError}</p>}
        </MemberDialog>
      )}

      {/* §11 — the confirmation a destructive action gets everywhere else in
          the app, in the app's own dialog rather than a second overlay style. */}
      {editing && editing.kind === 'remove' && (
        <MemberDialog
          labelledBy="goal-remove-title"
          title={t('goals.remove_title')}
          onClose={saving ? () => {} : closeEditing}
          actions={(
            <>
              <button type="button" style={styles.dialogSecondary} onClick={closeEditing} disabled={saving}>
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
  title:      { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  h2:         { margin: '0 0 10px', fontSize: 13, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font, textTransform: 'uppercase', letterSpacing: '0.05em' },
  section:    { marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  card:       { ...sectionCardStyle, padding: '14px 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  pastCard:   { opacity: 0.85 },
  pastHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  goalName:   { margin: 0, fontSize: 16, fontWeight: 700, color: memberTheme.text },
  goalTarget: { margin: '4px 0 0', fontSize: 14, color: memberTheme.textSecondary },
  goalNotes:  { margin: '6px 0 0', fontSize: 12, color: memberTheme.textMuted, fontStyle: 'italic' },
  goalDates:  { margin: '6px 0 0', fontSize: 12, color: memberTheme.textMuted },
  primaryBtn: { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600 },
  primarySmallBtn: { ...primaryButtonStyle, padding: '8px 16px', fontSize: 13, fontWeight: 600 },
  readingInputRow: { display: 'flex', alignItems: 'center', gap: 8 },
  unit:       { fontSize: 13, color: memberTheme.textMuted, flexShrink: 0 },
  secondaryBtn: { ...secondaryButtonStyle, padding: '8px 16px', fontSize: 13, fontWeight: 600 },
  dialogPrimary: { ...primaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  dialogSecondary: { ...secondaryButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  dialogDestructive: { ...destructiveButtonStyle, padding: '10px 18px', fontSize: 14, fontWeight: 600, flex: 1 },
  busy:       { opacity: 0.6, cursor: 'default' },
  field:      { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 0 },
  fieldRow:   { display: 'flex', gap: 12, flexWrap: 'wrap' },
  formBody:   { display: 'flex', flexDirection: 'column', gap: 12 },
  formActions:{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  label:      { fontSize: 12, fontWeight: 600, color: memberTheme.textSecondary },
  control:    { ...inputStyle, padding: '9px 10px', fontSize: 14, width: '100%', boxSizing: 'border-box' },
  readOnlyValue: { margin: 0, padding: '9px 0', fontSize: 14, color: memberTheme.text },
  help:       { fontSize: 12, color: memberTheme.textMuted },
  error:      { margin: 0, fontSize: 13, color: memberTheme.statusError },
  confirmText:{ margin: 0, fontSize: 14, color: memberTheme.textSecondary },
  emptyCard:  { ...sectionCardStyle, padding: '40px 24px', textAlign: 'center' },
  hint:       { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
