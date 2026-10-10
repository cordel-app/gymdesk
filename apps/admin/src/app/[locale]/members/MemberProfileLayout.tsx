'use client';

import React from 'react';
import { formFieldLabelStyle, formValueStyle } from '@/components/formChrome';
import { listNameBadgeAccentStyle, listNameBadgeStyle } from '@/components/listChrome';
import {
  MEMBER_PROFILE_FIELDS,
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
  image,
  fieldLabel,
  renderField,
  renderCalculated,
  centers,
}: {
  /**
   * #1374 — the Member's profile image, above the fields in both modes: the
   * read-only half hands in the picture, the Edit form the upload control, and
   * the layout places both in the one cell so switching modes moves nothing.
   * `null` where a surface has no image to show.
   */
  image: { label: string; content: React.ReactNode } | null;
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
      {image && (
        <div style={{ marginBottom: PROFILE_ROW_GAP }}>
          <label style={profileFieldLabelStyle}>{image.label}</label>
          {image.content}
        </div>
      )}
      <div style={profileGridStyle}>
        {MEMBER_PROFILE_FIELDS.map((field) => (
          <div key={field.key} style={field.kind === 'multiline' ? fullWidthCellStyle : undefined}>
            {/* #960 — a calculated field is one word of output, so its label and
                its value share a row: stacking them cost the Profile the full
                height of a value box for a boolean. An editable field keeps the
                stacked label-above-control shape, because that is the box its
                `<input>` occupies in the other mode (#929). */}
            {field.calculated ? (
              <div style={profileInlineCellStyle}>
                <label style={profileInlineFieldLabelStyle}>{fieldLabel(field)}</label>
                {renderCalculated(field)}
              </div>
            ) : (
              <>
                <label style={profileFieldLabelStyle}>{fieldLabel(field)}</label>
                {renderField(field as MemberEditableFieldSpec)}
              </>
            )}
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
 * #960 — and the value is a compact `Yes` / `No` chip beside the label rather
 * than a ticked box on a row of its own. The chip wears the list's own pill
 * (#724/#913) and declares no colour: `Yes` takes the accent voice the Members
 * list already gives a new member's name, so the badge in the row above and the
 * value in the Profile below read as the same statement, and `No` takes the
 * neutral one. `announce` is what a screen reader hears — "New Member: yes"
 * rather than a bare "Yes", since the label beside the chip is not tied to it.
 * It keeps #927's `role="img"`, because an `aria-label` on a bare `<span>` is
 * not reliably exposed — with the role, the sentence replaces the chip's word.
 */
export function NewMemberValue({
  isNewMember, label, announce,
}: { isNewMember: boolean; label: string; announce: string }) {
  return (
    <span style={newMemberChipStyle(isNewMember)} role="img" aria-label={announce}>{label}</span>
  );
}

/**
 * The chip's look, borrowed whole from the list's metadata pill so nothing here
 * declares a size, a radius or a colour. The pill carries a left margin for the
 * name cell it was written for; the inline row supplies its own gap instead.
 */
export function newMemberChipStyle(isNewMember: boolean): React.CSSProperties {
  return { ...(isNewMember ? listNameBadgeAccentStyle : listNameBadgeStyle), marginLeft: 0 };
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

/**
 * #960 — a calculated field's row: the label and its chip on one line, centred
 * on each other. The label keeps the Profile's own type and weight and loses
 * only the margin that separates a stacked label from the control under it.
 */
export const profileInlineCellStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  minHeight: 20,
};

export const profileInlineFieldLabelStyle: React.CSSProperties = {
  ...formFieldLabelStyle,
  display: 'inline',
  marginBottom: 0,
};
