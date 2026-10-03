'use client';

import React from 'react';
import { useLocale } from 'next-intl';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { displayValue, formatTimestamp } from '@/components/nutritionLibrary/nutritionItemProfile';
import {
  ASSIGNED_PERSONAL_GOAL_AUDIT_ENTITY, AssignedPersonalGoalRow, formatGoalDate, formatTarget,
} from './assignedPersonalGoalProfile';

/**
 * #948 §4 — `⋮ → Details` for an Assigned Personal Goal: the member and the goal,
 * what was agreed, its progress, the notes, and the complete audit information
 * with the shared View Audit Log deep link (#675 — never a hand-rolled one).
 *
 * It renders the **list row** it was handed rather than a detail endpoint of its
 * own, which is the rule every Details view in the app follows (#799 §25) and why
 * the actor columns come back on the list row at all.
 */
export function AssignedPersonalGoalDetailsModal({ row, goalName, label, onClose }: {
  row: AssignedPersonalGoalRow;
  /** Resolved by the page, which owns the locale keys (#901). */
  goalName: string;
  label: (key: string) => string;
  onClose: () => void;
}) {
  const locale = useLocale();
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 20px' }}>{label('details')}</h2>

        <Field label={label('label_member')} value={row.member_name} />
        <Field label={label('label_goal')} value={goalName} />
        <Field
          label={label('ownership')}
          value={row.goal_gym_id === null ? label('ownership_system') : label('ownership_gym')}
        />
        <Field label={label('label_target')} value={formatTarget(row)} />
        <Field label={label('label_start_date')} value={formatGoalDate(row.start_date, locale)} />
        <Field label={label('label_target_date')} value={formatGoalDate(row.target_date, locale)} />
        <Field label={label('label_status')} value={label(`status_${row.status}`)} />
        <Field label={label('label_notes')} value={displayValue(row.notes)} wrap />

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid var(--card-border, #f0f0f0)' }}>
          <p style={sectionLabelStyle}>{label('section_audit')}</p>
          <Field label={label('created_at')} value={formatTimestamp(row.created_at)} />
          <Field label={label('created_by')} value={displayValue(row.created_by_name)} />
          <Field label={label('modified_at')} value={formatTimestamp(row.modified_at)} />
          <Field label={label('modified_by')} value={displayValue(row.modified_by_name)} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <ViewAuditLogButton
            entityType={ASSIGNED_PERSONAL_GOAL_AUDIT_ENTITY}
            entityId={row.id}
            onNavigate={onClose}
          />
          <button type="button" onClick={onClose} style={btnStyle('#444')}>{label('close')}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, wrap }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--card-border, #f5f5f5)' }}>
      <span style={{ width: 150, flexShrink: 0, fontSize: 13, color: 'var(--text-muted, #888)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--gd-text, #333)', ...(wrap ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } : {}) }}>
        {value}
      </span>
    </div>
  );
}

const sectionLabelStyle: React.CSSProperties = {
  margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted, #aaa)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
};
