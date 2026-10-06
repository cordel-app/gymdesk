// #1122 §7/§8 — **Past Membership Plans** in the Members App: which of a
// member's assignments are history, what each row reports, and how the app
// words it.
//
// Both halves are pure, which is why they are separate modules:
// `api/src/domain/memberPlanHistory.ts` owns the split and the wire shape,
// `apps/member/src/lib/memberPlans.ts` owns the keys and the formatting, and
// neither needs a database, a server or a browser to assert.
//
// It lives in the **API** suite because CI runs `npm test` in `api/` only
// (#1009's reason, the same one `member-products.unit.test.ts` gives).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBER_PLAN_HISTORY_LIMIT,
  type MemberPlanHistoryRow,
  splitMemberPlanHistory,
  toMemberPastPlan,
} from '../domain/memberPlanHistory';
import {
  pastPlanEndedOn,
  pastPlanName,
  pastPlanStatusKey,
} from '../../../apps/member/src/lib/memberPlans';

const REPO = join(__dirname, '..', '..', '..');
const MEMBER = join(REPO, 'apps', 'member');
const LOCALES = ['en', 'es', 'ca'] as const;

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf-8');
}

function messages(code: string): any {
  return JSON.parse(read(MEMBER, 'locales', 'base', `${code}.json`));
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function row(over: Partial<MemberPlanHistoryRow> = {}): MemberPlanHistoryRow {
  return {
    id: 1,
    membership_plan_id: 10,
    plan_name: 'Premium',
    status: 'cancelled',
    starts_at: '2026-01-01',
    ends_at: '2026-09-12',
    closed_at: null,
    ...over,
  };
}

describe('which plans are history', () => {
  it('is the tail of the one ordering, so the current plan is never listed twice', () => {
    const current = row({ id: 3, status: 'active', plan_name: 'Standard', ends_at: null });
    const { current: head, past } = splitMemberPlanHistory([current, row({ id: 2 }), row({ id: 1 })]);
    expect(head).toBe(current);
    expect(past.map((p) => p.id)).not.toContain(3);
    expect(past).toHaveLength(2);
  });

  it('answers nothing at all for a member with no assignment', () => {
    expect(splitMemberPlanHistory([])).toEqual({ current: null, past: [] });
  });

  it('leaves a member whose only plan is their current one with no history', () => {
    const { past } = splitMemberPlanHistory([row({ id: 7, status: 'active' })]);
    expect(past).toEqual([]);
  });

  it('orders the history by date, newest first — the ordering above groups by status', () => {
    // `MEMBER_CURRENT_ASSIGNMENT_ORDER` sorts `expired` ahead of `cancelled`
    // whatever the dates, which is right for picking a current plan and wrong
    // for reading a history.
    const { past } = splitMemberPlanHistory([
      row({ id: 9, status: 'active', starts_at: '2026-10-01' }),
      row({ id: 4, status: 'expired', starts_at: '2026-02-01' }),
      row({ id: 5, status: 'cancelled', starts_at: '2026-06-01' }),
    ]);
    expect(past.map((p) => p.id)).toEqual([5, 4]);
  });

  it('reads at most a declared number of rows, written into the statement', () => {
    expect(MEMBER_PLAN_HISTORY_LIMIT).toBeGreaterThan(0);
    const me = read(join(REPO, 'api', 'src', 'api', 'me.ts'));
    // #1113's rule: `db.query` is a prepared statement and MySQL refuses a
    // bound `LIMIT ?`, so the constant is written into the statement. (The
    // repo-wide gate is `bound-limit-placeholder.unit.test.ts`.)
    expect(me).toContain('LIMIT ${MEMBER_PLAN_HISTORY_LIMIT}');
  });

  it('excludes a Draft through the same two halves the current plan does', () => {
    // #1108 Q2 — one query, so a Draft reaches neither the card nor the history.
    const me = read(join(REPO, 'api', 'src', 'api', 'me.ts'));
    expect(me).toContain('MEMBER_CURRENT_ASSIGNMENT_FILTER');
    expect(me).toContain('MEMBER_CURRENT_ASSIGNMENT_ORDER');
  });
});

describe('what a past plan reports', () => {
  it('ends on its own end date', () => {
    expect(toMemberPastPlan(row()).ended_on).toBe('2026-09-12');
  });

  it('falls back to when it was closed, and never to when it started', () => {
    expect(toMemberPastPlan(row({ ends_at: null, closed_at: '2026-08-03 11:04:00' })).ended_on)
      .toBe('2026-08-03');
    expect(toMemberPastPlan(row({ ends_at: null, closed_at: null })).ended_on).toBeNull();
  });

  it('reports dates as bare days, including a DATETIME and a Date object', () => {
    const plan = toMemberPastPlan(row({ starts_at: new Date('2026-01-01T00:00:00Z') }));
    expect(plan.starts_at).toBe('2026-01-01');
  });

  it('carries no money and no action — a history is not an active plan', () => {
    expect(Object.keys(toMemberPastPlan(row())).sort()).toEqual(
      ['ended_on', 'id', 'membership_plan_id', 'plan_name', 'starts_at', 'status'],
    );
  });
});

describe('how the Members App words one', () => {
  const plan = { id: 1, membership_plan_id: 10, plan_name: 'Premium', status: 'cancelled', starts_at: '2026-01-01', ended_on: '2026-09-12' };

  it('names the status through the membership.status map both halves already share', () => {
    expect(pastPlanStatusKey(plan)).toBe('membership.status.cancelled');
    for (const code of LOCALES) {
      expect(messages(code).membership.status.cancelled).toBeTruthy();
    }
  });

  it('shows a dash for a plan whose Membership Plan has since been deleted', () => {
    expect(pastPlanName({ ...plan, plan_name: null })).toBe('—');
  });

  it('formats the end date in the member\'s own locale, and answers null for none', () => {
    expect(pastPlanEndedOn(plan, 'en')).toContain('2026');
    expect(pastPlanEndedOn({ ...plan, ended_on: null }, 'en')).toBeNull();
  });

  it('declares its two keys in every locale', () => {
    for (const code of LOCALES) {
      const membership = messages(code).membership;
      expect(membership.past_plans_heading).toBeTruthy();
      expect(membership.past_plans_count).toContain('plural');
    }
  });

  it('resolves no t() and spells no colour in either half', () => {
    const lib = withoutComments(read(MEMBER, 'src', 'lib', 'memberPlans.ts'));
    const card = withoutComments(read(MEMBER, 'src', 'components', 'PastMembershipPlansCard.tsx'));
    for (const source of [lib, card]) {
      expect(source).not.toMatch(/\bt\(/);
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/rgba?\(/);
    }
  });

  it('wears the app\'s one collapsible card rather than a second one', () => {
    // #1115/#1123 — a second expand affordance in this app is what promoting
    // the chrome out of the Payments card removed.
    const card = read(MEMBER, 'src', 'components', 'PastMembershipPlansCard.tsx');
    const payments = read(MEMBER, 'src', 'components', 'MemberPaymentsCard.tsx');
    for (const source of [card, payments]) {
      expect(source).toContain('MemberCollapsibleCard');
    }
  });

  it('shows no status pill on a past plan — that is the current plan\'s emphasis (§8)', () => {
    const card = withoutComments(read(MEMBER, 'src', 'components', 'PastMembershipPlansCard.tsx'));
    expect(card).not.toContain('statusPillStyle');
  });

  it('does not decide for itself which plans are past', () => {
    // The server splits them off the one ordering; a client-side status filter
    // is how a plan comes to be named in the card above and listed under it.
    const page = withoutComments(read(MEMBER, 'src', 'app', '[locale]', 'membership', 'page.tsx'));
    expect(page).toContain('past_memberships');
    expect(page).not.toMatch(/filter\(\s*\(?\w+\)?\s*=>\s*\w+\.status === 'cancelled'/);
  });
});
