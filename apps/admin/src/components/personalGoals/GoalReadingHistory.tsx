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
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useApiClient } from '@/lib/apiClient';
import { AddReadingModal } from './AddReadingModal';
import { ASSIGNED_PERSONAL_GOALS_ROOT } from './assignedPersonalGoalProfile';

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
 * #2181 reversed §34: when the host passes `assignmentId` + `onChanged`, each row
 * has a `⋮` with Edit (value only) and Delete (hard). It carries no colour, no radius and no
 * second accordion look — the caret is `formChrome`'s own expand affordance
 * (#929, the one an applied Promotion and an Assigned Plan already wear) and the
 * marker is the quiet `listNameBadgeStyle` pill every list puts beside a row's
 * name (#724), never a tone that would read as a status.
 *
 * It resolves no locale key: `label` is the page's resolver (#901).
 */
export function GoalReadingHistory({
  readings, unit, locale, label, initiallyOpen = false,
  assignmentId, goalName = '', canWrite = false, readOnlyTitle, onChanged,
}: {
  readings: GoalReadingRow[];
  /** #2181 — with these, each row offers `⋮ → Edit reading / Delete reading`. */
  assignmentId?: number;
  goalName?: string;
  canWrite?: boolean;
  readOnlyTitle?: string;
  onChanged?: () => void | Promise<void>;
  unit: string | null;
  locale: string;
  label: (key: string) => string;
  /** Only the Add-reading flow opens it, so a new measurement is visible at once. */
  initiallyOpen?: boolean;
}) {
  const gymFmt = useGymFormatSettings();
  const [open, setOpen] = useState(initiallyOpen);
  const rows = readingHistoryRows(readings);
  const { apiFetch } = useApiClient();
  const manage = assignmentId !== undefined && !!onChanged && (canWrite || !!readOnlyTitle);
  const [editing, setEditing] = useState<GoalReadingRow | null>(null);
  const [deleting, setDeleting] = useState<(typeof rows)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!deleting || assignmentId === undefined) return;
    setBusy(true); setDeleteError(null);
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${assignmentId}/readings/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await onChanged?.();
    } catch (e: any) {
      setDeleteError(e.message ?? label('error_generic'));
    } finally { setBusy(false); }
  }

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
                  <span style={dateStyle}>{formatReadingTimestamp(reading.recorded_at, locale, gymFmt)}</span>
                  <span style={valueStyle}>{formatReadingValue(reading.value, unit)}</span>
                  <span style={markerCellStyle}>
                    {reading.marker && (
                      <span style={listNameBadgeStyle}>{label(READING_MARKER_KEYS[reading.marker])}</span>
                    )}
                  </span>
                  {manage && (
                    <ContextMenu
                      ariaLabel={label('reading_actions_aria')}
                      items={[
                        { label: label('edit_reading'), onClick: () => setEditing(reading), disabled: !canWrite, title: readOnlyTitle },
                        { label: label('delete_reading'), onClick: () => { setDeleteError(null); setDeleting(reading); }, disabled: !canWrite, title: readOnlyTitle, danger: true },
                      ]}
                    />
                  )}
                </li>
              ))}
            </ul>
          )
      )}

      {editing && assignmentId !== undefined && (
        <AddReadingModal
          assignmentId={assignmentId}
          kind="reading"
          goalName={goalName}
          unit={unit}
          label={label}
          editReading={{ id: editing.id, value: editing.value, recorded_at: editing.recorded_at }}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged?.(); }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          open
          message={label('delete_reading_confirm')}
          details={(
            <>
              {deleting.marker === 'initial' || deleting.is_initial
                ? <p style={{ margin: 0, fontSize: 14 }}>{label('delete_reading_confirm_initial')}</p>
                : null}
              {deleteError && <p style={{ margin: '8px 0 0', fontSize: 14 }}>{deleteError}</p>}
            </>
          )}
          busy={busy}
          confirmLabel={label('delete_reading')}
          cancelLabel={label('cancel')}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
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