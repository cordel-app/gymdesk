/**
 * #797 — one definition of the Member Profile fields.
 *
 * The expanded Member row shows the Profile read-only and `⋮ → Edit` edits it;
 * both are driven from the list below, so a field cannot be added to one and
 * forgotten in the other.
 *
 * #882 — and both render it through the same layout, `MemberProfileLayout`:
 * the field set, its order, its labels, its placeholders and its help text all
 * live here, so the two halves cannot be laid out differently either. What each
 * half still owns is the cell's contents — an `<input>` on one side, the
 * persisted value on the other.
 */
export type MemberProfileFieldKey =
  | 'name'
  | 'phone'
  | 'date_of_birth'
  | 'gender'
  | 'address'
  | 'emergency_contact'
  | 'nif_nie_passport'
  | 'notes'
  | 'new_member';

/**
 * #927 — a Profile field the system calculates. It is part of the Profile's one
 * field set (so both halves place it identically) but it is not part of the
 * Member's editable columns: it has no form value, it is never submitted, and
 * the layout renders it through its own callback so the Edit form cannot grow
 * an input for it. Declared as a union of its own rather than a boolean flag on
 * the spec alone, so the types below can subtract it.
 */
export type MemberCalculatedFieldKey = 'new_member';

export type MemberEditableFieldKey = Exclude<MemberProfileFieldKey, MemberCalculatedFieldKey>;

export interface MemberProfileFieldSpec {
  key: MemberProfileFieldKey;
  /** How the field reads when it is not being edited, inside the `members` namespace. */
  labelKey: string;
  /**
   * How the same field is labelled in the Edit form. It is not always `labelKey`:
   * the form marks required fields (`label_name` is "Name *"), which would be
   * nonsense next to a value you cannot change.
   */
  editLabelKey: string;
  /** How the value reads: a date-only column, or free text that may wrap. */
  kind?: 'date' | 'multiline';
  /** Edit-form only: the input's placeholder. */
  placeholderKey?: string;
  /**
   * Edit-form only: the sentence under the input. #882 §3 — it explains how to
   * fill the field in, so it is never shown beside a value you cannot change.
   */
  helpKey?: string;
  /**
   * #927 §4 — the system calculates this field and nobody may change it. The
   * layout renders it through `renderCalculated` in *both* modes, so the Edit
   * form never sees it and the read-only view and the form show one value.
   */
  calculated?: true;
}

export const MEMBER_PROFILE_FIELDS: readonly MemberProfileFieldSpec[] = [
  { key: 'name', labelKey: 'col_name', editLabelKey: 'label_name' },
  { key: 'phone', labelKey: 'label_phone', editLabelKey: 'label_phone', placeholderKey: 'placeholder_phone' },
  { key: 'date_of_birth', labelKey: 'label_date_of_birth', editLabelKey: 'label_date_of_birth', kind: 'date' },
  { key: 'gender', labelKey: 'label_gender', editLabelKey: 'label_gender' },
  { key: 'address', labelKey: 'label_address', editLabelKey: 'label_address', placeholderKey: 'placeholder_address' },
  {
    key: 'emergency_contact',
    labelKey: 'label_emergency_contact',
    editLabelKey: 'label_emergency_contact',
    placeholderKey: 'placeholder_emergency_contact',
  },
  {
    key: 'nif_nie_passport',
    labelKey: 'label_document',
    editLabelKey: 'label_document',
    placeholderKey: 'placeholder_document',
    helpKey: 'help_document',
  },
  {
    key: 'notes',
    labelKey: 'label_notes',
    editLabelKey: 'label_notes',
    kind: 'multiline',
    placeholderKey: 'placeholder_notes',
  },
  // #927 §1 — last in the Profile, as the ticket's layout shows it. One label
  // for both modes: the Edit form marks what it requires, and a value nobody
  // can supply is neither required nor optional.
  {
    key: 'new_member',
    labelKey: 'label_new_member',
    editLabelKey: 'label_new_member',
    calculated: true,
  },
];

/**
 * A spec the Edit form may render a control for. Narrowing the key is what lets
 * both halves index the Member (and the form values) by it: a calculated field
 * has no column and no form value, and it never reaches `renderField`.
 */
export interface MemberEditableFieldSpec extends MemberProfileFieldSpec {
  key: MemberEditableFieldKey;
}

/** The Profile's editable fields — everything the Edit form submits. */
export const MEMBER_EDITABLE_PROFILE_FIELDS: readonly MemberEditableFieldSpec[] =
  MEMBER_PROFILE_FIELDS.filter((f) => !f.calculated) as MemberEditableFieldSpec[];

/**
 * The persisted Profile, exactly as `GET /members` and `GET /members/:id` return
 * it. `name` is the one NOT NULL column of the set; every other field is
 * optional and may come back null.
 */
export type MemberProfile =
  { [K in Exclude<MemberEditableFieldKey, 'name'>]: string | null }
  & { name: string }
  /**
   * #927 — calculated by the server on every read (`GET /members`,
   * `GET /members/:id`) from the Member's Membership history, so the Members
   * list, the Profile and the Promotion apply paths all answer with one rule.
   * There is no column and nothing to submit.
   */
  & { is_new_member: boolean };

/**
 * The same fields as form state: every value is a string, never null — and only
 * the editable ones, so a calculated field cannot be typed into or submitted.
 */
export type MemberEditFormValues = Record<MemberEditableFieldKey, string>;

export const emptyMemberEditForm: MemberEditFormValues = Object.fromEntries(
  MEMBER_EDITABLE_PROFILE_FIELDS.map((f) => [f.key, '']),
) as MemberEditFormValues;

/**
 * The persisted Member → the Edit form's values. `date_of_birth` comes back as a
 * full timestamp but `<input type="date">` only accepts `YYYY-MM-DD`.
 */
export function toMemberEditFormValues(member: MemberProfile): MemberEditFormValues {
  return {
    ...emptyMemberEditForm,
    ...(Object.fromEntries(
      MEMBER_EDITABLE_PROFILE_FIELDS.map((f) => {
        const key = f.key as MemberEditableFieldKey;
        return [key, f.kind === 'date' ? dateInputValue(member[key]) : member[key] ?? ''];
      }),
    ) as MemberEditFormValues),
  };
}

/** `2026-09-26T00:00:00.000Z` → `2026-09-26`; anything empty stays empty. */
export function dateInputValue(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '';
}

/**
 * A date-only column rendered for reading. Parsed field by field rather than
 * through `new Date(iso)`, which reads `1990-05-04` as UTC midnight and then
 * prints the 3rd of May for anyone west of Greenwich — wrong for a birth date.
 */
export function formatProfileDate(value: string | null | undefined): string | null {
  const dateOnly = dateInputValue(value);
  if (!dateOnly) return null;
  const [y, m, d] = dateOnly.split('-').map(Number);
  if (!y || !m || !d) return dateOnly;
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * #927 §1/§3 — the `New Member` status as a value beside the Profile's other
 * values, never as a control: there is nothing a staff member could tick it to.
 *
 * #960 — and that value is a compact `Yes` / `No` chip on the label's own line
 * rather than the ticked box #927 drew, which cost the Profile a whole row of
 * height for one boolean. Both keys are resolved here so neither half of the
 * card picks its own wording: `newMemberValueKey()` is what the chip reads, and
 * `newMemberAnnounceKey()` is the sentence a screen reader hears instead of a
 * bare "Yes" — the label beside the chip is not programmatically tied to it.
 */
export function newMemberValueKey(isNewMember: boolean): 'yes' | 'no' {
  return isNewMember ? 'yes' : 'no';
}

export function newMemberAnnounceKey(isNewMember: boolean): 'new_member_yes' | 'new_member_no' {
  return isNewMember ? 'new_member_yes' : 'new_member_no';
}
