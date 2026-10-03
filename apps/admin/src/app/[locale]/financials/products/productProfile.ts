/**
 * #974 — one definition of a Product's own fields, and of the sections
 * they sit in.
 *
 * The expanded card used to render the item as a dense `Label: value` list
 * while `⋮ → Edit` rendered a two-column form over the same five sections, so
 * the two halves agreed on the section names and on nothing else: the read-only
 * view omitted Name, laid its values out on a 160px label column the form has
 * no counterpart for, and showed the Professional Services as a comma-joined
 * sentence where the form shows chips. Every field added since had to be added
 * twice, in two shapes.
 *
 * So the field set, its order, its labels, its placement and which of its
 * fields a System row freezes live here, and both halves render them through
 * `ProductLayout` (#882's rule for the Member Profile, applied to this
 * card). What each half still owns is the *contents* of a cell — a control on
 * one side, the persisted value on the other — which is what the layout's
 * `renderField` / `renderValue` callbacks are for.
 *
 * It is a pure module: no JSX, no `t()`, no endpoint and no permission
 * decision. A label is a key in the `products` namespace and the page
 * resolves it.
 */

/**
 * The three closed option sets a Product's selects offer, beside the
 * field set that renders them: the create card, the inline editor and the
 * read-only card all take their options and their labels from here, so none of
 * them can offer a value the others do not know how to display. The accepted
 * sets themselves are the API's — `VALID_TYPES` in `api/src/api/products.ts`
 * and the `gym_charges_*_check` CHECKs beside it.
 *
 * The Billing Frequency is deliberately **not** here: it has two retired values
 * and one place that decides what may be offered (`productFrequency.ts`,
 * #821/#945).
 */
export const PRODUCT_TYPES = ['fee', 'service', 'sessions', 'merchandise', 'other'] as const;
export const PRODUCT_STATUSES = ['active', 'inactive'] as const;
export const PRODUCT_ENROLLMENT_STATUSES = ['public', 'staff_only'] as const;

export type ProductType = typeof PRODUCT_TYPES[number];
export type ProductStatus = typeof PRODUCT_STATUSES[number];
export type ProductEnrollmentStatus = typeof PRODUCT_ENROLLMENT_STATUSES[number];

/** The sections of the card, in the order both halves render them. */
export type ProductSectionKey =
  | 'general'
  | 'billing'
  | 'professional_services'
  | 'package_info'
  | 'notes';

export type ProductFieldKey =
  | 'name'
  | 'type'
  | 'description'
  | 'units'
  | 'status'
  | 'enrollment_status'
  | 'mandatory'
  | 'amount'
  | 'billing_frequency'
  | 'validity_days'
  | 'tax_rate_id'
  | 'professional_services'
  | 'package_information'
  | 'notes';

export interface ProductFieldSpec {
  key: ProductFieldKey;
  /**
   * How the field reads, inside the `products` namespace. Absent where
   * the section header already names it — a lone Notes textarea under a
   * `NOTES` heading needs no second label, and the Professional Services chips
   * need none either.
   */
  labelKey?: string;
  /**
   * The Edit form marks this field as required. It is the form's business and
   * not the value's — a `Name *` beside something nobody can change reads as a
   * demand rather than a label — so the layout appends the marker only while
   * the field is being edited, and no second locale key is needed for it.
   */
  required?: true;
  /** Free text that may wrap, so it spans the grid rather than squeezing a cell. */
  fullWidth?: boolean;
  /** A boolean column: a checkbox in the form, Yes/No as a value. */
  checkbox?: true;
  /**
   * A System row (`is_system = 1`) freezes this column — `PUT
   * /sellable-items/:id` writes name/type/units only inside its `is_system`
   * guard. The layout renders such a field as a **value in both modes**, so the
   * Edit form cannot grow a control the route would ignore, and the read-only
   * card keeps reporting it (it did before #974, and dropping it to keep the
   * two halves aligned would lose information).
   */
  frozenWhenSystem?: true;
  /**
   * Absent from a System row altogether, in both halves — the column exists but
   * means nothing for a row seeded from `charge_types`.
   */
  hiddenWhenSystem?: true;
}

export interface ProductSectionSpec {
  key: ProductSectionKey;
  /** The section heading, in the `products` namespace. */
  titleKey: string;
  fields: readonly ProductFieldSpec[];
  /** #546: Professional Services only apply to a Session-type item. */
  sessionOnly?: true;
  hiddenWhenSystem?: true;
}

/**
 * The card, declared once.
 *
 * The order is the Edit form's own, which is the structure #974 §1 asks the
 * read-only half to adopt. Free text spans the grid (`fullWidth`) rather than
 * sharing a row with a number input — #882's rule for the Member Profile's
 * Notes, for the same reason: a textarea in a half-width cell is unreadable in
 * the form and a wrapped paragraph stretches the card in the value.
 */
export const PRODUCT_SECTIONS: readonly ProductSectionSpec[] = [
  {
    key: 'general',
    titleKey: 'section_general',
    fields: [
      { key: 'name', labelKey: 'label_name', required: true, frozenWhenSystem: true },
      { key: 'type', labelKey: 'label_type', frozenWhenSystem: true },
      { key: 'description', labelKey: 'label_description', fullWidth: true },
      { key: 'units', labelKey: 'label_units', frozenWhenSystem: true },
      { key: 'status', labelKey: 'label_status' },
      { key: 'enrollment_status', labelKey: 'label_enrollment_status' },
      // #832: deliberately not frozen — a System item's Mandatory flag is
      // editable, which is why `PUT /:id` writes it outside the `is_system`
      // guard that still freezes the three fields above.
      { key: 'mandatory', labelKey: 'label_mandatory', checkbox: true },
    ],
  },
  {
    key: 'billing',
    titleKey: 'section_billing',
    fields: [
      { key: 'amount', labelKey: 'label_price' },
      { key: 'billing_frequency', labelKey: 'label_frequency' },
      { key: 'validity_days', labelKey: 'label_validity_days', hiddenWhenSystem: true },
      { key: 'tax_rate_id', labelKey: 'label_tax_rate' },
    ],
  },
  {
    key: 'professional_services',
    titleKey: 'section_professional_services',
    sessionOnly: true,
    fields: [{ key: 'professional_services', fullWidth: true }],
  },
  {
    key: 'package_info',
    titleKey: 'section_package_info',
    hiddenWhenSystem: true,
    fields: [{ key: 'package_information', fullWidth: true }],
  },
  {
    key: 'notes',
    titleKey: 'section_notes',
    fields: [{ key: 'notes', fullWidth: true }],
  },
];

/** The section order, for the test that pins it and for a reader of this file. */
export const PRODUCT_SECTION_ORDER: readonly ProductSectionKey[] =
  PRODUCT_SECTIONS.map((s) => s.key);

/** A field as the layout renders it: the spec, plus whether this row may edit it. */
export interface VisibleProductField extends ProductFieldSpec {
  /**
   * False for a column this row freezes, which is what makes the Edit form
   * render it as a value rather than remembering to skip it.
   */
  editable: boolean;
}

export interface VisibleProductSection extends ProductSectionSpec {
  fields: readonly VisibleProductField[];
}

/**
 * The sections this row shows, with the fields it shows in each.
 *
 * Called by **both** halves with the same two flags, so a section or a field
 * can never be present in one and missing from the other — which is the whole
 * of #974 §1/§3. A section left with no visible field is dropped rather than
 * rendered as an empty heading.
 */
export function visibleProductSections(
  { isSystem, isSessionType }: { isSystem: boolean; isSessionType: boolean },
): readonly VisibleProductSection[] {
  return PRODUCT_SECTIONS
    .filter((section) => !(section.sessionOnly && !isSessionType))
    .filter((section) => !(section.hiddenWhenSystem && isSystem))
    .map((section) => ({
      ...section,
      fields: section.fields
        .filter((field) => !(field.hiddenWhenSystem && isSystem))
        .map((field) => ({ ...field, editable: !(isSystem && field.frozenWhenSystem) })),
    }))
    .filter((section) => section.fields.length > 0);
}

/** How an unset value reads. One spelling, so no cell invents its own. */
export const EMPTY_VALUE = '—';

/** The persisted columns the form reads and writes back. */
export interface ProductFormRow {
  name: string;
  type: ProductType;
  units: number | null;
  description: string | null;
  amount: string | null;
  billing_frequency: string | null;
  status: ProductStatus;
  enrollment_status: ProductEnrollmentStatus;
  notes: string | null;
  package_information: string | null;
  validity_days: number | null;
  tax_rate_id: number | null;
  mandatory: number;
  professional_services?: { id: number }[];
}

/** The Edit form's values, keyed the way the controls bind to them. */
export interface ProductFormValues {
  name: string;
  type: ProductType;
  units: string;
  description: string;
  amount: string;
  billing_frequency: string;
  status: ProductStatus;
  enrollment_status: ProductEnrollmentStatus;
  notes: string;
  package_information: string;
  validity_days: string;
  tax_rate_id: string;
  mandatory: boolean;
  professionalServiceIds: number[];
}

/**
 * The persisted row → form values mapping, beside the field set it fills, so a
 * field added above cannot be left out of the form the context menu opens
 * (#800).
 */
export function toProductFormValues(item: ProductFormRow): ProductFormValues {
  return {
    name: item.name,
    type: item.type,
    units: item.units != null ? String(item.units) : '',
    description: item.description ?? '',
    amount: item.amount != null ? parseFloat(item.amount).toString() : '',
    billing_frequency: item.billing_frequency ?? '',
    status: item.status,
    enrollment_status: item.enrollment_status,
    notes: item.notes ?? '',
    package_information: item.package_information ?? '',
    validity_days: item.validity_days != null ? String(item.validity_days) : '',
    tax_rate_id: item.tax_rate_id != null ? String(item.tax_rate_id) : '',
    mandatory: Boolean(item.mandatory),
    professionalServiceIds: item.professional_services?.map((s) => s.id) ?? [],
  };
}
