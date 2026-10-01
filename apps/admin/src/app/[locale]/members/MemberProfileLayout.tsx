'use client';

import React from 'react';
import { formFieldLabelStyle, formValueStyle } from '@/components/formChrome';
import {
  MEMBER_PROFILE_FIELDS,
  newMemberCheckbox,
  type MemberEditableFieldSpec,
  type MemberProfileFieldSpec,
} from './memberProfile';

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
 *
 * #927 — a field the system calculates (`New Member`) is part of this one
 * field set, so both modes place it in the same cell; its contents come from
 * `renderCalculated` rather than `renderField`, which is what makes it
 * read-only by construction rather than by the Edit form remembering to skip
 * it.
 *
 * #929 — and the label and the value box are the app's own
 * (`components/formChrome.ts`), so a field sits at the same inset in both
 * modes: the read-only value used to be flush with the label while the input
 * under the same label was inset by 10px, which moved every value sideways as
 * Edit opened. The row rhythm is the grid's `rowGap` alone, so the fields of a
 * row share one baseline instead of each label adding a margin of its own.
 */
export function MemberProfileLayout({
  fieldLabel,
  renderField,
  renderCalculated,
  centers,
}: {
  /** The label for a field in this mode (the Edit form marks required ones). */
  fieldLabel: (field: MemberProfileFieldSpec) => string;
  /** The cell under that label: an input, or the persisted value. */
  renderField: (field: MemberEditableFieldSpec) => React.ReactNode;
  /**
   * #927 — the cell of a field the system calculates (`calculated: true`). It
   * is called in both modes and `renderField` is not, so a calculated field is
   * laid out with the rest of the Profile while the Edit form has no way to
   * put a control under its label.
   */
  renderCalculated: (field: MemberProfileFieldSpec) => React.ReactNode;
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
            {field.calculated ? renderCalculated(field) : renderField(field as MemberEditableFieldSpec)}
          </div>
        ))}
      </div>

      {centers && (
        <div style={{ ...profileGridStyle, marginTop: PROFILE_ROW_GAP }}>
          <div>
            <label style={profileFieldLabelStyle}>{centers.assignedLabel}</label>
            {centers.assigned}
          </div>
          <div>
            <label style={profileFieldLabelStyle}>{centers.defaultLabel}</label>
            {centers.default}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * #927 §5 — the `New Member` cell, rendered by both modes from one place so the
 * read-only Profile and the Edit form cannot draw the same calculated value two
 * ways. It is a value, not a control: there is no `<input type="checkbox">` to
 * tick, because there is nothing a staff member could tick it to.
 *
 * The glyph carries the meaning, so it is announced by `aria-label` rather than
 * left to a screen reader to read out as "ballot box".
 */
export function NewMemberValue({ isNewMember, label }: { isNewMember: boolean; label: string }) {
  return (
    <p style={profileValueStyle}>
      <span role="img" aria-label={label}>{newMemberCheckbox(isNewMember)}</span>
    </p>
  );
}

/** The vertical rhythm of the Profile: one gap, between rows and before the centers. */
export const PROFILE_ROW_GAP = 14;

/**
 * One column per ~200px of available width, so the Profile reflows the same way
 * in both modes (#882 §9) — never a second set of breakpoints for reading.
 */
export const profileGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  columnGap: 16,
  rowGap: PROFILE_ROW_GAP,
};

/** Notes: free text of any length, so it spans the grid in both modes (§4). */
export const fullWidthCellStyle: React.CSSProperties = { gridColumn: '1 / -1' };

/** The app's field label (#929), re-exported so neither half restates it. */
export const profileFieldLabelStyle = formFieldLabelStyle;

/**
 * A value in read-only mode. It occupies the same box the input does — same
 * padding, same border width, same type — so a field does not move when Edit
 * opens; Notes keeps the author's line breaks and wraps instead of stretching
 * the card sideways.
 */
export const profileValueStyle = formValueStyle;
