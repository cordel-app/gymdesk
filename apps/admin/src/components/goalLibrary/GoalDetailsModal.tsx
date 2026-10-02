'use client';

import React from 'react';
import { ViewAuditLogButton, AuditLogScope } from '@/components/ViewAuditLogButton';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { displayValue, formatTimestamp } from '@/components/nutritionLibrary/nutritionItemProfile';
import { GOAL_AUDIT_ENTITIES, GoalKind, GoalRow } from './goalProfile';

/**
 * #947 — `⋮ → Details` for a Personal Goal or a Nutrition Goal: the goal's name,
 * its description, whether it is a System or a Gym row, and its complete audit
 * information, plus the shared View Audit Log deep link (#675 — never a
 * hand-rolled one).
 *
 * It renders the list row it was handed rather than fetching a detail endpoint of
 * its own, which is the Foods library's rule (#799 §25) and why the audit columns
 * come back on the list row at all.
 *
 * Two values are legitimately empty rather than missing: a System goal read from a
 * gym has its actor names masked by the gym-facing list (they are Cordel
 * employees'), and a goal that was never deleted still shows both deletion rows,
 * with the em dash every other Details modal uses.
 *
 * One component serves both libraries; `scope` decides which Audit Log it opens
 * and the labels stay the page's, through the `label` resolver.
 */
export function GoalDetailsModal({ goal, kind, scope = 'gym', name, label, onClose }: {
  goal: GoalRow;
  kind: GoalKind;
  scope?: AuditLogScope;
  /** The goal's displayed name — resolved by the page, which owns the locale keys. */
  name: string;
  label: (key: string) => string;
  onClose: () => void;
}) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 20px' }}>{label('details')}</h2>

        <Field label={label('label_name')} value={displayValue(name)} />
        <Field label={label('label_description')} value={displayValue(goal.description)} wrap />
        <Field
          label={label('ownership')}
          value={goal.gym_id === null ? label('ownership_system') : label('ownership_gym')}
        />

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid var(--card-border, #f0f0f0)' }}>
          <p style={sectionLabelStyle}>{label('section_audit')}</p>
          <Field label={label('created_at')} value={formatTimestamp(goal.created_at)} />
          <Field label={label('created_by')} value={displayValue(goal.created_by_name)} />
          <Field label={label('modified_at')} value={formatTimestamp(goal.modified_at)} />
          <Field label={label('modified_by')} value={displayValue(goal.modified_by_name)} />
          <Field label={label('deleted_at')} value={formatTimestamp(goal.deleted_at)} />
          <Field label={label('deleted_by')} value={displayValue(goal.deleted_by_name)} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <ViewAuditLogButton
            entityType={GOAL_AUDIT_ENTITIES[kind]}
            entityId={goal.id}
            scope={scope}
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
