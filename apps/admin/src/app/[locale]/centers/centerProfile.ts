/**
 * #800 — the single declaration of the Center field set.
 *
 * Editing a Center used to open the **Edit Center** modal. It is now an inline
 * form inside the Center's own expanded row, reached only through `⋮ → Edit`,
 * which puts Centers on the #797/#798 pattern: expanding a card *reads*, the
 * context menu *writes*, and both halves render the same persisted columns.
 *
 * So the field list, its order, the read-only labels, the formatting and the
 * persisted-row → form-values mapping live here once. A field added to
 * `CENTER_PROFILE_SECTIONS` reaches the read-only view; the Edit form keeps
 * rendering its own inputs over the same keys, because each control needs its
 * own type, options and validation.
 *
 * #3342: the read-only view shows **exactly** the fields the Edit form does, in
 * the same sections and layout, so every field here is editable. `code` (which
 * no control edits; `toCenterUpdatePayload()` carries it through untouched) and
 * `created_by` moved to the Details modal. The translatable `description` is the
 * one full-width multiline field; the read-only view shows it in the request
 * locale (`display_description`), the form edits the base text plus its
 * translations (`description_translations`, the globe button).
 */

/** The persisted `centers` columns the Edit form manages. */
export interface CenterProfile {
  name: string;
  /** #3342: the base-locale description (the fallback). */
  description: string | null;
  /** #3342: `{ locale: description }` for the non-base locales. */
  description_translations?: Record<string, string>;
  email: string | null;
  phone: string | null;
  address: string | null;
  status: 'active' | 'inactive';
  theme_id: string | null;
}

/** Everything the expanded card renders — the editable columns plus the two it only reads. */
export interface CenterDisplayRow extends CenterProfile {
  code: string | null;
  /** Resolved name of `theme_id`; `null` when the Center inherits the gym's theme. */
  theme_name: string | null;
  /** The gym-level theme a Center with no `theme_id` of its own inherits. */
  gym_theme_name: string | null;
  created_by: string | null;
  /** #3342: the description in the request locale, else the base one. */
  display_description?: string | null;
}

export type CenterFieldKey = keyof CenterDisplayRow;

/** How a value is rendered read-only. The Edit form's control is its own concern. */
export type CenterFieldFormat = 'text' | 'multiline' | 'status' | 'theme';

export interface CenterProfileField {
  key: CenterFieldKey;
  /** Key in the admin `centers` translation namespace. */
  labelKey: string;
  format: CenterFieldFormat;
  /** `false` for a column the card shows but no control writes. */
  editable: boolean;
  /** Spans the whole row in both halves (#3342: the description). */
  fullWidth?: boolean;
}

export interface CenterProfileSection {
  /** Key in the admin `centers` translation namespace. */
  titleKey: string;
  fields: CenterProfileField[];
}

/**
 * Sections in the order both halves render them: Name → Description → Email →
 * Phone → Address → Status → Theme, then the Media section (#3342).
 */
export const CENTER_PROFILE_SECTIONS: CenterProfileSection[] = [
  {
    titleKey: 'section_general',
    fields: [
      { key: 'name', labelKey: 'col_name', format: 'text', editable: true },
      { key: 'description', labelKey: 'label_description', format: 'multiline', editable: true, fullWidth: true },
    ],
  },
  {
    titleKey: 'section_contact',
    fields: [
      { key: 'email', labelKey: 'label_email', format: 'text', editable: true },
      { key: 'phone', labelKey: 'label_phone', format: 'text', editable: true },
      { key: 'address', labelKey: 'label_address', format: 'text', editable: true },
    ],
  },
  {
    titleKey: 'section_settings',
    fields: [
      { key: 'status', labelKey: 'col_status', format: 'status', editable: true },
      { key: 'theme_id', labelKey: 'label_theme', format: 'theme', editable: true },
    ],
  },
];

export const CENTER_PROFILE_FIELDS: CenterProfileField[] = CENTER_PROFILE_SECTIONS.flatMap((s) => s.fields);

/** The fields the inline Edit form renders a control for, in the ticket's order. */
export const CENTER_EDITABLE_FIELDS: CenterProfileField[] = CENTER_PROFILE_FIELDS.filter((f) => f.editable);

/** The admin empty-value convention — never `null`, never `undefined`. */
export const EMPTY_VALUE = '—';

export const CENTER_STATUSES = ['active', 'inactive'] as const;
export type CenterStatus = (typeof CENTER_STATUSES)[number];

/**
 * The Theme column reads as the Center's own theme, or the gym's theme marked
 * as inherited — the same rule the Details modal has always used, so the two
 * cannot drift. `inheritedSuffix` is `t('theme_inherited_suffix')`.
 */
export function formatCenterTheme(
  row: Pick<CenterDisplayRow, 'theme_id' | 'theme_name' | 'gym_theme_name'>,
  inheritedSuffix: string,
): string {
  if (row.theme_id && row.theme_name) return row.theme_name;
  return `${row.gym_theme_name ?? EMPTY_VALUE} ${inheritedSuffix}`;
}

/**
 * The read-only rendering of one field. `translateStatus` is the page's
 * `useTranslations('status')` and `inheritedSuffix` its
 * `t('theme_inherited_suffix')`, so the read-only Status and Theme read as the
 * labels the Edit form's two selects show. Returns `EMPTY_VALUE` for anything
 * missing — the convention this view must never break.
 */
export function formatCenterField(
  row: Partial<CenterDisplayRow>,
  field: CenterProfileField,
  translateStatus: (key: string) => string,
  inheritedSuffix: string,
): string {
  if (field.format === 'theme') {
    return formatCenterTheme(
      { theme_id: row.theme_id ?? null, theme_name: row.theme_name ?? null, gym_theme_name: row.gym_theme_name ?? null },
      inheritedSuffix,
    );
  }
  // #3342: the description reads in the request locale, falling back to the base text.
  const raw = field.key === 'description' ? (row.display_description ?? row.description) : row[field.key];
  if (raw === null || raw === undefined || raw === '') return EMPTY_VALUE;
  if (field.format === 'status') return translateStatus(String(raw));
  return String(raw);
}

/** The inline form's values. Every control is controlled, so no value is ever null. */
export interface CenterEditFormValues {
  name: string;
  description: string;
  description_translations: Record<string, string>;
  code: string;
  address: string;
  phone: string;
  email: string;
  status: CenterStatus;
  theme_id: string;
}

/**
 * The persisted row → inline form values. `⋮ → Edit` seeds the form with this
 * and nothing else, so the form and the read-only view can only ever show the
 * same data. `code` is seeded and submitted back unchanged; see the module
 * comment.
 */
export function toCenterEditFormValues(row: CenterProfile & { code?: string | null }): CenterEditFormValues {
  return {
    name: row.name,
    description: row.description ?? '',
    description_translations: { ...(row.description_translations ?? {}) },
    code: row.code ?? '',
    address: row.address ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    status: row.status,
    theme_id: row.theme_id ?? '',
  };
}

/**
 * The `PUT /centers/:id` body, byte for byte what the Edit Center modal sent:
 * trimmed, and an emptied field cleared to `null` rather than stored as `''`.
 * #800 changes where the form is rendered, never what it submits.
 */
export function toCenterUpdatePayload(values: CenterEditFormValues) {
  return {
    name: values.name.trim(),
    description: values.description.trim() || null,
    // Replace-all: a blank locale drops its row (#3342).
    description_translations: Object.fromEntries(
      Object.entries(values.description_translations)
        .map(([locale, text]) => [locale, (text ?? '').trim()] as const)
        .filter(([, text]) => text.length > 0),
    ),
    code: values.code.trim() || null,
    address: values.address.trim() || null,
    phone: values.phone.trim() || null,
    email: values.email.trim() || null,
    status: values.status,
    theme_id: values.theme_id || null,
  };
}

/** The one validation rule the modal applied client-side: a Center must keep a name. */
export function isCenterFormValid(values: CenterEditFormValues): boolean {
  return values.name.trim().length > 0;
}
