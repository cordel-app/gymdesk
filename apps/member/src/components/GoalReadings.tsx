'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import {
  memberTheme, rowDividerStyle, statusPillStyle,
} from '@/lib/memberChrome';
import {
  type GoalReading, READING_MARKER_KEYS, formatReadingDate, formatReadingValue,
  readingHistoryRows,
} from '@/lib/memberGoals';

/**
 * #1037 §5–§11 / §18–§20 — the two read-only halves of a goal card in the
 * Members App: its **structured header** and its **reading history**.
 *
 * ```text
 * GOAL          INITIAL READING   TARGET   LATEST READING   PROGRESS
 * Weight loss   80 kg             70 kg    75 kg            50%
 *
 * READING HISTORY (4)                                              ▾
 * 22 Sep 2026                                             75 kg
 * 01 Sep 2026                                             80 kg  Initial
 * ```
 *
 * Both live here rather than in the page for the reason `NutritionItemRow`
 * (#932) does: one place owns the look, so the two halves of a card cannot drift
 * apart, and the page keeps markup, state and requests. And like that row, this
 * file **resolves nothing** — every label arrives already translated and every
 * value already formatted by `lib/memberGoals.ts`, so neither half calls `t()`.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * * **No value is computed here.** The three reading figures are the server's,
 *   derived on every read, and a field that cannot be computed reads `—` rather
 *   than `0%` — no progress and no measurement are different facts.
 * * **It spells no colour.** Every surface, separator and type colour is
 *   `memberChrome.ts`'s (#983), so a gym's Theme moves this card like every
 *   other; the `Initial` marker borrows the app's own neutral status pill rather
 *   than inventing a tone, because where a member started is not a status.
 * * **The history is collapsed and append-only.** It is a log under a header
 *   that already reports what matters, so it must not push the rest of the page
 *   away; and it carries no edit and no delete affordance, because §34 has no
 *   route for either and an `✕` here would promise one.
 *
 * §41's reflow is the header's `auto-fit` grid: five fields become two columns on
 * a phone rather than five unreadable ones.
 */
export function GoalHeaderFields({ fields, trailing }: {
  /** Label and value, both already resolved and formatted, in §5's order. */
  fields: { key: string; label: string; value: string }[];
  trailing?: ReactNode;
}) {
  return (
    <div style={styles.headerRow}>
      <div style={styles.grid}>
        {fields.map((field) => (
          <div key={field.key} style={styles.field}>
            <span style={styles.fieldLabel}>{field.label}</span>
            <span style={styles.fieldValue}>{field.value}</span>
          </div>
        ))}
      </div>
      {trailing}
    </div>
  );
}

export function GoalReadingHistory({ readings, unit, locale, labels }: {
  readings: GoalReading[];
  unit: string | null;
  locale: string;
  labels: {
    title: string;
    empty: string;
    /** The two markers, keyed as `READING_MARKER_KEYS` names them. */
    markers: Record<string, string>;
  };
}) {
  const [open, setOpen] = useState(false);
  const rows = readingHistoryRows(readings);

  return (
    <div style={styles.history}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        style={styles.toggle}
      >
        <span style={styles.historyTitle}>
          {labels.title}{rows.length > 0 ? ` (${rows.length})` : ''}
        </span>
        <span style={styles.caret} aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (rows.length === 0
        ? <p style={styles.empty}>{labels.empty}</p>
        : (
          <ul style={styles.list}>
            {rows.map((reading) => (
              <li key={reading.id} style={styles.listRow}>
                <span style={styles.readingDate}>{formatReadingDate(reading.recorded_at, locale)}</span>
                <span style={styles.readingValue}>{formatReadingValue(reading.value, unit) ?? '—'}</span>
                {reading.marker && (
                  <span style={styles.marker}>{labels.markers[READING_MARKER_KEYS[reading.marker]]}</span>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  headerRow:    { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  // §41 — the five fields reflow instead of being squeezed into five columns.
  grid:         { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, flex: 1, minWidth: 0 },
  field:        { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  fieldLabel:   { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: memberTheme.textMuted },
  // §7 — the value is more prominent than its label.
  fieldValue:   { fontSize: 15, fontWeight: 600, color: memberTheme.text },
  history:      { marginTop: 14, paddingTop: 12, ...rowDividerStyle },
  toggle:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, textAlign: 'left', color: 'inherit', cursor: 'pointer', font: 'inherit' },
  historyTitle: { fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: memberTheme.textSecondary },
  caret:        { fontSize: 11, color: memberTheme.textMuted },
  list:         { listStyle: 'none', margin: '8px 0 0', padding: 0 },
  listRow:      { display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 13 },
  readingDate:  { flex: 1, minWidth: 0, color: memberTheme.textSecondary },
  readingValue: { fontWeight: 600, color: memberTheme.text },
  // The app's own neutral pill: where a member started is not a status, so it
  // takes no tone of its own (#983's one status-tone map stays for statuses).
  marker:       { ...statusPillStyle('neutral'), fontSize: 11 },
  empty:        { margin: '8px 0 0', fontSize: 13, color: memberTheme.textMuted },
};
