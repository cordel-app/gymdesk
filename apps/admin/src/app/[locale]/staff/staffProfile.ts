/**
 * #798 — the single declaration of the Staff field set.
 *
 * The expanded Staff card is a strictly read-only view of the Staff record and
 * `⋮ → Edit` is the only way into the form. Both render the same persisted
 * columns, so the field list, their labels, their formatting and the
 * persisted-row → form-values mapping are declared here once: a field added to
 * `STAFF_PROFILE_SECTIONS` reaches the read-only view, and the Edit form keeps
 * rendering its own inputs (each needs its own type, placeholder and
 * validation) over the same keys.
 *
 * The field set is deliberately *exactly* what the Edit form manages — the
 * ticket's "do not invent a new field list". `direct_manager_id` and the
 * `created_at`/`updated_at` audit columns are persisted and returned by
 * `GET /staff` but no control edits them, so they are not part of this set
 * (the Details modal is where the audit columns are shown).
 *
 * Centers and App access are not columns of `staff`: they come from
 * `staff_centers` (`GET /staff/:id/centers`) and the login behind
 * `staff.gym_membership_id` (`GET /staff/:id/clerk-status`), and the page
 * renders them as their own sections below these.
 */

/** The persisted `staff` columns the Edit form manages. */
export interface StaffProfile {
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone: string | null;
  date_of_birth: string | null;
  national_id: string | null;
  company_email: string | null;
  company_phone: string | null;
  personal_phone: string | null;
  emergency_contact: string | null;
  emergency_phone: string | null;
  profile: string;
  employment_status: 'active' | 'inactive';
  current_status: string;
  hire_date: string;
  contract_end_date: string | null;
  termination_date: string | null;
  employee_number: string | null;
  working_days: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  break_duration_minutes: number | null;
  notes: string | null;
}

export type StaffProfileKey = keyof StaffProfile;

/** How a value is rendered read-only. The Edit form's input type is its own concern. */
export type StaffFieldFormat =
  | 'text'
  | 'multiline'
  | 'date'
  | 'time'
  | 'number'
  | 'working_days'
  | 'employment_status'
  | 'current_status';

export interface StaffProfileField {
  key: StaffProfileKey;
  /** Key in the admin `staff` translation namespace. */
  labelKey: string;
  format: StaffFieldFormat;
}

export interface StaffProfileSection {
  /** Key in the admin `staff` translation namespace. */
  titleKey: string;
  /** `grid` is the form's own auto-fill grid; `stack` is one full-width column. */
  layout: 'grid' | 'stack';
  fields: StaffProfileField[];
}

/** Sections in the order the Edit form renders them. */
export const STAFF_PROFILE_SECTIONS: StaffProfileSection[] = [
  {
    titleKey: 'subsection_personal',
    layout: 'grid',
    fields: [
      { key: 'first_name', labelKey: 'label_first_name', format: 'text' },
      { key: 'last_name', labelKey: 'label_last_name', format: 'text' },
      { key: 'email', labelKey: 'label_email', format: 'text' },
      { key: 'mobile_phone', labelKey: 'label_mobile_phone', format: 'text' },
      { key: 'date_of_birth', labelKey: 'label_date_of_birth', format: 'date' },
      { key: 'national_id', labelKey: 'label_national_id', format: 'text' },
    ],
  },
  {
    titleKey: 'subsection_contact',
    layout: 'grid',
    fields: [
      { key: 'company_email', labelKey: 'label_company_email', format: 'text' },
      { key: 'company_phone', labelKey: 'label_company_phone', format: 'text' },
      { key: 'personal_phone', labelKey: 'label_personal_phone', format: 'text' },
      { key: 'emergency_contact', labelKey: 'label_emergency_contact', format: 'text' },
      { key: 'emergency_phone', labelKey: 'label_emergency_phone', format: 'text' },
    ],
  },
  {
    titleKey: 'section_employment',
    layout: 'grid',
    fields: [
      { key: 'profile', labelKey: 'label_profile', format: 'text' },
      { key: 'employment_status', labelKey: 'label_employment_status', format: 'employment_status' },
      { key: 'current_status', labelKey: 'label_current_status', format: 'current_status' },
      { key: 'hire_date', labelKey: 'label_hire_date', format: 'date' },
      { key: 'contract_end_date', labelKey: 'label_contract_end_date', format: 'date' },
      { key: 'termination_date', labelKey: 'label_termination_date', format: 'date' },
      { key: 'employee_number', labelKey: 'label_employee_number', format: 'text' },
    ],
  },
  {
    titleKey: 'section_schedule',
    layout: 'grid',
    fields: [
      { key: 'working_days', labelKey: 'label_working_days', format: 'working_days' },
      { key: 'work_start_time', labelKey: 'label_work_start_time', format: 'time' },
      { key: 'work_end_time', labelKey: 'label_work_end_time', format: 'time' },
      { key: 'break_duration_minutes', labelKey: 'label_break_duration', format: 'number' },
    ],
  },
  {
    titleKey: 'section_notes',
    layout: 'stack',
    fields: [{ key: 'notes', labelKey: 'label_notes', format: 'multiline' }],
  },
];

export const STAFF_PROFILE_FIELDS: StaffProfileField[] = STAFF_PROFILE_SECTIONS.flatMap((s) => s.fields);

/** The admin empty-value convention — never `null`, never `undefined`. */
export const EMPTY_VALUE = '—';

/** `YYYY-MM-DD`, from either a date string or an ISO timestamp. */
function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * A birth date is a calendar date, not an instant: `new Date('1990-05-04')` is
 * UTC midnight and prints as *3 May* for anyone west of Greenwich. Build the
 * Date from the parts so the day cannot shift.
 */
export function formatProfileDate(value: string | null | undefined): string | null {
  const text = dateOnly(value);
  if (!text) return null;
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** MySQL TIME comes back as `HH:MM:SS`; the seconds are never meaningful here. */
export function formatProfileTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value));
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/** `working_days` is a comma-joined subset of Mon..Sun, stored in the order it was clicked. */
export function formatWorkingDays(value: string | null | undefined): string | null {
  if (!value) return null;
  const days = String(value).split(',').map((d) => d.trim()).filter(Boolean);
  return days.length > 0 ? days.join(', ') : null;
}

/**
 * The read-only rendering of one field. `translate` is the page's
 * `useTranslations('staff')`, so the two status columns read as the same
 * labels the Edit form's selects show. Returns `EMPTY_VALUE` for anything
 * missing — the convention this view must never break.
 */
export function formatStaffField(
  row: Partial<StaffProfile>,
  field: StaffProfileField,
  translate: (key: string) => string,
): string {
  const raw = row[field.key];
  if (raw === null || raw === undefined || raw === '') return EMPTY_VALUE;
  switch (field.format) {
    case 'date':
      return formatProfileDate(raw as string) ?? EMPTY_VALUE;
    case 'time':
      return formatProfileTime(raw as string) ?? EMPTY_VALUE;
    case 'working_days':
      return formatWorkingDays(raw as string) ?? EMPTY_VALUE;
    case 'employment_status':
      return translate(`employment_status_${raw}`);
    case 'current_status':
      return translate(`current_status_${raw}`);
    case 'number':
      return String(raw);
    default:
      return String(raw);
  }
}

/**
 * The persisted row → Edit form values. `⋮ → Edit` seeds the form with this
 * and nothing else, so the form and the read-only view can only ever show the
 * same data: the four date columns are narrowed to `YYYY-MM-DD` for
 * `<input type="date">`, everything else is carried through untouched.
 */
export function toStaffEditFormValues<T extends StaffProfile>(row: T): T {
  return {
    ...row,
    date_of_birth: dateOnly(row.date_of_birth),
    hire_date: dateOnly(row.hire_date) ?? '',
    contract_end_date: dateOnly(row.contract_end_date),
    termination_date: dateOnly(row.termination_date),
  };
}
