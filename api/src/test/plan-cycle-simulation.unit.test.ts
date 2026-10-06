// #1130 stage 2 — the Membership Fee Simulation says which iteration a row
// belongs to, and whether the cycle starts again.
//
// Stage 1 (#1170) made the contract's Free -> Pre-paid -> Paid -> Bonus stretch
// a **cycle** and taught the walk to stop after two complete iterations of a
// repeating one. The table still read as one undifferentiated run of periods,
// which is the ticket's own complaint: "it can appear the bonus happens only
// once rather than being part of a recurring pattern".
//
// So this stage is presentation, and the thing worth gating is that it stays
// presentation. Every number it draws is the engine's: how long one iteration
// is and whether it repeats are `timelineCycleFor()`'s answers, reported on the
// projection, and the per-row grouping is arithmetic over the period numbers
// the server already assigned. A card that counted its own iterations could
// group rows the nightly run bills differently — the drift #635 stage 12 exists
// to prevent — and nothing at runtime would notice: the table would simply draw
// a tidy second cycle that is not billed.
//
// It lives in the API suite for #1009's reason: CI runs `npm test` in `api/`
// only (the admin job type-checks and builds).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REPEATED_CYCLE_ITERATIONS, timelineCycleFor } from '../domain/exampleTimeline';
import { computePlanExampleTimeline } from '../domain/planExampleTimeline';
import { PlanDurationCadence, toPlanDuration } from '../domain/planDuration';
import {
  exampleTimelineCycleNote,
  exampleTimelineRowCycle,
  exampleTimelineRowCycles,
} from '../../../apps/admin/src/lib/exampleTimeline';

const REPO = join(__dirname, '..', '..', '..');
const ADMIN = join(REPO, 'apps', 'admin');
const LOCALES = ['en', 'es', 'ca'] as const;

const SHARED_TABLE = join(ADMIN, 'src', 'components', 'ExampleTimeline.tsx');
const SHARED_LIB = join(ADMIN, 'src', 'lib', 'exampleTimeline.ts');
const PLANS_PAGE = join(ADMIN, 'src', 'app', '[locale]', 'plans', 'page.tsx');
const ASSIGNED_CARD = join(ADMIN, 'src', 'components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx');

const read = (path: string) => readFileSync(path, 'utf-8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const tableSrc = stripComments(read(SHARED_TABLE));
const plansSrc = stripComments(read(PLANS_PAGE));
const assignedSrc = stripComments(read(ASSIGNED_CARD));

function namespace(code: string, name: 'plans' | 'assigned_plans_page'): Record<string, string> {
  const messages = JSON.parse(read(join(ADMIN, 'locales', 'base', `${code}.json`)));
  return (messages[name] ?? {}) as Record<string, string>;
}

const MONTH: PlanDurationCadence = { interval: 1, unit: 'month' };
const duration = (d: { free?: number; paid?: number; bonus?: number; repeats?: boolean }) =>
  toPlanDuration(d.free ?? 0, d.paid ?? 0, d.bonus ?? 0, 0, MONTH, d.repeats ?? false);

/** Period numbers 1..n, the shape the projection hands the card. */
const periods = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ period: from + i }));

describe('#1130 stage 2: the engine reports the cycle, the card never derives it', () => {
  it('reports a repeating cycle’s length and the iterations shown', () => {
    expect(timelineCycleFor(duration({ free: 1, paid: 2, bonus: 1, repeats: true })))
      .toEqual({ length: 4, repeats: true, iterations: REPEATED_CYCLE_ITERATIONS });
  });

  // Stage 2 reports a non-repeating cycle too: `1` beside the configured
  // stretch and "One cycle only" under it is what such a contract has to say.
  it('reports a cycle that does not repeat as one iteration', () => {
    expect(timelineCycleFor(duration({ free: 1, paid: 2, bonus: 1 })))
      .toEqual({ length: 4, repeats: false, iterations: 1 });
  });

  it('reports no cycle for a contract with nothing configured', () => {
    expect(timelineCycleFor(duration({ repeats: true }))).toBeNull();
    expect(timelineCycleFor(duration({}))).toBeNull();
  });

  it('carries the cycle on the projection the card reads', () => {
    const repeating = computePlanExampleTimeline({
      duration: duration({ free: 1, paid: 2, bonus: 1, repeats: true }),
      cadence: MONTH, priceInclTax: 60, anchorDate: '2026-01-01',
    });
    expect(repeating.cycle).toEqual({ length: 4, repeats: true, iterations: 2 });
    expect(repeating.periods).toHaveLength(8);

    const once = computePlanExampleTimeline({
      duration: duration({ free: 1, paid: 2, bonus: 1 }),
      cadence: MONTH, priceInclTax: 60, anchorDate: '2026-01-01',
    });
    expect(once.cycle).toEqual({ length: 4, repeats: false, iterations: 1 });
    // Stage 1's stopping rule is untouched for it: the cycle, then the two
    // trailing regular periods that say the contract keeps billing.
    expect(once.periods.map((p) => p.status)).toEqual([
      'free_plan', 'pay_plan', 'pay_plan', 'bonus_plan', 'pay_regular', 'pay_regular',
    ]);
  });

  it('reports no cycle on a projection that is not available at all', () => {
    const none = computePlanExampleTimeline({
      duration: duration({ free: 1, paid: 2, repeats: true }),
      cadence: null, priceInclTax: 60,
    });
    expect(none.available).toBe(false);
    expect(none.cycle).toBeNull();
  });
});

describe('#1130 stage 2: which iteration a row belongs to', () => {
  const repeating = { length: 4, repeats: true, iterations: 2 };

  it('numbers each iteration on its first row and nowhere else', () => {
    const cells = exampleTimelineRowCycles(periods(1, 8), repeating);
    expect(cells.map((c) => c?.label ?? null)).toEqual(['1', null, null, null, '2', null, null, null]);
  });

  // The ticket's rule: a thin line per iteration, and the two must not touch.
  // The gap is the segment ending on an iteration's last row.
  it('ends a segment on the last row of each iteration, so the lines do not touch', () => {
    const cells = exampleTimelineRowCycles(periods(1, 8), repeating);
    expect(cells.map((c) => c?.endsSegment ?? null))
      .toEqual([false, false, false, true, false, false, false, true]);
  });

  it('gives a non-repeating cycle’s trailing regular rows no number and no line', () => {
    const cells = exampleTimelineRowCycles(periods(1, 6), { length: 4, repeats: false, iterations: 1 });
    expect(cells.map((c) => c?.label ?? null)).toEqual(['1', null, null, null, null, null]);
    expect(cells.slice(4).every((c) => c === null)).toBe(true);
    // The configured stretch still closes its own line.
    expect(cells[3]?.endsSegment).toBe(true);
  });

  it('groups nothing when there is no cycle', () => {
    expect(exampleTimelineRowCycles(periods(1, 3), null)).toEqual([null, null, null]);
    expect(exampleTimelineRowCycles(periods(1, 3), { length: 0, repeats: true, iterations: 2 }))
      .toEqual([null, null, null]);
  });

  // An Assigned Plan's table starts at the period containing *today*, so a
  // contract already past its first cycle reads the iteration it really is in
  // rather than being relabelled `1`.
  it('names the real iteration when the table starts mid-cycle', () => {
    const cells = exampleTimelineRowCycles(periods(10, 4), repeating);
    expect(cells.map((c) => c?.label ?? null)).toEqual(['3', null, null, '4']);
    expect(cells[2]?.endsSegment).toBe(true);
  });

  it('answers nothing for an index the projection does not hold', () => {
    expect(exampleTimelineRowCycle(periods(1, 2), repeating, 5)).toBeNull();
  });
});

describe('#1130 stage 2: which marker goes under the table', () => {
  it('is the cycle’s own answer, and null where there is no cycle', () => {
    expect(exampleTimelineCycleNote({ length: 4, repeats: true, iterations: 2 })).toBe('repeats');
    expect(exampleTimelineCycleNote({ length: 4, repeats: false, iterations: 1 })).toBe('once');
    expect(exampleTimelineCycleNote(null)).toBeNull();
    expect(exampleTimelineCycleNote({ length: 0, repeats: true, iterations: 2 })).toBeNull();
  });
});

describe('#1130 stage 2: one table draws it, and decides none of it', () => {
  it('adds the Cycle column to the left of Period', () => {
    const headers = [...tableSrc.matchAll(/\{labels\.(\w+)\}/g)].map((m) => m[1]);
    expect(headers).toEqual(['cycle', 'period', 'dates', 'status', 'billing']);
  });

  it('keeps the grouping out of the table: no iteration arithmetic, no marker choice', () => {
    for (const forbidden of ['Math.floor', 'iterations', 'repeats', 'REPEATED_CYCLE']) {
      expect(tableSrc, `the shared table must not decide "${forbidden}"`).not.toContain(forbidden);
    }
    // The marker's sentence — and its glyph — is each card's locale key.
    for (const glyph of ['↻', '✓']) {
      expect(tableSrc).not.toContain(glyph);
      expect(plansSrc).not.toContain(glyph);
      expect(assignedSrc).not.toContain(glyph);
    }
  });

  it('adds no horizontal divider between the iterations', () => {
    expect(tableSrc).not.toContain('borderTop');
  });

  it('is rendered by both cards from the shared rules', () => {
    for (const [name, src] of [['the Plan card', plansSrc], ['the Assigned Plan card', assignedSrc]] as const) {
      expect(src, `${name} must ask the shared per-row rule`).toMatch(/RowCycle\(/);
      expect(src, `${name} must pass the marker to the table`).toContain('cycleNote=');
      expect(src, `${name} must not count iterations itself`).not.toContain('REPEATED_CYCLE');
    }
    // Both ask one rule for the marker's kind: the Plan card through its own
    // key map, the Assigned Plan card through the lib directly.
    expect(plansSrc).toContain('planTimelineCycleNoteKey(');
    expect(assignedSrc).toContain('exampleTimelineCycleNote(');
  });

  it('declares the cycle’s own two values once, beside the table’s tones', () => {
    expect(stripComments(read(SHARED_TABLE))).toContain('TIMELINE_CYCLE_LINE');
    for (const src of [plansSrc, assignedSrc]) {
      expect(src, 'a card must not spell the cycle line’s colour').not.toContain('TIMELINE_CYCLE_LINE');
    }
  });

  it('keeps the grouping rules in the one JSX-free module', () => {
    const lib = read(SHARED_LIB);
    expect(lib).toContain('export function exampleTimelineRowCycle(');
    expect(lib).toContain('export function exampleTimelineCycleNote(');
    // JSX-free, so a page's own declaration module can import it: no React, no
    // markup, no `t()`.
    expect(lib).not.toContain('useTranslations');
    expect(lib).not.toContain('react');
    expect(lib).not.toContain('</');
  });
});

describe('#1130 stage 2: both cards say it in all three languages', () => {
  const KEYS = ['col_cycle', 'timeline_cycle_repeats', 'timeline_cycle_once'] as const;

  it('translates the column and both markers in both namespaces', () => {
    for (const code of LOCALES) {
      for (const ns of ['plans', 'assigned_plans_page'] as const) {
        for (const key of KEYS) {
          expect(namespace(code, ns)[key], `${ns}.${key} missing from ${code}.json`).toBeTruthy();
        }
      }
    }
  });

  it('carries the ticket’s own glyphs and English wording', () => {
    for (const ns of ['plans', 'assigned_plans_page'] as const) {
      expect(namespace('en', ns).col_cycle).toBe('Cycle');
      expect(namespace('en', ns).timeline_cycle_repeats).toBe('↻ Repeats indefinitely');
      expect(namespace('en', ns).timeline_cycle_once).toBe('✓ One cycle only — no renewal');
      for (const code of LOCALES) {
        expect(namespace(code, ns).timeline_cycle_repeats).toContain('↻');
        expect(namespace(code, ns).timeline_cycle_once).toContain('✓');
      }
    }
  });
});
