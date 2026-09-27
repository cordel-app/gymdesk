import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #801 — Activities removed from Spaces.
//
// The Space form used to carry an `ACTIVITIES` checkbox list that wrote
// `PUT /spaces/:id/activity-types` right after `PUT /spaces/:id`, and the
// expanded card rendered the same relation read-only. §1–§3 remove the section;
// §7 forbids sending Activity data in the Space payload; §4/§9 protect the
// relation that survives — the Activity Type's own **default Space**, edited on
// the Activity Types page, which this ticket must not touch.
//
// `apps/admin` has no component test infrastructure, so this is a source scan,
// the same shape as `included-services-removed.test.ts` and
// `plans-charge-benefits-removed.test.ts`.

const SPACES_PAGE = join(__dirname, '..', 'app', '[locale]', 'spaces', 'page.tsx');
const ACTIVITY_TYPES_PAGE = join(__dirname, '..', 'app', '[locale]', 'activity-types', 'page.tsx');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

// The source deliberately names the removed section in a comment, so every scan
// below runs against code with comments stripped.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const rawPage = readFileSync(SPACES_PAGE, 'utf-8');
const page = stripComments(rawPage);

const locales = Object.fromEntries(
  LOCALE_CODES.map((code) => [
    code,
    JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8')) as Record<string, any>,
  ]),
) as Record<(typeof LOCALE_CODES)[number], Record<string, any>>;

describe('#801 — the Spaces page has no Activities section', () => {
  it('names no activity-types route (AC5, AC6)', () => {
    expect(page).not.toContain('/activity-types');
  });

  it('never fetches the Activity Type catalogue (§8)', () => {
    expect(page).not.toContain("apiFetch<ActivityType[]>");
    expect(page).not.toMatch(/loadActivityTypes|loadSpaceATs/);
  });

  it('holds no Activity form state (§3, §6)', () => {
    expect(page).not.toMatch(/activityTypes|editSelectedATs|selectedATs/);
    expect(page).not.toContain('ActivityType');
  });

  it('declares no Activity section header or empty-state label', () => {
    expect(page).not.toContain('section_activity_types');
    expect(page).not.toContain('no_activity_types');
  });

  it('renders no SpaceActivityTypes sub-component (§8, §20)', () => {
    expect(page).not.toContain('SpaceActivityTypes');
  });

  it('carries no checkbox at all, the only control the section used (AC2)', () => {
    expect(page).not.toContain('type="checkbox"');
  });
});

describe('#801 — what the Space form still does (AC7)', () => {
  // The whole point of the ticket is that only the ACTIVITIES section goes. The
  // editable field set is asserted here so a future sweep cannot take a Space
  // field with it.
  it.each([
    ['name', 'label_name'],
    ['description', 'label_description'],
    ['capacity', 'label_capacity'],
    ['center', 'label_center'],
    ['status', 'label_status'],
    ['opening time', 'label_opening_time'],
    ['closing time', 'label_closing_time'],
  ])('still labels %s', (_field, key) => {
    expect(page).toContain(`t('${key}')`);
  });

  it.each(['section_general', 'section_availability', 'section_notes'])(
    'still renders the %s section',
    (key) => {
      expect(page).toContain(`t('${key}')`);
    },
  );

  it('still edits through the one PUT /spaces/:id call (§19, AC14)', () => {
    const puts = page.match(/apiFetch\(`\/spaces\/\$\{space\.id\}`/g) ?? [];
    expect(puts.length).toBe(1);
    // …and Save issues exactly that one request, where it used to issue two.
    expect((page.match(/method: 'PUT'/g) ?? []).length).toBe(1);
  });

  it('keeps Edit behind the context menu and the write gate (AC13)', () => {
    expect(page).toContain("{ label: t('edit'), onClick: () => openEdit(space), disabled: !canWrite");
  });

  it('seeds the edit form synchronously, since nothing has to be loaded first', () => {
    expect(page).toContain('function openEdit(space: Space) {');
    expect(page).not.toContain('async function openEdit');
  });
});

describe('#801 — the surviving relation is untouched (AC3, AC4, AC8)', () => {
  const activityTypesPage = readFileSync(ACTIVITY_TYPES_PAGE, 'utf-8');

  it('the Activity Types page still edits default_space_id', () => {
    expect(activityTypesPage).toContain('default_space_id');
  });

  it('the Spaces page never writes default_space_id (§4)', () => {
    expect(page).not.toContain('default_space_id');
  });
});

describe('#801 — locales (§13)', () => {
  it.each(LOCALE_CODES)('%s drops both Space-side Activity labels', (code) => {
    const spaces = locales[code].spaces as Record<string, unknown>;
    expect(spaces).toBeTruthy();
    expect(Object.keys(spaces)).not.toContain('section_activity_types');
    expect(Object.keys(spaces)).not.toContain('no_activity_types');
  });

  it.each(LOCALE_CODES)('%s keeps the Space labels the form still uses', (code) => {
    const spaces = locales[code].spaces as Record<string, unknown>;
    for (const key of [
      'label_name', 'label_description', 'label_capacity', 'label_center', 'label_status',
      'label_opening_time', 'label_closing_time',
      'section_general', 'section_availability', 'section_notes',
    ]) {
      expect(spaces[key], `spaces.${key} missing from ${code}.json`).toBeTruthy();
    }
  });

  it.each(LOCALE_CODES)('%s keeps the Activity Types namespace, which owns the default Space', (code) => {
    expect(locales[code].activity_types).toBeTruthy();
  });
});
