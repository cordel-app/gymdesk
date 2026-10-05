import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  TARGET_UNIT_MAX_LENGTH,
  TARGET_VALUE_MAX,
  normalizeTargetUnit,
  normalizeTargetValue,
  targetPairError,
} from '../domain/goalTarget';
import {
  MEASURABLE_GOAL_KINDS,
  SYSTEM_PERSONAL_GOALS,
  SYSTEM_PERSONAL_GOAL_TARGETS,
  isMeasurableGoalKind,
} from '../domain/goalLibrary';
import {
  normalizeTargetUnit as assignmentUnit,
  normalizeTargetValue as assignmentValue,
} from '../domain/personalGoalAssignment';

/**
 * #1034 — what a **goal target** is, now that both a Personal Goal in the
 * catalogue and the assignment a member holds carry one.
 *
 * Pure: no DB and no HTTP, so no helpers and no cleanup (CLAUDE.md: unit vs
 * integration).
 */

const migration = require(
  join(__dirname, '..', 'infra', 'migrations', '218_personal_goal_targets.js'),
) as { SEED_TARGETS: Record<string, { value: number; unit: string }> };

const migrationSrc = readFileSync(
  join(__dirname, '..', 'infra', 'migrations', '218_personal_goal_targets.js'),
  'utf8',
);

describe('one declaration of a goal target (#1034 §1)', () => {
  it('is the very same normalizer on both sides', () => {
    // §1: "do not introduce a second, incompatible unit system". The assignment
    // module re-exports rather than re-implementing, so a target the catalogue
    // accepts can never be refused by the assignment and vice versa.
    expect(assignmentValue).toBe(normalizeTargetValue);
    expect(assignmentUnit).toBe(normalizeTargetUnit);
  });

  it('bounds the pair to the columns migrations 212 and 218 declare', () => {
    expect(TARGET_UNIT_MAX_LENGTH).toBe(20);
    expect(TARGET_VALUE_MAX).toBe(99999999.99);
    expect(migrationSrc).toContain('target_value DECIMAL(10,2) NULL');
    expect(migrationSrc).toContain('target_unit VARCHAR(20) NULL');
  });

  it('names exactly one measurable kind, and `nutrition_goals` is not it', () => {
    // CLAUDE.md: a Nutrition Goal's own target values are a later ticket's, and
    // the table has no such columns — a router projecting them would 500.
    expect([...MEASURABLE_GOAL_KINDS]).toEqual(['personal']);
    expect(isMeasurableGoalKind('personal')).toBe(true);
    expect(isMeasurableGoalKind('nutrition')).toBe(false);
    // The migration only ever touches `personal_goals`; the mention of the
    // other catalogue in its header is prose explaining why.
    expect(migrationSrc).not.toMatch(/ALTER TABLE \$?\{?\w*nutrition_goals/);
    expect(migrationSrc).toContain("const GOAL_TABLE = 'personal_goals';");
  });
});

describe('normalizeTargetValue', () => {
  it('reads an absent value as "leave it alone" and an empty one as a clear', () => {
    expect(normalizeTargetValue(undefined)).toEqual({ value: undefined });
    expect(normalizeTargetValue(null)).toEqual({ value: null });
    expect(normalizeTargetValue('')).toEqual({ value: null });
  });

  it('accepts a number or its string form, zero included', () => {
    expect(normalizeTargetValue(3)).toEqual({ value: 3 });
    expect(normalizeTargetValue('70')).toEqual({ value: 70 });
    // Maintenance's own target: a change of zero is the goal, not a blank.
    expect(normalizeTargetValue(0)).toEqual({ value: 0 });
  });

  it('rounds to the column\'s own scale rather than refusing', () => {
    expect(normalizeTargetValue(5.005)).toEqual({ value: 5.01 });
    expect(normalizeTargetValue(5.004)).toEqual({ value: 5 });
  });

  it('refuses a negative, a non-numeric and a value past the column', () => {
    expect(normalizeTargetValue(-1)).toHaveProperty('error');
    expect(normalizeTargetValue('abc')).toHaveProperty('error');
    expect(normalizeTargetValue(true)).toHaveProperty('error');
    expect(normalizeTargetValue(Infinity)).toHaveProperty('error');
    expect(normalizeTargetValue(TARGET_VALUE_MAX + 1)).toHaveProperty('error');
    expect(normalizeTargetValue(TARGET_VALUE_MAX)).toEqual({ value: TARGET_VALUE_MAX });
  });
});

describe('normalizeTargetUnit', () => {
  it('trims, reads a blank as a clear, and keeps the field free text', () => {
    expect(normalizeTargetUnit(' kg ')).toEqual({ value: 'kg' });
    expect(normalizeTargetUnit('   ')).toEqual({ value: null });
    expect(normalizeTargetUnit(null)).toEqual({ value: null });
    expect(normalizeTargetUnit(undefined)).toEqual({ value: undefined });
    // §1: there is no unit vocabulary to validate against, and inventing one
    // here would be the second system the ticket forbids — a gym measuring in
    // `lb`, `mmol/L` or `laps` is not an error.
    expect(normalizeTargetUnit('laps')).toEqual({ value: 'laps' });
    expect(normalizeTargetUnit('%')).toEqual({ value: '%' });
  });

  it('refuses a non-string and a unit past the column width', () => {
    expect(normalizeTargetUnit(3)).toHaveProperty('error');
    expect(normalizeTargetUnit('x'.repeat(TARGET_UNIT_MAX_LENGTH))).toEqual({
      value: 'x'.repeat(TARGET_UNIT_MAX_LENGTH),
    });
    expect(normalizeTargetUnit('x'.repeat(TARGET_UNIT_MAX_LENGTH + 1))).toHaveProperty('error');
  });
});

describe('targetPairError', () => {
  it('refuses a unit with nothing to qualify, in that one direction only', () => {
    expect(targetPairError({ targetValue: null, targetUnit: 'kg' })).toBeTruthy();
    // "lose 5" is incomplete, not contradictory — the same one direction
    // `chk_pgoal_target_unit` and `chk_mpgoal_target_unit` check.
    expect(targetPairError({ targetValue: 5, targetUnit: null })).toBeNull();
    expect(targetPairError({ targetValue: 5, targetUnit: 'kg' })).toBeNull();
    expect(targetPairError({ targetValue: null, targetUnit: null })).toBeNull();
    // Zero is a value, so it carries a unit.
    expect(targetPairError({ targetValue: 0, targetUnit: 'kg' })).toBeNull();
  });
});

describe('the seeded System targets (#1034 §2)', () => {
  it('mirrors migration 218\'s own map', () => {
    expect(SYSTEM_PERSONAL_GOAL_TARGETS).toEqual(migration.SEED_TARGETS);
  });

  it('names only seeded Personal Goal slugs', () => {
    const slugs = SYSTEM_PERSONAL_GOALS.map((g) => g.slug);
    for (const slug of Object.keys(SYSTEM_PERSONAL_GOAL_TARGETS)) {
      expect(slugs).toContain(slug);
    }
  });

  it('gives no two goals the same generic target, and the unmeasurable ones none', () => {
    // §2: "do not apply the same generic target to every goal". The three that
    // carry no magnitude or unit that follows from what they represent get none
    // at all — §13 requires a unit only "for measurable goals".
    expect(Object.keys(SYSTEM_PERSONAL_GOAL_TARGETS).sort()).toEqual(
      ['maintenance', 'muscle_gain', 'weight_gain', 'weight_loss'],
    );
    for (const slug of ['performance', 'recovery', 'energy']) {
      expect(SYSTEM_PERSONAL_GOAL_TARGETS[slug]).toBeUndefined();
    }
    // Every seeded pair is one the normalizers accept, so the seed can never
    // write a row the routers would then refuse to save.
    for (const { value, unit } of Object.values(SYSTEM_PERSONAL_GOAL_TARGETS)) {
      expect(normalizeTargetValue(value)).toEqual({ value });
      expect(normalizeTargetUnit(unit)).toEqual({ value: unit });
      expect(targetPairError({ targetValue: value, targetUnit: unit })).toBeNull();
    }
  });

  it('fills a System row only while it has no target of its own', () => {
    // A value Cordel has since changed is never overwritten, and a re-run is a
    // no-op: the UPDATE is keyed on both columns still being NULL.
    expect(migrationSrc).toContain('AND gym_id IS NULL AND target_value IS NULL AND target_unit IS NULL');
  });
});

describe('the assignment\'s goal-name snapshot (#1034 §7/§12)', () => {
  it('is a nullable column with no backfill, and the live name is its fallback', () => {
    expect(migrationSrc).toContain('ADD COLUMN goal_name VARCHAR(255) NULL');
    // #635 §16's shape: a row assigned before this migration has no snapshot to
    // recover, so writing today's name into it would claim a fact the database
    // never recorded.
    expect(migrationSrc).not.toMatch(/UPDATE member_personal_goals[\s\S]*SET goal_name/);
    const router = readFileSync(join(__dirname, '..', 'api', 'member-personal-goals.ts'), 'utf8');
    expect(router).toContain('COALESCE(mpg.goal_name, pg.name) AS goal_name');
    expect(router).not.toContain('pg.name AS goal_name');
  });

  it('is written by every insert path, since the column cannot enforce it itself', () => {
    // It must stay nullable for ever (a legacy row has no snapshot, and no
    // DEFAULT can read another table), so the invariant lives in the writers —
    // the shape `snapshotAssignedPlan()`'s rule has, and the reason it is gated
    // here: a bulk assign or an import that omitted it would read back
    // plausibly and only drift the first time somebody renamed the goal.
    const inserts: string[] = [];
    for (const dir of ['api', 'domain', 'infra', 'scripts']) {
      const base = join(__dirname, '..', dir);
      if (!existsSync(base)) continue;
      for (const file of walk(base)) {
        const src = readFileSync(file, 'utf8');
        for (const match of src.matchAll(/INSERT INTO member_personal_goals[\s\S]{0,400}?\)/g)) {
          inserts.push(`${file}: ${match[0]}`);
        }
      }
    }
    // The one path that creates an assignment today.
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) {
      expect(insert, `an INSERT that does not snapshot goal_name: ${insert}`).toContain('goal_name');
    }
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}
