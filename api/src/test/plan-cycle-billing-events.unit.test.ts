// #1130 stage 3 — the Billing Event Simulation groups its cards by the same two
// cycle iterations the Membership Fee Simulation above it groups its rows by.
//
// Stage 1 (#1170) made the contract's Free -> Pre-paid -> Paid -> Bonus stretch a
// **cycle** and stage 2 (#1179) said so on the fee table. §2 of the ticket asks
// the card-based section below it for the same story — "a lightweight
// presentation layer around the existing billing-event cards", no table, no
// bordered container, no horizontal divider — and §3 asks the two to tell
// *exactly* the same story.
//
// Two things are therefore worth gating, and they are not the markup:
//
//   1. **The span.** A repeating cycle never reaches a regular charge, so the
//      projection's own horizon rule had nothing to find and ran every renewing
//      Plan to the engine's 36-month safety cap — an arbitrary slice of a cycle
//      that might be 15 periods or 40, reported as `truncated`. The cycle is the
//      horizon now, and it is the *same* count the fee table bounds its rows by
//      (`timelineCyclePeriods()`), so the two sections cover the same dates by
//      construction rather than by coincidence.
//   2. **Who decides.** Which iteration a billing date falls in is
//      `planDurationCycleIteration()`'s answer, reported per group. A page that
//      counted its own iterations could group cards the nightly run bills
//      differently, and nothing at runtime would notice: a tidy second cycle
//      renders perfectly well.
//
// It lives in the API suite for #1009's reason: CI runs `npm test` in `api/` only
// (the admin job type-checks and builds).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { computePlanBillingEventSimulation } from '../domain/planBillingEventSimulation';
import { computePlanExampleTimeline } from '../domain/planExampleTimeline';
import { computePromotionBillingEventSimulation } from '../domain/promotionBillingEventSimulation';
import { MAX_TIMELINE_PERIODS, timelineCycleHorizon, timelineCyclePeriods } from '../domain/exampleTimeline';
import { planDurationCycleIteration, toPlanDuration } from '../domain/planDuration';
import { NO_PRODUCT_BENEFIT } from '../domain/productBenefitActions';
import { billingEventCycleCells } from '../../../apps/admin/src/lib/billingEventSimulation';

const REPO = join(__dirname, '..', '..', '..');
const ADMIN = join(REPO, 'apps', 'admin');

const COMPONENT = join(ADMIN, 'src', 'components', 'BillingEventSimulation.tsx');
const LIB = join(ADMIN, 'src', 'lib', 'billingEventSimulation.ts');
const PLANS_PAGE = join(ADMIN, 'src', 'app', '[locale]', 'plans', 'page.tsx');
const ASSIGNED_CARD = join(ADMIN, 'src', 'components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx');

const read = (path: string) => readFileSync(path, 'utf-8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const componentSrc = stripComments(read(COMPONENT));
const plansSrc = stripComments(read(PLANS_PAGE));
const assignedSrc = stripComments(read(ASSIGNED_CARD));

const MONTH = { interval: 1, unit: 'month' as const };
const ANCHOR = '2026-10-05';

interface Durations { free?: number; paid?: number; bonus?: number; prepaid?: number }

const duration = (d: Durations, repeats: boolean) =>
  toPlanDuration(d.free ?? 0, d.paid ?? 0, d.bonus ?? 0, d.prepaid ?? 0, MONTH, repeats);

/** The Plan's two projections, over one and the same Billing & Duration. */
function project(d: Durations, repeats: boolean, items: Parameters<typeof computePlanBillingEventSimulation>[0]['items'] = []) {
  const shared = {
    planName: 'Full Access',
    duration: duration(d, repeats),
    cadence: MONTH,
    membershipFeeInclTax: 70,
    anchorDate: ANCHOR,
  };
  return {
    events: computePlanBillingEventSimulation({ ...shared, items }),
    fees: computePlanExampleTimeline(shared),
  };
}

/** `12 pre-paid + 3 bonus`, the ticket's own example: a 15-period cycle. */
const TICKET: Durations = { paid: 12, prepaid: 12, bonus: 3 };

describe('#1130 stage 3: a repeating cycle is the projection’s horizon', () => {
  it('spans exactly two iterations and reports the cycle it grouped by', () => {
    const { events } = project(TICKET, true);
    expect(events.available).toBe(true);
    expect(events.cycle).toEqual({ length: 15, repeats: true, iterations: 2 });
    // Two iterations and not a third: every card belongs to one of them.
    expect([...new Set(events.dates.map((g) => g.cycle))].sort()).toEqual([1, 2]);
  });

  it('is not reported truncated: the span is the cycle, not the safety cap', () => {
    const { events } = project(TICKET, true);
    expect(events.truncated).toBe(false);
    // Before the ticket the fee stream walked to `MAX_SIMULATION_MONTHS` because
    // a renewing contract has no regular charge to stop at — 36 months of a
    // 15-period cycle, which is neither one iteration nor two.
    expect(events.horizon_date).toBe('2029-03-05');
  });

  it('stops where the Membership Fee Simulation beside it stops (§3)', () => {
    for (const d of [TICKET, { free: 3, paid: 12, bonus: 2 }, { free: 1, paid: 11 }]) {
      const { events, fees } = project(d, true);
      const lastRow = fees.periods[fees.periods.length - 1];
      const lastCard = events.dates[events.dates.length - 1];
      expect(lastRow.startsOn, `last fee period of ${JSON.stringify(d)}`).toBe(lastCard.date);
      // And both are the shared count's own answer, so neither can drift.
      expect(fees.periods.length).toBe(timelineCyclePeriods(events.cycle));
      expect(timelineCycleHorizon(ANCHOR, MONTH, events.cycle)).toBe(lastCard.date);
    }
  });

  it('shows a cycle longer than the engine’s month cap without truncating it', () => {
    // 36 periods per iteration: two of them are 72 months, well past
    // `MAX_SIMULATION_MONTHS = 36`, which used to cut it mid-iteration.
    const { events, fees } = project({ paid: 24, bonus: 12 }, true);
    expect(events.truncated).toBe(false);
    expect([...new Set(events.dates.map((g) => g.cycle))]).toEqual([1, 2]);
    // Both projections clamp at the one shared row budget, so neither claims a
    // span the other does not reach.
    expect(timelineCyclePeriods(events.cycle)).toBe(MAX_TIMELINE_PERIODS);
    expect(fees.periods[fees.periods.length - 1].startsOn)
      .toBe(events.dates[events.dates.length - 1].date);
  });

  it('bounds a slower Product’s own two-cycle floor by the displayed iterations', () => {
    // #915's floor stretches the projection to two cycles of *every* recurring
    // stream, which for a yearly item is two years. Inside a repeating cycle
    // that floor is clamped: a card the fee table has no row for would claim a
    // third iteration.
    const { events, fees } = project({ paid: 1, bonus: 1 }, true, [{
      productId: 1, name: 'Insurance', category: 'periodical', billingFrequency: 'year',
      unitPriceInclTax: 30, quantity: 1, sessionFrequency: null,
      benefit: NO_PRODUCT_BENEFIT, mandatory: false,
    }]);
    expect(events.dates[events.dates.length - 1].date)
      .toBe(fees.periods[fees.periods.length - 1].startsOn);
    expect(events.dates.every((g) => g.cycle === 1 || g.cycle === 2)).toBe(true);
  });
});

describe('#1130 stage 3: everything else is left exactly as it was', () => {
  it('leaves a non-repeating contract’s horizon rules alone', () => {
    const { events } = project(TICKET, false);
    expect(events.cycle).toEqual({ length: 15, repeats: false, iterations: 1 });
    // The first-regular-charge rule still ends it, so the projection runs past
    // the configured stretch into the contract's regular price — which is the
    // one card that belongs to no iteration.
    const last = events.dates[events.dates.length - 1];
    expect(last.cycle).toBeNull();
    expect(events.dates.filter((g) => g.cycle === 1).length).toBeGreaterThan(0);
    expect(events.dates.some((g) => g.cycle === 2)).toBe(false);
  });

  it('groups nothing for a Plan with no Billing & Duration at all', () => {
    const { events } = project({}, false);
    expect(events.available).toBe(true);
    expect(events.cycle).toBeNull();
    expect(events.dates.length).toBeGreaterThan(0);
    expect(events.dates.every((g) => g.cycle === null)).toBe(true);
  });

  it('gives a Promotion no cycle: it has no Billing & Duration of its own', () => {
    const result = computePromotionBillingEventSimulation({
      promotionName: 'Summer',
      grants: [{
        productId: 1, name: 'Locker', category: 'periodical', billingFrequency: 'month',
        unitPriceInclTax: 10, quantity: 2, benefit: NO_PRODUCT_BENEFIT,
      }],
      anchorDate: ANCHOR,
    });
    expect(result.available).toBe(true);
    expect(result.cycle).toBeNull();
    expect(result.dates.every((g) => g.cycle === null)).toBe(true);
  });
});

describe('#1130 stage 3: which iteration a date falls in is decided once', () => {
  const repeating = duration(TICKET, true);
  const once = duration(TICKET, false);

  it('counts iterations of a repeating cycle from the contract’s anchor', () => {
    expect(planDurationCycleIteration(repeating, ANCHOR, ANCHOR)).toBe(1);
    expect(planDurationCycleIteration(repeating, ANCHOR, '2027-12-05')).toBe(1);
    // Period 16 — the first of the second iteration.
    expect(planDurationCycleIteration(repeating, ANCHOR, '2028-01-05')).toBe(2);
    expect(planDurationCycleIteration(repeating, ANCHOR, '2029-03-05')).toBe(2);
    expect(planDurationCycleIteration(repeating, ANCHOR, '2029-04-05')).toBe(3);
  });

  it('names no iteration outside a single pass, before the start, or with no cycle', () => {
    expect(planDurationCycleIteration(once, ANCHOR, '2027-12-05')).toBe(1);
    // The regular periods a non-repeating contract settles into are not a
    // second iteration — they carry neither a number nor a line.
    expect(planDurationCycleIteration(once, ANCHOR, '2028-01-05')).toBeNull();
    expect(planDurationCycleIteration(repeating, ANCHOR, '2026-10-04')).toBeNull();
    expect(planDurationCycleIteration(duration({}, true), ANCHOR, ANCHOR)).toBeNull();
  });

  it('bounds the displayed span only where the cycle repeats', () => {
    expect(timelineCyclePeriods({ length: 15, repeats: true, iterations: 2 })).toBe(30);
    expect(timelineCyclePeriods({ length: 15, repeats: false, iterations: 1 })).toBeNull();
    expect(timelineCyclePeriods({ length: 0, repeats: true, iterations: 2 })).toBeNull();
    expect(timelineCyclePeriods(null)).toBeNull();
    expect(timelineCycleHorizon(ANCHOR, MONTH, null)).toBeNull();
  });
});

describe('#1130 stage 3: the cards’ grouping reads the server’s answer', () => {
  const cells = (cycles: (number | null)[]) => billingEventCycleCells(cycles.map((cycle) => ({ cycle })));

  it('numbers the first card of each run and ends its line there', () => {
    expect(cells([1, 1, 2, 2])).toEqual([
      { label: '1', endsSegment: false },
      { label: null, endsSegment: true },
      { label: '2', endsSegment: false },
      { label: null, endsSegment: true },
    ]);
  });

  it('numbers the first card rendered even mid-iteration (an assignment’s forecast)', () => {
    // #1130 stage 2's rule, one layout over: a contract on its third cycle reads
    // `3` and `4` rather than being relabelled `1` and `2`, and the forecast
    // starts at the period containing today.
    expect(cells([3, 3, 4]).map((c) => c?.label)).toEqual(['3', null, '4']);
  });

  it('leaves an ungrouped card without a number and without a line', () => {
    expect(cells([1, 1, null])).toEqual([
      { label: '1', endsSegment: false },
      { label: null, endsSegment: true },
      null,
    ]);
    expect(cells([null, null])).toEqual([null, null]);
  });
});

describe('#1130 stage 3: one component draws it, and decides none of it', () => {
  it('keeps the iteration arithmetic out of the component', () => {
    for (const forbidden of ['Math.floor', 'iterations', 'repeats', 'REPEATED_CYCLE']) {
      expect(componentSrc, `the shared section must not decide "${forbidden}"`).not.toContain(forbidden);
    }
    // The marker's sentence — and its glyph — is each card's own locale key.
    for (const glyph of ['↻', '✓']) {
      expect(componentSrc).not.toContain(glyph);
      expect(plansSrc).not.toContain(glyph);
      expect(assignedSrc).not.toContain(glyph);
    }
  });

  it('borrows the fee table’s two cycle values rather than spelling a colour', () => {
    expect(componentSrc).toContain('TIMELINE_CYCLE_LINE');
    expect(componentSrc).toContain('TIMELINE_CYCLE_TEXT');
    // No hex of its own anywhere in the grouping it added.
    for (const decl of ['cycleRow', 'cycleGutter', 'cycleNumber', 'cycleNoteStyle']) {
      const block = componentSrc.split(`const ${decl}: React.CSSProperties = {`)[1]?.split('};')[0];
      expect(block, `${decl} must be declared`).toBeTruthy();
      expect(block, `${decl} must not spell a colour`).not.toMatch(/#[0-9a-fA-F]{3,6}/);
      // §2 — no bordered container around the cards, and no divider between the
      // two iterations: the cards themselves are the only visual.
      expect(block, `${decl} must not draw a border`).not.toContain('border');
    }
    for (const src of [plansSrc, assignedSrc]) {
      expect(src, 'a card must not spell the cycle line’s colour').not.toContain('TIMELINE_CYCLE_LINE');
    }
  });

  it('keeps the cards as cards: no table and no wrapper the cards did not have', () => {
    // The only table in the section is the one inside an expanded card, which
    // #955 put there; the grouping adds no second one.
    expect(componentSrc.match(/<table/g)?.length).toBe(1);
    expect(componentSrc).not.toContain('cycleTable');
  });

  it('reads the gutter’s accessible name from the page’s own key', () => {
    expect(componentSrc).toContain("t('col_cycle')");
  });

  it('is rendered by both cards, which hand it the marker', () => {
    for (const [name, src] of [['the Plan card', plansSrc], ['the Assigned Plan card', assignedSrc]] as const) {
      const section = src.split('<BillingEventSimulation')[1]?.split('/>')[0];
      expect(section, `${name} must render the section`).toBeTruthy();
      expect(section, `${name} must pass the marker`).toContain('cycleNote=');
    }
    expect(plansSrc).toContain('planTimelineCycleNoteKey(plan.billing_event_simulation?.cycle)');
    expect(assignedSrc).toContain('exampleTimelineCycleNote(detail.billing_event_simulation?.cycle');
  });

  it('keeps the grouping rule in the one JSX-free module', () => {
    const lib = read(LIB);
    expect(lib).toContain('export function billingEventCycleCells(');
    expect(lib).not.toContain('useTranslations');
    expect(lib).not.toContain('</');
  });
});
