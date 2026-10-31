'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { MemberDialog } from '@/components/MemberDialog';
import { MemberGoalCard } from '@/components/MemberGoalCard';
import { GoalHeaderFields, GoalReadingHistory } from '@/components/GoalReadings';
import { GoalReadingChart } from '@/components/GoalReadingChart';
import {
  inputStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionCardStyle,
} from '@/lib/memberChrome';
import {
  GOAL_HEADER_FIELDS,
  GoalReadingsResponse,
  MemberGoal,
  GoalReading,
  READING_ENDPOINTS,
  READING_MARKER_KEYS,
  ReadingFormValues,
  ReadingKind,
  emptyReadingForm,
  formatProgressPercent,
  formatReadingValue,
  readingFormError,
  toReadingPayload,
  formatGoalTarget,
  goalDisplayName,
  goalSummaryLine,
} from '@/lib/memberGoals';

/**
 * #1036 — **My Goals**, as #1115's cards, redesigned by #1826.
 *
 * The member's own Personal Goals. Each live goal is a self-contained **card**,
 * collapsed by default: the goal's picture on the left, its name, target and
 * progress on the right, the goal's own **Add reading** action in the card
 * (collapsed or expanded) and, when expanded, the progress content under the
 * summary at the card's full width. There is no global *Add personal goal*
 * button and no contextual menu: a goal is assigned by the gym, and the one
 * thing a member does here is record readings against it.
 *
 * Every decision — the label a goal is shown under, what its target reads as,
 * which list a row belongs in — is `lib/memberGoals.ts`'s, every colour,
 * surface and button is `lib/memberChrome.ts`'s (#983), and the card's own shape
 * is `components/MemberGoalCard.tsx`'s. This file is markup, state and requests.
 */

interface GoalsResponse { goals: MemberGoal[]; past_goals: MemberGoal[] }

type Editing =
  // #1037 §3/§21 — a measurement and a new baseline. Two routes, never one with
  // a flag: nothing the browser submits says which, so a member cannot
  // re-baseline a goal by passing a field through. #1826: it is opened from the
  // card of the goal it belongs to.
  | { kind: 'reading'; goal: MemberGoal; reading: ReadingKind; edit?: GoalReading }
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
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
  // #2181 — the reading a member is about to delete.
  const [deleting, setDeleting] = useState<{ goal: MemberGoal; reading: GoalReading } | null>(null);
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
    const mine = await apiFetch<GoalsResponse>('/me/personal-goals');
    setGoals(mine.goals ?? []);
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

  /** #2181 — edit a reading's value (the date is kept). */
  function openEditReading(goal: MemberGoal, reading: GoalReading) {
    setReadingForm({
      value: reading.value === null ? '' : String(reading.value),
      recorded_at: reading.recorded_at ? reading.recorded_at.slice(0, 10) : emptyReadingForm().recorded_at,
    });
    setFormError(null);
    setNotice(null);
    setEditing({ kind: 'reading', goal, reading: 'reading', edit: reading });
  }

  async function confirmDeleteReading() {
    if (!deleting) return;
    setSaving(true);
    setFormError(null);
    try {
      await apiFetch(`/me/personal-goals/${deleting.goal.id}/readings/${deleting.reading.id}`, { method: 'DELETE' });
      await load();
      setDeleting(null);
      setNotice(t('goals.reading_deleted'));
    } catch (err: any) {
      setFormError(err?.message ?? t('goals.error'));
    } finally {
      setSaving(false);
    }
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
  async function submitReading(goal: MemberGoal, kind: ReadingKind, edit?: GoalReading) {
    const invalid = readingFormError(readingForm);
    if (invalid) { setFormError(t(invalid as any)); return; }
    setSaving(true);
    setFormError(null);
    try {
      if (edit) {
        await apiFetch(`/me/personal-goals/${goal.id}/readings/${edit.id}`, {
          method: 'PUT',
          body: JSON.stringify({ value: toReadingPayload(readingForm).value }),
        });
      } else {
        await apiFetch(`/me/personal-goals/${goal.id}/${READING_ENDPOINTS[kind]}`, {
          method: 'POST',
          body: JSON.stringify(toReadingPayload(readingForm)),
        });
      }
      await load();
      setEditing(null);
      setNotice(t(edit ? 'goals.reading_updated' : kind === 'initial' ? 'goals.initial_reading_saved' : 'goals.reading_added'));
    } catch (err: any) {
      // The dialog stays open with the number intact, so the server's message is
      // read beside the field that caused it.
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

  /**
   * #1826 — the card's own action. It sits in the card, collapsed or expanded,
   * and opens the existing reading dialog for **this** goal, so the member never
   * picks the goal again and the reading is saved against `goal.id`.
   */
  function cardActions(goal: MemberGoal) {
    return (
      <button type="button" style={styles.primarySmallBtn} onClick={() => openReading(goal, 'reading')}>
        {t('goals.add_reading')}
      </button>
    );
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

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('goals.loading')}</p></main>;
  }

  if (error) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{error}</p></main>;
  }

  return (
    <main style={styles.container}>

      {notice && <p style={{ ...noticeStyle('success'), marginBottom: 14 }}>{notice}</p>}

      {goals.length === 0 ? (
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎯</div>
          <p style={styles.hint}>{t('goals.empty')}</p>
        </div>
      ) : (
        <>
          <section style={styles.section}>
            {goals.map((goal) => (
              <MemberGoalCard
                key={goal.id}
                title={nameOf(goal)}
                summary={cardSummary(goal)}
                expanded={Boolean(expanded[goal.id])}
                onToggle={() => toggleCard(goal.id)}
                actions={cardActions(goal)}
                imageUrl={goal.goal_image_thumbnail_url ?? goal.goal_image_url ?? null}
                imageAlt={t('nutrition.food_image_alt', { name: nameOf(goal) })}
                imageFallback={t('nutrition.no_image')}
                previewUrl={goal.goal_image_url ?? null}
                imageDescription={goal.goal_description ?? null}
              >
                {/* §5 — the five structured fields, not a pipe-separated line.
                    The goal's name is one of them rather than a heading above
                    them, so it is not rendered twice. */}
                <GoalHeaderFields fields={headerFields(goal)} />
                {goal.notes && <p style={styles.goalNotes}>{goal.notes}</p>}
                {/* §12 — chart, then history: the chart is what the member
                    reads at a glance, the history is the log under it. #1826 —
                    the chart takes the card's full width, under the summary. */}
                <GoalReadingChart
                  readings={readings[goal.id]?.readings ?? []}
                  unit={goal.target_unit}
                  target={goal.effective_target ?? goal.target_value}
                  labels={chartLabels(goal)}
                />
                {/* §18 — collapsed until the member asks. */}
                <GoalReadingHistory
                  readings={readings[goal.id]?.readings ?? []}
                  unit={goal.target_unit}
                  labels={historyLabels}
                  actions={{
                    editLabel: t('goals.edit_reading'),
                    deleteLabel: t('goals.delete_reading'),
                    onEdit: (reading) => openEditReading(goal, reading),
                    onDelete: (reading) => { setFormError(null); setDeleting({ goal, reading }); },
                  }}
                />
              </MemberGoalCard>
            ))}
          </section>
        </>
      )}

      {/* #1710 — past goals (removed, achieved, abandoned) are deliberately not
          shown in the Members App. The API still returns `past_goals`; this is
          a UI-only decision. */}

      {/* §3 / §21 — Add reading, and the same dialog for a new baseline. The
          unit is the goal's and is shown beside the input rather than asked
          for, and the date defaults to today and cannot be in the future.
          It stays a dialog: it is not a form over the goal's own fields, and
          #1115 §2/§3 is about creating and editing a goal. */}
      {editing && editing.kind === 'reading' && (
        <MemberDialog
          labelledBy="goal-reading-title"
          title={t(editing.edit ? 'goals.edit_reading' : editing.reading === 'initial' ? 'goals.set_initial_reading' : 'goals.add_reading')}
          onClose={saving ? () => {} : closeEditing}
          actions={(
            <>
              <button type="button" style={styles.dialogSecondary} onClick={closeEditing} disabled={saving}>
                {t('goals.cancel')}
              </button>
              <button
                type="button"
                style={styles.dialogPrimary}
                onClick={() => submitReading(editing.goal, editing.reading, editing.edit)}
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

          {editing.edit && <p style={styles.help}>{t('goals.help_edit_reading')}</p>}
          {editing.reading === 'initial' && !editing.edit && (
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
                disabled={!!editing.edit}
                onChange={(e) => setReadingForm({ ...readingForm, recorded_at: e.target.value })}
              />
            </label>
          </div>

          {formError && <p style={styles.error}>{formError}</p>}
        </MemberDialog>
      )}

      {deleting && (
        <MemberDialog
          labelledBy="goal-reading-delete-title"
          title={t('goals.delete_reading')}
          onClose={saving ? () => {} : () => setDeleting(null)}
          actions={(
            <>
              <button type="button" style={styles.dialogSecondary} onClick={() => setDeleting(null)} disabled={saving}>
                {t('goals.cancel')}
              </button>
              <button type="button" style={styles.dialogPrimary} onClick={confirmDeleteReading} disabled={saving}>
                {saving ? t('goals.saving') : t('goals.delete_reading')}
              </button>
            </>
          )}
        >
          <p style={styles.readOnlyValue}>{t('goals.delete_reading_confirm')}</p>
          {deleting.reading.is_initial && <p style={styles.help}>{t('goals.delete_reading_confirm_initial')}</p>}
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
  card:       { ...sectionCardStyle, padding: '14px 18px' },
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
