'use client';

import React, { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { CrudModal } from '@/components/CrudModal';
import {
  formControlStyle, formFieldLabelStyle, formHelpTextStyle, formValueStyle,
} from '@/components/formChrome';
import { ASSIGNED_PERSONAL_GOALS_ROOT } from './assignedPersonalGoalProfile';
import {
  READING_ENDPOINTS, ReadingFormValues, ReadingKind, emptyReadingForm,
  readingFormError, toReadingPayload,
} from './goalReadings';

/**
 * #1037 §3 / §21 — the dialog that records a reading, and the same dialog that
 * moves the baseline.
 *
 * ```text
 * Add reading
 *
 * Reading            Date
 * [ 75 ] kg          [ 22/09/2026 ]
 *
 * [ Cancel ] [ Save ]
 * ```
 *
 * It is the Modal CRUD shape (`CrudModal`, so Cancel/Save wear the app's own
 * footer row and the dialog cannot grow a style of its own) because §3 asks for a
 * modal by name and because this is **not** an edit of the row it was launched
 * from — the same reasoning `AssignGoalToMemberModal` (#1034 §5) is built on,
 * while the assignment's own fields stay in the inline editor CLAUDE.md requires.
 *
 * Four of its answers are the rule rather than the implementation.
 *
 * * **The unit is the assignment's and is not a field** (§3: "the Member should
 *   not have to manually enter the unit"). It is rendered beside the input as
 *   text and never submitted, so a reading is always in the unit its target is
 *   quoted in.
 * * **A measurement and a baseline are two routes, not a checkbox.** `kind`
 *   picks which of stage 2's two writers is called; nothing in the payload says
 *   which, so no client can re-baseline a goal by passing a flag through, and the
 *   audit row says which happened.
 * * **The date defaults to today and cannot be in the future** (§32), checked
 *   here only to save a round trip — the server refuses it either way.
 * * **A failure keeps the dialog open with the input intact**, which is what §30
 *   needs: the member's number is still on screen, and the server's message
 *   (a refused value, a lost connection) is read beside it.
 *
 * It names the router root and nothing else about permissions: whether the action
 * is offered at all is the calling screen's decision (#806) — `⋮ → Add reading`
 * on the gym-wide list, and a button inside Edit mode on the Member card.
 */
export function AddReadingModal({ assignmentId, kind, goalName, unit, label, onClose, onSaved }: {
  assignmentId: number;
  kind: ReadingKind;
  /** Already resolved (#947), so the dialog says which goal it is about. */
  goalName: string;
  unit: string | null;
  /** Resolves a key in the calling page's own namespace (#901). */
  label: (key: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { apiFetch } = useApiClient();
  const [form, setForm] = useState<ReadingFormValues>(() => emptyReadingForm());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seeded when the action is launched again, so yesterday's half-typed
  // number never reappears on another goal's dialog.
  useEffect(() => { setForm(emptyReadingForm()); setError(null); }, [assignmentId, kind]);

  async function save() {
    const invalid = readingFormError(form);
    if (invalid) { setError(label(invalid)); return; }
    setSaving(true); setError(null);
    try {
      await apiFetch(`${ASSIGNED_PERSONAL_GOALS_ROOT}/${assignmentId}/${READING_ENDPOINTS[kind]}`, {
        method: 'POST',
        body: JSON.stringify(toReadingPayload(form)),
      });
      onSaved();
    } catch (e: any) {
      setError(e.message ?? label('error_generic'));
    } finally { setSaving(false); }
  }

  return (
    <CrudModal
      open
      title={label(kind === 'initial' ? 'set_initial_reading' : 'add_reading')}
      error={error}
      saving={saving}
      cancelLabel={label('cancel')}
      saveLabel={label('save')}
      onCancel={onClose}
      onSave={save}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={label('label_goal')}>
          <span style={formValueStyle}>{goalName}</span>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Field
            label={label('label_reading')}
            help={kind === 'initial' ? label('help_initial_reading') : undefined}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
                style={{ ...formControlStyle, flex: 1, minWidth: 0 }}
                autoFocus
              />
              {/* §3 — the assignment's own unit, as a value. Never an input. */}
              {unit && <span style={unitStyle}>{unit}</span>}
            </div>
          </Field>
          <Field label={label('label_reading_date')}>
            <input
              type="date"
              value={form.recorded_at}
              max={form.recorded_at > today() ? form.recorded_at : today()}
              onChange={(e) => setForm({ ...form, recorded_at: e.target.value })}
              style={formControlStyle}
            />
          </Field>
        </div>
      </div>
    </CrudModal>
  );
}

/**
 * `max` on the date input is today, so the picker itself cannot offer a future
 * day — while a value already in the field is still allowed through, because a
 * `max` below the current value makes some browsers refuse to render it at all
 * and `readingFormError()` is what actually decides (the server after it).
 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function Field({ label: fieldLabel, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={formFieldLabelStyle}>{fieldLabel}</label>
      {children}
      {help && <span style={formHelpTextStyle}>{help}</span>}
    </div>
  );
}

/**
 * The unit beside the input. It borrows the help sentence's own muted colour
 * rather than spelling one (#929): a unit is a note about the field, not a value
 * the gym's Theme should be able to move independently of the rest of the form.
 */
const unitStyle: React.CSSProperties = { ...formHelpTextStyle, margin: 0, flexShrink: 0 };
