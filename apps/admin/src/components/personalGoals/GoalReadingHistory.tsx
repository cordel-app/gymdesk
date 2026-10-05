'use client';

import React, { useState } from 'react';
import {
  cardDetailRowStyle, cardExpandCaretStyle, cardExpandToggleStyle, cardMutedTextStyle,
  cardSectionLabelStyle, innerCardStyle,
} from '@/components/formChrome';
import { listNameBadgeStyle } from '@/components/listChrome';
import {
  GoalReadingRow, READING_MARKER_KEYS, formatReadingTimestamp, formatReadingValue,
  readingHistoryRows,
} from './goalReadings';

/**
 * #1037 §18–§20 — the **READING HISTORY** card: every measurement the assignment
 * holds, newest first, with the initial readings identified.
 *
 * ```text
 * READING HISTORY (4)                                   ▾
 *
 * 22 Sep 2026                        75 kg
 * 15 Sep 2026                        77 kg
 * 08 Sep 2026                        78 kg
 * 01 Sep 2026                        80 kg    Initial
 * ```
 *
 * Collapsible, and **collapsed is the resting state**: it is a log under a card
 * that already reports the three figures that matter (§5), so a goal with twenty
 * readings must not push everything below it off the screen. Expanding is
 * presentation and nothing else — it fetches nothing and recomputes nothing, the
 * rows being the ones the card already holds (#955's rule for the Billing Event
 * Simulation's own cards).
 *
 * Two things it deliberately does **not** have. There is no edit and no delete
 * affordance on a row: the history is append-only (§34), so an `✕` here would
 * promise something no route performs. And it carries no colour, no radius and no
 * second accordion look — the caret is `formChrome`'s own expand affordance
 * (#929, the one an applied Promotion and an Assigned Plan already wear) and the
 * marker is the quiet `listNameBadgeStyle` pill every list puts beside a row's
 * name (#724), never a tone that would read as a status.
 *
 * It resolves no locale key: `label` is the page's resolver (#901).
 */
export function GoalReadingHistory({ readings, unit, locale, label, initiallyOpen = false }: {
  readings: GoalReadingRow[];
  unit: string | null;
  locale: string;
  label: (key: string) => string;
  /** Only the Add-reading flow opens it, so a new measurement is visible at once. */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const rows = readingHistoryRows(readings);

  return (
    <div style={innerCardStyle}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        style={{ ...cardExpandToggleStyle, width: '100%' }}
      >
        <span style={cardSectionLabelStyle}>
          {label('section_reading_history')}{rows.length > 0 ? ` (${rows.length})` : ''}
        </span>
        <span style={cardExpandCaretStyle} aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        rows.length === 0
          ? <p style={cardMutedTextStyle}>{label('readings_empty')}</p>
          : (
            <ul style={listStyle}>
              {rows.map((reading) => (
                <li key={reading.id} style={cardDetailRowStyle}>
                  <span style={dateStyle}>{formatReadingTimestamp(reading.recorded_at, locale)}</span>
                  <span style={valueStyle}>{formatReadingValue(reading.value, unit)}</span>
                  <span style={markerCellStyle}>
                    {reading.marker && (
                      <span style={listNameBadgeStyle}>{label(READING_MARKER_KEYS[reading.marker])}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )
      )}
    </div>
  );
}

const listStyle: React.CSSProperties = {
  listStyle: 'none', margin: '6px 0 0', padding: 0,
};

const dateStyle: React.CSSProperties = { fontSize: 13, flex: 1, minWidth: 120 };
const valueStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600 };
/** Fixed so the markers line up under one another rather than per row. */
const markerCellStyle: React.CSSProperties = { minWidth: 120, textAlign: 'right' };
