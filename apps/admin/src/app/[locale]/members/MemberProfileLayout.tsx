'use client';

import React from 'react';
import { MEMBER_PROFILE_FIELDS, type MemberProfileFieldSpec } from './memberProfile';

/**
 * #882 — the one layout of the Member Profile.
 *
 * The expanded Member row used to render the Profile as a compact
 * `Label: value` list while `⋮ → Edit` rendered a different, better-structured
 * grid, so switching between reading and editing moved every field on screen.
 * Both halves now render *this*: the same grid, the same field order, the same
 * labels, the same full-width Notes and the same Assigned Centers / Default
 * Center placement, at the same breakpoints.
 *
 * What the two halves still own is the contents of each cell — an `<input>` on
 * one side, the persisted value on the other — which is what `renderField` and
 * the `centers` block are for. The layout itself holds no state, no control and
 * no knowledge of a Member: it cannot make a read-only Profile editable, and it
 * cannot make the Edit form read a second copy of the row.
 */
export function MemberProfileLayout({
  fieldLabel,
  renderField,
  centers,
}: {
  /** The label for a field in this mode (the Edit form marks required ones). */
  fieldLabel: (field: MemberProfileFieldSpec) => string;
  /** The cell under that label: an input, or the persisted value. */
  renderField: (field: MemberProfileFieldSpec) => React.ReactNode;
  /**
   * Assigned Centers and Default Center, in the one position both modes place
   * them. `null` where the gym has a single center and the page hides them.
   */
  centers: {
    assignedLabel: string;
    assigned: React.ReactNode;
    defaultLabel: string;
    default: React.ReactNode;
  } | null;
}) {
  return (
    <>
      <div style={profileGridStyle}>
        {MEMBER_PROFILE_FIELDS.map((field) => (
          <div key={field.key} style={field.kind === 'multiline' ? fullWidthCellStyle : undefined}>
            <label style={profileFieldLabelStyle}>{fieldLabel(field)}</label>
            {renderField(field)}
          </div>
        ))}
      </div>

      {centers && (
        <div style={{ marginTop: 14 }}>
          <label style={profileFieldLabelStyle}>{centers.assignedLabel}</label>
          {centers.assigned}

          <label style={profileFieldLabelStyle}>{centers.defaultLabel}</label>
          {centers.default}
        </div>
      )}
    </>
  );
}

/**
 * One column per ~200px of available width, so the Profile reflows the same way
 * in both modes (#882 §9) — never a second set of breakpoints for reading.
 */
export const profileGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 12,
};

/** Notes: free text of any length, so it spans the grid in both modes (§4). */
export const fullWidthCellStyle: React.CSSProperties = { gridColumn: '1 / -1' };

export const profileFieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  fontWeight: 600,
  color: '#555',
  marginBottom: 4,
  marginTop: 10,
};

/**
 * A value in read-only mode. It occupies the same box the input does, so a
 * field does not move when Edit opens; Notes keeps the author's line breaks and
 * wraps instead of stretching the card sideways.
 */
export const profileValueStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 0',
  fontSize: 14,
  color: '#222',
  minHeight: 20,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};
