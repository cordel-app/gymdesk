import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_VALUE,
  STAFF_PROFILE_FIELDS,
  STAFF_PROFILE_SECTIONS,
  formatProfileDate,
  formatProfileTime,
  formatStaffField,
  formatWorkingDays,
  toStaffEditFormValues,
} from '@/app/[locale]/staff/staffProfile';

// #798 — expanding a Staff card shows the complete Staff record, strictly
// read-only, and `⋮ → Edit` is the only way into the form.
//
// apps/admin has no component-test infra (docs/architecture.md TL;DR), so the
// structural half of this is pinned by scanning the page source the way
// promotions-section-editing.test.ts does; the shared field definition and its
// formatters are pure, so they are exercised directly.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const STAFF_DIR = join(__dirname, '..', 'app', '[locale]', 'staff');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const rawPageSrc = readFileSync(join(STAFF_DIR, 'page.tsx'), 'utf-8');
const pageSrc = stripComments(rawPageSrc);

function staffNamespace(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.staff ?? {}) as Record<string, string>;
}

const locales = Object.fromEntries(LOCALE_CODES.map((c) => [c, staffNamespace(c)]));

/** The source between two markers, comments stripped. */
function slice(from: string, to: string): string {
  const start = pageSrc.indexOf(from);
  const end = pageSrc.indexOf(to, start + from.length);
  expect(start, `marker not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `marker not found after ${from}: ${to}`).toBeGreaterThan(start);
  return pageSrc.slice(start, end);
}

/** Everything that renders the expanded (read-only) card. */
const readOnlySrc = slice('function ReadRow(', 'function renderInlineEditor()');

describe('Staff: read-only expanded card (#798)', () => {
  describe('expanding and editing are separate interactions', () => {
    it("tracks the read-only expansion and the form separately, and 'new' is only ever the form", () => {
      expect(pageSrc).toContain('const [expandedId, setExpandedId] = useState<number | null>(null)');
      expect(pageSrc).toContain("const [editingId, setEditingId] = useState<number | 'new' | null>(null)");
      // The old single piece of state is what made expanding == editing: the
      // read-only expansion must never carry the form's 'new' sentinel again.
      expect(pageSrc).not.toContain("setExpandedId('new')");
      expect(pageSrc).not.toContain("expandedId === 'new'");
      expect(pageSrc).not.toContain("expandedId !== 'new'");
      expect(pageSrc).toContain("editingId === 'new'");
    });

    it('expands without seeding the form — expanding cannot start an edit', () => {
      const openExpand = slice('function openExpand(', 'function startEdit(');
      expect(openExpand).not.toContain('setForm(');
      expect(openExpand).toContain('setEditingId(null)');
    });

    it('seeds the form only from startEdit, through the shared mapping', () => {
      const startEdit = slice('function startEdit(', 'function cancelEdit()');
      expect(startEdit).toContain('setForm(toStaffEditFormValues(member))');
      expect(startEdit).toContain('setExpandedId(null)');
    });

    it('renders the editor only for the card being edited', () => {
      expect(pageSrc).toContain('const isEditing = editingId === member.id');
      expect(pageSrc).toContain(
        '{isEditing ? renderInlineEditor() : isExpanded ? renderReadOnlyProfile(member) : null}',
      );
    });

    it('does not toggle the read-only view from the header while the card is being edited', () => {
      expect(pageSrc).toContain('onClick={() => { if (!isEditing) openExpand(member); }}');
    });
  });

  describe('the expanded content is strictly read-only', () => {
    it.each(['<input', '<select', '<textarea', '<button', 'onChange', 'onClick', 'type="checkbox"'])(
      'contains no %s',
      (token) => {
        expect(readOnlySrc).not.toContain(token);
      },
    );

    it('offers no Save, Cancel or Edit affordance', () => {
      for (const key of ["t('save')", "t('saving')", "t('cancel')", "t('action_edit')"]) {
        expect(readOnlySrc).not.toContain(key);
      }
      expect(readOnlySrc).not.toContain('handleSave');
      expect(readOnlySrc).not.toContain('patchForm');
    });

    it('does not render App access actions', () => {
      for (const key of ["t('access_invite')", "t('access_resend')", "t('access_revoke')"]) {
        expect(readOnlySrc).not.toContain(key);
      }
      expect(readOnlySrc).not.toContain('handleGrantAccess');
      expect(readOnlySrc).not.toContain('setRevokingAccess');
    });

    it('keeps those App access actions in the Edit form, unchanged', () => {
      const editor = slice('function renderClerk()', 'function ReadRow(');
      expect(editor).toContain('handleGrantAccess(member)');
      expect(editor).toContain('setRevokingAccess(member)');
      expect(editor).toContain("t('access_revoke')");
    });

    it('renders the record from the row, not from the form being edited', () => {
      expect(readOnlySrc).not.toContain('form.');
      expect(readOnlySrc).toContain('formatStaffField(member, field');
    });
  });

  describe('the context menu is the only way in', () => {
    it('offers Edit as a context-menu item wired to startEdit', () => {
      expect(pageSrc).toMatch(/menuItems: ContextMenuItem\[\] = \[\s*\{ label: t\('action_edit'\), onClick: \(\) => startEdit\(member\)/);
    });

    it('keeps the existing menu items', () => {
      for (const key of ["t('action_details')", "t('action_duplicate')", "t('action_deactivate')", "t('action_delete')"]) {
        expect(pageSrc).toContain(key);
      }
    });

    it('disables Edit for a read-only role, like every other write action', () => {
      expect(pageSrc).toMatch(/onClick: \(\) => startEdit\(member\), disabled: !canWrite/);
    });
  });

  describe('sections and field definitions', () => {
    it('declares the field set once and reuses it for both halves', () => {
      expect(pageSrc).toContain("from './staffProfile'");
      expect(pageSrc).toContain('STAFF_PROFILE_SECTIONS.map((section)');
      // page.tsx no longer restates the columns the shared module owns.
      expect(pageSrc).toContain('export interface StaffMember extends StaffProfile');
    });

    it('lists every field exactly once', () => {
      const keys = STAFF_PROFILE_FIELDS.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.length).toBeGreaterThan(20);
    });

    it('lists only fields the Edit form actually edits', () => {
      for (const field of STAFF_PROFILE_FIELDS) {
        expect(pageSrc, `${field.key} is not edited by the form`).toContain(`patchForm({ ${field.key}:`);
      }
    });

    it('has an en/es/ca label for every field and section', () => {
      const keys = [
        ...STAFF_PROFILE_SECTIONS.map((s) => s.titleKey),
        ...STAFF_PROFILE_FIELDS.map((f) => f.labelKey),
        'action_edit',
        'centers_none',
        'label_assigned_centers',
        'label_default_center',
        'section_clerk',
        'clerk_status_label',
        'access_role_label',
        'clerk_user_id_label',
      ];
      for (const code of LOCALE_CODES) {
        for (const key of keys) {
          expect(locales[code][key], `${code}.staff.${key} is missing`).toBeTruthy();
        }
      }
    });

    it('labels the read-only Name without the form’s required marker', () => {
      // "Name *" beside a value nobody can change is nonsense.
      expect(readOnlySrc).not.toContain("+ ' *'");
    });
  });

  describe('value formatting', () => {
    const field = (key: string) => STAFF_PROFILE_FIELDS.find((f) => f.key === key)!;
    const translate = (key: string) => `t:${key}`;

    it('never renders null, undefined or an empty string', () => {
      for (const f of STAFF_PROFILE_FIELDS) {
        for (const value of [null, undefined, '']) {
          const out = formatStaffField({ [f.key]: value } as any, f, translate);
          expect(out).toBe(EMPTY_VALUE);
        }
        const missing = formatStaffField({}, f, translate);
        expect(missing).toBe(EMPTY_VALUE);
        expect(missing).not.toMatch(/null|undefined|NaN|Invalid/);
      }
    });

    it('translates the two status columns with the same keys the form uses', () => {
      expect(formatStaffField({ employment_status: 'inactive' } as any, field('employment_status'), translate))
        .toBe('t:employment_status_inactive');
      expect(formatStaffField({ current_status: 'on_vacation' } as any, field('current_status'), translate))
        .toBe('t:current_status_on_vacation');
    });

    it('formats dates, times, working days and the break duration', () => {
      expect(formatStaffField({ hire_date: '2024-03-01' } as any, field('hire_date'), translate)).toBe('01 Mar 2024');
      expect(formatStaffField({ work_start_time: '09:00:00' } as any, field('work_start_time'), translate)).toBe('09:00');
      expect(formatStaffField({ working_days: 'Mon,Tue,Fri' } as any, field('working_days'), translate)).toBe('Mon, Tue, Fri');
      expect(formatStaffField({ break_duration_minutes: 30 } as any, field('break_duration_minutes'), translate)).toBe('30');
      // A break of 0 minutes is a value, not a missing one.
      expect(formatStaffField({ break_duration_minutes: 0 } as any, field('break_duration_minutes'), translate)).toBe('0');
    });

    it('reads a date as a calendar date, not as an instant', () => {
      // new Date('1990-05-04') is UTC midnight and prints as 3 May west of Greenwich.
      const previous = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        expect(formatProfileDate('1990-05-04')).toBe('04 May 1990');
      } finally {
        if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
      }
    });

    it('accepts both a date string and the ISO timestamp the API may send', () => {
      expect(formatProfileDate('2024-03-01T00:00:00.000Z')).toBe('01 Mar 2024');
      expect(formatProfileDate('')).toBeNull();
      expect(formatProfileDate(null)).toBeNull();
      expect(formatProfileTime('9:05')).toBe('09:05');
      expect(formatProfileTime('not a time')).toBeNull();
      expect(formatWorkingDays(',,')).toBeNull();
    });
  });

  describe('the persisted row → form mapping', () => {
    const row = {
      first_name: 'Ada',
      last_name: 'Byron',
      email: 'ada@example.com',
      mobile_phone: null,
      date_of_birth: '1815-12-10T00:00:00.000Z',
      national_id: null,
      company_email: null,
      company_phone: null,
      personal_phone: null,
      emergency_contact: null,
      emergency_phone: null,
      profile: 'Front Desk',
      employment_status: 'active' as const,
      current_status: 'available',
      hire_date: '2024-03-01T00:00:00.000Z',
      contract_end_date: null,
      termination_date: null,
      employee_number: 'E-1',
      working_days: 'Mon,Tue',
      work_start_time: '09:00:00',
      work_end_time: '17:00:00',
      break_duration_minutes: 30,
      notes: 'line one\nline two',
    };

    it('narrows the four date columns and carries everything else through', () => {
      const values = toStaffEditFormValues(row);
      expect(values.date_of_birth).toBe('1815-12-10');
      expect(values.hire_date).toBe('2024-03-01');
      expect(values.contract_end_date).toBeNull();
      expect(values.termination_date).toBeNull();
      for (const key of Object.keys(row) as (keyof typeof row)[]) {
        if (['date_of_birth', 'hire_date', 'contract_end_date', 'termination_date'].includes(key as string)) continue;
        expect(values[key]).toBe(row[key]);
      }
    });

    it('never leaves hire_date undefined — the form input is a controlled value', () => {
      expect(toStaffEditFormValues({ ...row, hire_date: null as any }).hire_date).toBe('');
    });
  });

  describe('centers and App access', () => {
    it('reads the centers of the expanded card from the existing route', () => {
      expect(pageSrc).toContain('apiFetch<StaffCenterAssignment[]>(`/staff/${member.id}/centers`)');
      expect(readOnlySrc).toContain('expandedCenters');
    });

    it('handles a staff member with no centers instead of assuming a default', () => {
      expect(readOnlySrc).toContain("t('centers_none')");
      expect(readOnlySrc).toContain("defaultCenter?.name ?? EMPTY_VALUE");
    });

    it('shows the login state and its role, read-only', () => {
      expect(readOnlySrc).toContain("t('clerk_status_label')");
      expect(readOnlySrc).toContain('PROFILE_ROLE_MAP[member.profile]');
      expect(readOnlySrc).toContain("t('clerk_user_id_label')");
    });

    it('adds no new Staff endpoint — the read-only view reuses what the page already fetches', () => {
      const fetched = [...rawPageSrc.matchAll(/apiFetch<[^>]*>\(`?\/staff[^`'"]*/g)].map((m) => m[0]);
      for (const call of fetched) {
        expect(call).toMatch(/\/staff(\?|\/\$\{|$|\/)/);
      }
      expect(pageSrc).not.toContain('/staff/profile');
      expect(pageSrc).not.toContain('/details');
    });
  });

  describe('notes', () => {
    it('keeps the author’s line breaks instead of stretching the card', () => {
      expect(readOnlySrc).toContain("whiteSpace: 'pre-wrap'");
      expect(readOnlySrc).toContain("overflowWrap: 'anywhere'");
    });
  });
});

afterAll(() => {
  // Nothing to tear down; kept explicit so a future DB-less helper is not added here.
});
