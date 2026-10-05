'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { CrudModal } from '@/components/CrudModal';
import {
  formControlStyle, formFieldLabelStyle, formHelpTextStyle, formValueStyle,
} from '@/components/formChrome';
import { GoalRow, formatGoalTarget } from '@/components/goalLibrary/goalProfile';
import {
  ASSIGNED_PERSONAL_GOALS_ROOT, AssignedPersonalGoalFormValues,
  assignedPersonalGoalFormError, emptyAssignedPersonalGoalForm,
  toAssignedPersonalGoalCreatePayload,
} from './assignedPersonalGoalProfile';
import { MemberOption } from './AssignedPersonalGoalForm';

/**
 * #1034 §5/§6 — `⋮ → Assign goal to member` on a Personal Goal: the modal that
 * creates one assignment of **this** goal.
 *
 * It is deliberately the Modal CRUD shape (`CrudModal`, so Cancel/Accept wear the
 * app's own footer row and the dialog cannot grow a style of its own, §14) even
 * though the two screens that *administer* assignments use the inline form —
 * because this is not an edit of the row being expanded. It is an action launched
 * from another entity's list, and the ticket asks for a dialog by name.
 *
 * It submits through the **same** declaration the inline form does
 * (`toAssignedPersonalGoalCreatePayload`, `assignedPersonalGoalFormError`), so
 * the narrower set of fields here is a narrower *view* of one create form rather
 * than a second one: the dates, the progress status and the notes stay at their
 * create defaults, which is exactly what `POST /member-personal-goals` would
 * store for a body that omitted them.
 *
 * Three of its answers are the ticket's rather than this file's:
 *
 * * **The goal is preselected and is not a control** (§5): it is the row the
 *   action was launched from, so it reads as a value — "the user should not need
 *   to search for the goal again", and a picker here would be a second way to
 *   choose one.
 * * **Target is pre-filled from the Gym Goal and is editable** (§5/§8): the
 *   number staff see is what the catalogue currently says, and changing it is how
 *   one goal is assigned to three members with three targets.
 * * **Unit is editable too**, which is §5's own instruction — "if the existing
 *   business rules allow changing the unit when assigning the goal, follow those
 *   rules". They do: `member_personal_goals.target_unit` has been a free-text
 *   column staff may set since migration 212, and the assignment editor beside
 *   this one already offers it. Making it read-only here would be a new rule.
 */
export function AssignGoalToMemberModal({ goal, goalName, label, onClose, onAssigned }: {
  goal: GoalRow;
  /** Already resolved — a System slug's locale key, else the stored name (#947). */
  goalName: string;
  /** Resolves a key in the calling page's own namespace (#901). */
  label: (key: string) => string;
  onClose: () => void;
  onAssigned: () => void;
}) {
  const { apiFetch } = useApiClient();
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [form, setForm] = useState<AssignedPersonalGoalFormValues>(() => seedForm(goal));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seeded whenever the action is launched from another row, so the target
  // shown is always the Gym Goal this dialog names (§5) and never the last one.
  useEffect(() => { setForm(seedForm(goal)); setError(null); }, [goal]);

  useEffect(() => {
    apiFetch<MemberOption[]>('/members').then(setMembers).catch(() => {});
  }, [apiFetch]);

  const catalogueTarget = useMemo(() => formatGoalTarget(goal), [goal]);

  async function save() {
    const invalid = assignedPersonalGoalFormError(form);
    if (invalid) { setError(label(invalid)); return; }
    setSaving(true); setError(null);
    try {
      await apiFetch(ASSIGNED_PERSONAL_GOALS_ROOT, {
        method: 'POST',
        body: JSON.stringify(toAssignedPersonalGoalCreatePayload(form)),
      });
      onAssigned();
    } catch (e: any) {
      // The dialog stays open with the user's input intact (§6: "if validation
      // fails, keep the modal open and display the appropriate validation
      // errors") — which covers the server's 409 for a goal this member already
      // holds just as much as a 400.
      setError(e.message ?? label('error_generic'));
    } finally { setSaving(false); }
  }

  return (
    <CrudModal
      open
      title={label('assign_to_member')}
      error={error}
      saving={saving}
      cancelLabel={label('cancel')}
      saveLabel={label('accept')}
      onCancel={onClose}
      onSave={save}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label={label('label_goal')}>
          <span style={formValueStyle}>{goalName}</span>
        </Field>

        {/* §5 — "display the current Gym Goal target". It is its own value row
            rather than a sentence under the input, so the figure staff are
            departing from stays legible beside the one they type, and the help
            key below needs no interpolation (next-intl has no `defaultValue`, and
            a composed sentence is a sentence a translator cannot reorder). */}
        <Field label={label('label_gym_goal_target')}>
          <span style={formValueStyle}>{catalogueTarget}</span>
        </Field>

        <Field label={`${label('label_member')} *`}>
          <select
            value={form.member_id}
            onChange={(e) => setForm({ ...form, member_id: e.target.value })}
            style={formControlStyle}
            autoFocus
          >
            <option value="">{label('choose_member')}</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <Field label={label('label_target_value')} help={label('help_assign_target')}>
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.target_value}
              onChange={(e) => setForm({ ...form, target_value: e.target.value })}
              style={formControlStyle}
            />
          </Field>
          <Field label={label('label_target_unit')}>
            <input
              value={form.target_unit}
              onChange={(e) => setForm({ ...form, target_unit: e.target.value })}
              placeholder={label('placeholder_target_unit')}
              maxLength={20}
              style={formControlStyle}
            />
          </Field>
        </div>
      </div>
    </CrudModal>
  );
}

/**
 * The create form, pre-filled from the Gym Goal — which is what makes the
 * assignment the **snapshot** §7 asks for: the values submitted are the
 * catalogue's as it stands at this moment, and editing them before Accept is the
 * per-member override of §8. The server takes the same snapshot for a body that
 * omits them, so the two agree whichever way the request is made.
 */
function seedForm(goal: GoalRow): AssignedPersonalGoalFormValues {
  return {
    ...emptyAssignedPersonalGoalForm(),
    personal_goal_id: String(goal.id),
    target_value: goal.target_value === null || goal.target_value === undefined
      ? '' : String(goal.target_value),
    target_unit: goal.target_unit ?? '',
  };
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
