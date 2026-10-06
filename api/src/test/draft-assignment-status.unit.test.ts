// #1108 stage 1 — the gate on "a newly assigned Membership Plan is a Draft".
//
// The rule is spread across places that cannot see each other, and every one of
// them fails *silently* if it drifts:
//
//  * the CHECK (migration 227) and `STATUSES` — a value in one and not the other
//    either makes every assignment INSERT fail, or lets a status through that
//    no route knows;
//  * the three assignment paths — one left writing `'active'` would quietly keep
//    skipping the Draft state for whichever screen assigns through it;
//  * `LIVE_ASSIGNMENT_STATUSES` — a `draft` in it would make configuring a
//    replacement impossible again (#956's 409 at assignment time), which is the
//    exact state Q2's answer exists to allow;
//  * the nightly run and the booking gate — a Draft that fell into either would
//    be charged, or bookable, while reading as uncommitted on every screen;
//  * the member-facing reads — `FIELD()` answers 0 for a status it does not
//    list, which sorts *first*, so a Draft reaching `MEMBER_CURRENT_ASSIGNMENT_ORDER`
//    without the filter beside it would be described to the member as their
//    membership;
//  * the admin's mirrors of the editability and closeability lists, and the
//    `Activate` label — a missing locale key renders as the key itself, because
//    next-intl has no fallback.
//
// It lives in the API suite because CI runs `npm test` in `api/` only, which is
// also why it reaches into both apps' sources (#1009's reason).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countsAsRecentMembership } from '../domain/newMemberEligibility';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';

const API_SRC = join(__dirname, '..');
const REPO = join(API_SRC, '..', '..');
const ADMIN_SRC = join(REPO, 'apps', 'admin', 'src');
const ADMIN_LOCALES = join(REPO, 'apps', 'admin', 'locales', 'base');

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

/** A source file with `//` and `/* *\/` comments stripped, so a rule is asserted against code. */
function code(...parts: string[]): string {
  return read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MIGRATION = read(API_SRC, 'infra', 'migrations', '227_draft_membership_status.js');
// The same file with its header prose removed: that prose *names*
// `awaiting_payment` to say it stays retired, which is the opposite of the drift
// the assertion below is looking for.
const MIGRATION_CODE = code(API_SRC, 'infra', 'migrations', '227_draft_membership_status.js');
const USER_MEMBERSHIPS = code(API_SRC, 'api', 'user-memberships.ts');

describe('the status CHECK and the API\'s status list agree', () => {
  it('migration 227 widens the CHECK to exactly the five statuses the router accepts', () => {
    // The widened list in the migration…
    const wide = MIGRATION.match(/const WIDE = \[([^\]]*)\]/);
    const narrow = MIGRATION.match(/const NARROW = \[([^\]]*)\]/);
    expect(wide).toBeTruthy();
    expect(narrow).toBeTruthy();
    const values = (m: RegExpMatchArray) =>
      [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    const wideValues = [...values(wide!), ...values(narrow!)];

    // …and the router's own list.
    const statuses = USER_MEMBERSHIPS.match(/const STATUSES = \[([^\]]*)\] as const;/);
    expect(statuses).toBeTruthy();
    const routerValues = [...statuses![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);

    expect(new Set(routerValues)).toEqual(new Set(wideValues));
    expect(routerValues).toContain('draft');
  });

  it('compares the stored CHECK as an exact set, so a six-value one is not accepted', () => {
    // Migration 185's device. A substring test would let `up` return early on a
    // database carrying migration 148's six-value CHECK, leaving
    // `awaiting_payment` legal while nothing can write it.
    expect(MIGRATION_CODE).toContain('isStatusSet');
    expect(MIGRATION_CODE).not.toMatch(/clause\.includes\("'draft'"\)/);
  });

  it('does not bring back awaiting_payment, which stays retired', () => {
    // #1108's second pre-activation state is Pending Payment, and it arrives
    // with stage 2's Save & Pay rather than as a value nothing can write.
    expect(MIGRATION_CODE).not.toContain('awaiting_payment');
    expect(USER_MEMBERSHIPS).not.toContain('awaiting_payment');
  });

  it('declares draft -> active and draft -> cancelled, and nothing else, as the Draft\'s transitions', () => {
    const table = USER_MEMBERSHIPS.match(/const ALLOWED_TRANSITIONS[\s\S]*?\n\};/);
    expect(table).toBeTruthy();
    const draftRow = table![0].match(/draft: \[([^\]]*)\]/);
    expect(draftRow).toBeTruthy();
    const targets = [...draftRow![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(targets.sort()).toEqual(['active', 'cancelled']);
  });
});

describe('every assignment path creates a Draft', () => {
  const MEMBERSHIP_PLANS = code(API_SRC, 'api', 'membership-plans.ts');

  it('names the creation status once rather than in three INSERTs', () => {
    expect(USER_MEMBERSHIPS).toContain("export const ASSIGNMENT_CREATION_STATUS = 'draft';");
  });

  it('has no INSERT INTO user_memberships that omits the status column or hardcodes a literal', () => {
    for (const source of [USER_MEMBERSHIPS, MEMBERSHIP_PLANS]) {
      const inserts = [...source.matchAll(
        /INSERT INTO user_memberships\s*\(([^)]*)\)[\s\S]*?VALUES \(([^)]*)\)/g,
      )];
      expect(inserts.length).toBeGreaterThan(0);
      for (const insert of inserts) {
        // The column still DEFAULTs to 'active' (migration 001), so a path that
        // simply left it out would create an Active plan with no error at all.
        expect(insert[1]).toContain('status');
        // And a path writing `'active'` straight into the VALUES list would skip
        // the Draft state for whichever screen assigns through it.
        expect(insert[2]).not.toContain("'active'");
      }
    }
  });

  it('passes the creation constant from all three paths', () => {
    // Two in user-memberships.ts (POST / and assign-new-plan), one in
    // membership-plans.ts (the Plans page's bulk assign).
    expect([...USER_MEMBERSHIPS.matchAll(/ASSIGNMENT_CREATION_STATUS/g)].length)
      .toBeGreaterThanOrEqual(4);
    expect(MEMBERSHIP_PLANS).toContain('ASSIGNMENT_CREATION_STATUS');
  });

  it('commits a Draft through POST /:id/activate and refuses the flip on PUT', () => {
    expect(USER_MEMBERSHIPS).toMatch(/post\('\/:id\/activate'/);
    // The PUT names the route rather than performing the transition, so #956's
    // check and the supersede cannot be bypassed.
    expect(USER_MEMBERSHIPS).toContain('/user-memberships/:id/activate');
  });
});

describe('a Draft is not the member\'s Membership Plan', () => {
  it('is absent from LIVE_ASSIGNMENT_STATUSES', () => {
    const oneActivePlan = code(API_SRC, 'domain', 'oneActivePlan.ts');
    const live = oneActivePlan.match(/export const LIVE_ASSIGNMENT_STATUSES = \[([^\]]*)\]/);
    expect(live).toBeTruthy();
    const values = [...live![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(values).toEqual(['active', 'paused']);
  });

  it('counts as nothing for New Member eligibility, in either direction', () => {
    const cutoff = '2026-04-06';
    const base = {
      id: 1, starts_at: '2026-10-01', ends_at: null, closed_at: null, created_at: '2026-10-01 10:00:00',
    };
    // A Draft's `starts_at` is by definition inside the window, so without the
    // explicit answer it would disqualify every member it is configured for.
    expect(countsAsRecentMembership({ ...base, status: 'draft' }, cutoff)).toBe(false);
    expect(countsAsRecentMembership({ ...base, status: 'active' }, cutoff)).toBe(true);
    // And an old Draft does not read as a lapsed membership either.
    expect(countsAsRecentMembership(
      { ...base, status: 'draft', starts_at: '2020-01-01', created_at: '2020-01-01 10:00:00' },
      cutoff,
    )).toBe(false);
  });

  it('is excluded from the member\'s enrollment status', () => {
    // This reads the *latest* assignment, so a Draft configured for a currently
    // Active member would otherwise overwrite their status on the Members list
    // and drop them out of the Nutrition Dashboard's active count.
    expect(latestEnrollmentStatusSql('m').replace(/\s+/g, ' '))
      .toContain("um.status <> 'draft'");
  });

  it('is excluded from the two member-facing reads, by the constant beside the ordering', () => {
    const forecast = code(API_SRC, 'api', 'me-billing-forecast.ts');
    expect(forecast).toContain("export const MEMBER_CURRENT_ASSIGNMENT_FILTER = \"AND um.status <> 'draft'\";");
    // Both callers append both halves: the ordering alone would sort a Draft
    // first, because FIELD() answers 0 for a value it does not list.
    for (const source of [forecast, code(API_SRC, 'api', 'me.ts')]) {
      expect(source).toContain('MEMBER_CURRENT_ASSIGNMENT_FILTER');
      expect(source).toContain('MEMBER_CURRENT_ASSIGNMENT_ORDER');
    }
  });

  it('is excluded from the Financials dashboard\'s assigned-plan count', () => {
    expect(code(API_SRC, 'api', 'financials-dashboard.ts'))
      .toContain("um.status NOT IN ('draft', 'cancelled', 'expired')");
  });
});

describe('a Draft bills nothing and books nothing', () => {
  it('leaves the nightly run reading active assignments only', () => {
    expect(code(API_SRC, 'api', 'billing.ts')).toContain("WHERE um.status = 'active'");
  });

  it('leaves the booking gate reading active assignments only', () => {
    expect(code(API_SRC, 'api', 'activity-eligibility.ts')).toContain("um.status = 'active'");
  });
});

describe('a Draft is editable and projected', () => {
  it('is in the API\'s editable, attachable and closeable status lists', () => {
    const lists: [string, string][] = [
      [USER_MEMBERSHIPS, 'SNAPSHOT_EDITABLE_STATUSES'],
      [USER_MEMBERSHIPS, 'CLOSEABLE_FROM'],
      [code(API_SRC, 'api', 'user-membership-services.ts'), 'ATTACHABLE_STATUSES'],
    ];
    for (const [source, name] of lists) {
      const match = source.match(new RegExp(`${name}[^=]*= \\[([^\\]]*)\\]`));
      expect(match, name).toBeTruthy();
      expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), name).toContain('draft');
    }
  });

  it('is simulated, so the Billing Event Forecast answers what committing it would bill', () => {
    const simulation = code(API_SRC, 'api', 'billing-simulation.ts');
    const match = simulation.match(/const SIMULATED_STATUSES = \[([^\]]*)\]/);
    expect(match).toBeTruthy();
    expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toContain('draft');
  });

  it('appears in the Member card\'s own configuration read', () => {
    const configuration = code(API_SRC, 'api', 'member-membership-configuration.ts');
    const match = configuration.match(/const LIVE_STATUSES = \[([^\]]*)\]/);
    expect(match).toBeTruthy();
    expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toContain('draft');
  });
});

describe('the admin app mirrors the status model', () => {
  const CARD = code(ADMIN_SRC, 'components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx');

  it('mirrors the editable and closeable lists on the Assigned Plan card', () => {
    for (const name of ['EDITABLE_STATUSES', 'CLOSEABLE_STATUSES']) {
      const match = CARD.match(new RegExp(`${name} = \\[([^\\]]*)\\]`));
      expect(match, name).toBeTruthy();
      expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), name).toContain('draft');
    }
  });

  it('offers Activate for a Draft and routes it through the activation endpoint', () => {
    expect(CARD).toContain("detail.status === 'draft'");
    expect(CARD).toContain('/activate');
    // #956's one dialog, raised by the activation now that the four assignment
    // paths no longer 409.
    expect(CARD).toContain('ReplacePlanDialog');
  });

  it('lets the Assigned Plans filter name a Draft', () => {
    const page = code(ADMIN_SRC, 'app', '[locale]', 'financials', 'assigned-plans', 'page.tsx');
    const match = page.match(/const LIFECYCLE_STATUSES: LifecycleStatus\[\] = \[([^\]]*)\]/);
    expect(match).toBeTruthy();
    expect([...match![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toContain('draft');
  });

  it('has a label for the status and for the action in every locale', () => {
    for (const locale of ['en', 'es', 'ca']) {
      const messages = JSON.parse(read(ADMIN_LOCALES, `${locale}.json`));
      // next-intl prints a missing key verbatim, so an absent one renders as
      // `status.draft` on screen rather than falling back to anything.
      expect(messages.status?.draft, locale).toBeTruthy();
      expect(messages.assigned_plans_page?.action_activate, locale).toBeTruthy();
    }
  });
});
