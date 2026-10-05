'use client';

import React from 'react';
import {
  ASSIGNED_GOAL_STATUSES, AssignedPersonalGoalFormValues,
} from './assignedPersonalGoalProfile';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, formHelpTextStyle, formValueStyle,
  inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { primaryBtnSmall } from '@/components/ui';

export interface GoalOption {
  id: number;
  /** Already resolved for display — a System slug's locale key, else the stored name. */
  name: string;
  /** `null` = a System goal; the picker says so beside the name. */
  gym_id: string | null;
  /**
   * #1034 §1 — the catalogue's own target, so selecting a goal pre-fills what it
   * aims for. The server inherits the same pair for a request that names neither
   * (§7), so this is what keeps the form showing the values that will actually be
   * stored rather than a second rule.
   */
  target_value?: number | null;
  target_unit?: string | null;
}

export interface MemberOption { id: number; name: string }

/**
 * #948 §4 — the one inline form that assigns a Personal Goal to a member and edits
 * an assignment, rendered by **both** screens that administer them: the gym-wide
 * Assigned Personal Goals section and the Member card's PERSONAL GOALS section
 * (#806 — an entity administered from two pages has one editor).
 *
 * It is a form body and nothing else: it names no endpoint, reads no permission
 * and holds no save state. The page owns the request, the `canWrite` gate, the
 * error sentence and whether the form is offered at all — which is what lets the
 * Member card put it behind its Edit mode (#957) while the gym-wide page offers it
 * from `+ Assign Personal Goal` and `⋮ → Edit`.
 *
 * Two things it deliberately does not do. On **edit** it renders the member and
 * the goal as *values*, never as controls: the router refuses to move either, and
 * a form must not offer a control its `PUT` would ignore (#974). And the `members`
 * picker is absent when the surface already knows whose goals these are — a Member
 * card section with a member dropdown could assign a goal to somebody else from
 * inside another member's card.
 */
export function AssignedPersonalGoalForm({
  mode, form, goals, members, memberName, goalName, error, saving,
  label, onChange, onCancel, onSave, saveLabel,
}: {
  mode: 'create' | 'edit';
  form: AssignedPersonalGoalFormValues;
  /** The catalogue the create picker offers — System goals and the gym's own. */
  goals: GoalOption[];
  /** Omitted when the member is fixed (the Member card). */
  members?: MemberOption[];
  /** The row's member and goal, for the read-only context rows in edit mode. */
  memberName?: string;
  goalName?: string;
  /** Already-resolved sentence; the page decides the words (#901). */
  error: string | null;
  saving: boolean;
  label: (key: string) => string;
  onChange: (form: AssignedPersonalGoalFormValues) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel: string;
}) {
  const set = (patch: Partial<AssignedPersonalGoalFormValues>) => onChange({ ...form, ...patch });

  return (
    <div style={{ padding: '16px 20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {mode === 'create' ? (
          <>
            {members && (
              <Field label={`${label('label_member')} *`}>
                <select
                  value={form.member_id}
                  onChange={(e) => set({ member_id: e.target.value })}
                  style={formControlStyle}
                >
                  <option value="">{label('choose_member')}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={`${label('label_goal')} *`}>
              <select
                value={form.personal_goal_id}
                onChange={(e) => set(selectGoal(e.target.value, goals))}
                style={formControlStyle}
                autoFocus
              >
                <option value="">{label('choose_goal')}</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.gym_id === null ? `${g.name} (${label('ownership_system')})` : g.name}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            {/* Neither is editable: re-pointing an assignment is ending one and
                starting the next, so the `PUT` ignores both (#974's rule — a
                column this row freezes is a value in both modes). */}
            <Field label={label('label_member')}><span style={formValueStyle}>{memberName ?? '—'}</span></Field>
            <Field label={label('label_goal')}><span style={formValueStyle}>{goalName ?? '—'}</span></Field>
          </>
        )}

        <Field label={label('label_target_value')} help={label('help_target_value')}>
          <input
            type="number"
            min={0}
            step="0.01"
            value={form.target_value}
            onChange={(e) => set({ target_value: e.target.value })}
            style={formControlStyle}
          />
        </Field>
        <Field label={label('label_target_unit')}>
          <input
            value={form.target_unit}
            onChange={(e) => set({ target_unit: e.target.value })}
            placeholder={label('placeholder_target_unit')}
            maxLength={20}
            style={formControlStyle}
          />
        </Field>
        <Field label={label('label_start_date')}>
          <input
            type="date"
            value={form.start_date}
            onChange={(e) => set({ start_date: e.target.value })}
            style={formControlStyle}
          />
        </Field>
        <Field label={label('label_target_date')}>
          <input
            type="date"
            value={form.target_date}
            onChange={(e) => set({ target_date: e.target.value })}
            style={formControlStyle}
          />
        </Field>
        <Field label={label('label_status')}>
          <select
            value={form.status}
            onChange={(e) => set({ status: e.target.value as AssignedPersonalGoalFormValues['status'] })}
            style={formControlStyle}
          >
            {/* The set the API validates against, mirrored once
                (`assignedPersonalGoalProfile.ts`) rather than listed here. */}
            {ASSIGNED_GOAL_STATUSES.map((s) => (
              <option key={s} value={s}>{label(`status_${s}`)}</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ marginTop: 12 }}>
        <Field label={label('label_notes')}>
          <textarea
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
            rows={3}
            maxLength={1000}
            style={{ ...formControlStyle, resize: 'vertical' }}
          />
        </Field>
      </div>

      {error && <p style={formErrorStyle}>{error}</p>}

      <div style={inlineActionsRowStyle}>
        <button type="button" onClick={onCancel} disabled={saving} style={secondaryBtnSmall}>
          {label('cancel')}
        </button>
        <button type="button" onClick={onSave} disabled={saving} style={primaryBtnSmall()}>
          {saving ? label('saving') : saveLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * #1034 §5/§7 — picking a goal brings its target with it, so the form shows what
 * `POST /member-personal-goals` would store for a body that named neither (the
 * inheritance is the server's; this only keeps the two in step). Typing over it
 * is the per-member override §8 exists for, and clearing the goal again clears
 * the pair rather than leaving the previous goal's figures behind.
 */
function selectGoal(id: string, goals: GoalOption[]): Partial<AssignedPersonalGoalFormValues> {
  const goal = goals.find((g) => String(g.id) === id);
  return {
    personal_goal_id: id,
    target_value: goal?.target_value === null || goal?.target_value === undefined
      ? '' : String(goal.target_value),
    target_unit: goal?.target_unit ?? '',
  };
}

function Field({ label: fieldLabel, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={formFieldLabelStyle}>{fieldLabel}</label>
      {children}
      {/* A help sentence explains how to fill a field in, so it belongs to the
          form and never beside a read-only value (#797). */}
      {help && <span style={formHelpTextStyle}>{help}</span>}
    </div>
  );
}
