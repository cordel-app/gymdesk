'use client';

import React from 'react';
import { CardSectionHeader } from '@/components/CardSectionHeader';
import {
  cardSectionDividedStyle,
  cardSectionStyle,
  formCheckboxLabelStyle,
  formControlStyle,
  formFieldLabelStyle,
  formValueStyle,
} from '@/components/formChrome';
import type {
  VisibleProductField,
  VisibleProductSection,
} from './productProfile';

/**
 * #974 — the one layout of a Product's card.
 *
 * Expanding the card reads and `⋮ → Edit` writes (#797), and until this
 * component the two drew the same five sections two different ways: the
 * read-only half was a 160px-label `Label: value` list that omitted Name, the
 * Edit half a two-column grid. Both now render *this* — the same sections in
 * the same order, the same field order, the same labels, the same full-width
 * free-text cells, at the same breakpoints — and the only thing that changes
 * between them is what sits inside a cell.
 *
 * Three properties are the rule rather than the implementation:
 *
 * * **The layout cannot make a read-only field editable.** It renders whatever
 *   `renderField` / `renderValue` hand it; it holds no state, no control and no
 *   knowledge of a Product.
 * * **A field this row freezes is a value in both modes** (`editable: false`,
 *   which `visibleProductSections()` decides). A System row's name, type
 *   and units are outside `PUT /sellable-items/:id`'s `is_system` guard, so the
 *   form has no business offering a control for them — and the read-only card
 *   still reports them.
 * * **A section's actions sit immediately after its title** (#963/#974 §4),
 *   because the header is the shared `CardSectionHeader`: the title is a child
 *   rather than a slot, so `[ ACTION ] SECTION TITLE` is unexpressible and the
 *   action can never be pushed to the far edge of the card.
 *
 * It resolves no locale key and decides no permission: `sectionTitle`,
 * `fieldLabel` and `sectionActions` are the page's, which is what keeps the
 * module's permission gate (`FINANCIALS`) out of the shared UI (#806).
 */
export function ProductLayout({
  sections,
  editing,
  sectionTitle,
  fieldLabel,
  renderField,
  renderValue,
  sectionActions,
}: {
  sections: readonly VisibleProductSection[];
  /** True while `⋮ → Edit` is open on this row. */
  editing: boolean;
  sectionTitle: (section: VisibleProductSection) => string;
  /** The field's label, already translated. The required marker is added here. */
  fieldLabel: (field: VisibleProductField) => string;
  /** The control under that label. Called only while editing an editable field. */
  renderField: (field: VisibleProductField) => React.ReactNode;
  /** The persisted value, in the box the control occupies. */
  renderValue: (field: VisibleProductField) => React.ReactNode;
  /** A section's contextual actions, beside its title. */
  sectionActions?: (section: VisibleProductSection) => React.ReactNode;
}) {
  return (
    <>
      {sections.map((section, index) => (
        <div key={section.key} style={index === 0 ? cardSectionStyle : cardSectionDividedStyle}>
          <CardSectionHeader title={sectionTitle(section)} actions={sectionActions?.(section)} />
          <div style={productGridStyle}>
            {section.fields.map((field) => (
              <div key={field.key} style={field.fullWidth ? fullWidthCellStyle : undefined}>
                {field.labelKey && (
                  <label style={formFieldLabelStyle}>
                    {fieldLabel(field)}
                    {editing && field.editable && field.required ? ' *' : ''}
                  </label>
                )}
                {editing && field.editable ? renderField(field) : renderValue(field)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * One column per ~240px of available width, so the card reflows the same way in
 * both modes and stays usable at phone width — the Edit form's fixed `1fr 1fr`
 * put two half-width controls on a 360px screen, and the read-only list had no
 * grid at all.
 */
export const productGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  columnGap: 16,
  rowGap: 14,
};

/** Free text — Description, Package information, Notes, the services chips. */
export const fullWidthCellStyle: React.CSSProperties = { gridColumn: '1 / -1' };

/**
 * A read-only value in the box its control occupies (#929): the same padding,
 * the same border width and the same type, so nothing moves sideways when Edit
 * opens, and free text keeps its line breaks instead of stretching the card.
 */
export const productValueStyle = formValueStyle;

/** A `<textarea>` in that same box: free text, and the only control that grows. */
export const productTextareaStyle: React.CSSProperties = {
  ...formControlStyle,
  resize: 'vertical',
};

/**
 * A boolean field's cell. The label above it names the field (`Mandatory`) in
 * both modes, so the control carries only the answer — and it occupies the
 * value's own box, which is what keeps the cell the same height either way.
 */
export const productCheckboxCellStyle: React.CSSProperties = {
  ...formCheckboxLabelStyle,
  padding: formValueStyle.padding,
  border: formValueStyle.border,
  minHeight: formValueStyle.minHeight,
};
