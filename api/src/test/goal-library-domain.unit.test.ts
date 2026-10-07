import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  GOAL_LIBRARY_AUDIT_ENTITIES,
  GOAL_LIBRARY_KINDS,
  GOAL_LIBRARY_TABLES,
  GOAL_NAME_MAX_LENGTH,
  GOAL_STATUSES,
  SYSTEM_GOALS,
  SYSTEM_NUTRITION_GOALS,
  SYSTEM_PERSONAL_GOALS,
  buildGoalListWhere,
  isGoalLibraryKind,
  normalizeGoalName,
  GYM_CONFIGURABLE_GOAL_KINDS,
  goalKindIsGymConfigurable,
  gymGoalStatusSql,
} from '../domain/goalLibrary';
import { AUDIT_ENTITY_REGISTRY } from '../infra/audit-registry';

// #947 — the goal catalogues' pure half: the declarations migration 206 mirrors,
// the name rule both routers validate with, and the shared search predicate.
// No DB and no HTTP, so no helpers and no cleanup (CLAUDE.md: unit vs integration).

const migration = require(
  join(__dirname, '..', 'infra', 'migrations', '206_goal_library.js'),
) as {
  TABLES: Record<string, string>;
  STATUSES: string[];
  SEEDS: Record<string, { slug: string; name: string }[]>;
};

describe('goal library declarations', () => {
  it('has exactly two kinds, and they are not interchangeable', () => {
    expect(GOAL_LIBRARY_KINDS).toEqual(['personal', 'nutrition']);
    expect(isGoalLibraryKind('personal')).toBe(true);
    expect(isGoalLibraryKind('nutrition')).toBe(true);
    // §8: Personal Goals and Nutrition Goals are not synonyms, and nothing may
    // address them as one list.
    expect(isGoalLibraryKind('goal')).toBe(false);
    expect(isGoalLibraryKind(undefined)).toBe(false);
  });

  it('keys one table per kind, matching migration 206', () => {
    expect(GOAL_LIBRARY_TABLES).toEqual({ personal: 'personal_goals', nutrition: 'nutrition_goals' });
    expect(Object.keys(migration.TABLES).sort()).toEqual(
      Object.values(GOAL_LIBRARY_TABLES).sort(),
    );
  });

  it('declares the same statuses the CHECK permits', () => {
    expect([...GOAL_STATUSES]).toEqual(migration.STATUSES);
  });

  it('registers an audit entity for each kind', () => {
    for (const kind of GOAL_LIBRARY_KINDS) {
      const entityType = GOAL_LIBRARY_AUDIT_ENTITIES[kind];
      // Without a registry entry the audit rows write but carry no entity_name and
      // the type never reaches the Audit Log's entity-type filter (CLAUDE.md).
      const entry = AUDIT_ENTITY_REGISTRY[entityType];
      expect(entry, `${entityType} is missing from AUDIT_ENTITY_REGISTRY`).toBeDefined();
      expect(entry.kind).toBe('simple');
      expect((entry as { table: string }).table).toBe(GOAL_LIBRARY_TABLES[kind]);
    }
  });

  it('seeds the System rows migration 206 inserts, in the same order', () => {
    expect(SYSTEM_GOALS.personal).toBe(SYSTEM_PERSONAL_GOALS);
    expect(SYSTEM_GOALS.nutrition).toBe(SYSTEM_NUTRITION_GOALS);
    for (const kind of GOAL_LIBRARY_KINDS) {
      expect(migration.SEEDS[GOAL_LIBRARY_TABLES[kind]]).toEqual(
        SYSTEM_GOALS[kind].map((g) => ({ slug: g.slug, name: g.name })),
      );
    }
  });

  it('partitions the Nutrition Plan goal vocabulary between the two kinds, plus fasting', () => {
    // The slugs are deliberately the ones the Nutrition Plan routers already
    // validate `item_name` against, so a later ticket can link a plan's goal to
    // its catalogue row without renaming anything.
    const planGoals = [
      'protein', 'water', 'calories', 'carbohydrates', 'fats', 'fiber',
      'weight_loss', 'weight_gain', 'muscle_gain', 'maintenance',
      'performance', 'recovery', 'energy',
    ];
    const catalogued = [
      ...SYSTEM_PERSONAL_GOALS.map((g) => g.slug),
      ...SYSTEM_NUTRITION_GOALS.map((g) => g.slug),
    ];
    expect([...catalogued].sort()).toEqual([...planGoals, 'fasting'].sort());
    // No slug belongs to both catalogues — a goal is one concept or the other.
    expect(new Set(catalogued).size).toBe(catalogued.length);
  });
});

describe('normalizeGoalName', () => {
  it('trims and accepts a name', () => {
    expect(normalizeGoalName('  Muscle Gain  ', { required: true })).toEqual({ value: 'Muscle Gain' });
  });

  it('refuses a missing or blank name when one is required', () => {
    expect(normalizeGoalName(undefined, { required: true })).toEqual({ error: 'name is required' });
    expect(normalizeGoalName('   ', { required: true })).toEqual({ error: 'name is required' });
    expect(normalizeGoalName(null, { required: true })).toEqual({ error: 'name is required' });
  });

  it('reads an absent name as "leave it alone" on a partial update', () => {
    expect(normalizeGoalName(undefined, { required: false })).toEqual({ value: undefined });
    expect(normalizeGoalName(null, { required: false })).toEqual({ value: undefined });
  });

  it('still refuses a blank name on an update — the column is NOT NULL', () => {
    expect(normalizeGoalName('', { required: false })).toEqual({ error: 'name is required' });
  });

  it('refuses a non-string and a name past the column width', () => {
    expect(normalizeGoalName(7, { required: true })).toEqual({ error: 'name must be a string' });
    expect(normalizeGoalName('x'.repeat(GOAL_NAME_MAX_LENGTH), { required: true }))
      .toEqual({ value: 'x'.repeat(GOAL_NAME_MAX_LENGTH) });
    expect(normalizeGoalName('x'.repeat(GOAL_NAME_MAX_LENGTH + 1), { required: true }))
      .toEqual({ error: `name must be at most ${GOAL_NAME_MAX_LENGTH} characters` });
  });
});

describe('buildGoalListWhere', () => {
  it('returns the base predicate unchanged with no search term', () => {
    expect(buildGoalListWhere(undefined, ['g.gym_id IS NULL'], [])).toEqual({
      where: 'g.gym_id IS NULL',
      params: [],
    });
    expect(buildGoalListWhere('   ', ['g.gym_id IS NULL'], [])).toEqual({
      where: 'g.gym_id IS NULL',
      params: [],
    });
  });

  it('matches the name and the slug, parameterised', () => {
    const built = buildGoalListWhere('wat', ['g.gym_id = ?'], ['gym-1']);
    expect(built.where).toBe('g.gym_id = ? AND (g.name LIKE ? OR g.slug LIKE ?)');
    expect(built.params).toEqual(['gym-1', '%wat%', '%wat%']);
  });

  it('never interpolates the term into the SQL', () => {
    const built = buildGoalListWhere("'; DROP TABLE personal_goals; --", ['1 = 1']);
    expect(built.where).not.toContain('DROP');
    expect(built.params).toEqual(["%'; DROP TABLE personal_goals; --%", "%'; DROP TABLE personal_goals; --%"]);
  });
});


describe('per-gym configurable kinds (#1181)', () => {
  it('is exactly Personal Goals, and the SQL reads a missing row as active', () => {
    expect([...GYM_CONFIGURABLE_GOAL_KINDS]).toEqual(['personal']);
    expect(goalKindIsGymConfigurable('personal')).toBe(true);
    expect(goalKindIsGymConfigurable('nutrition')).toBe(false);
    const sql = gymGoalStatusSql('g');
    expect(sql).toContain("COALESCE((SELECT gpg.status FROM gym_personal_goals gpg");
    expect(sql).toContain('gpg.personal_goal_id = g.id AND gpg.gym_id = ?');
    expect(sql.trim().endsWith("'active')")).toBe(true);
    // Exactly one bind, the gym's, so a caller adds one parameter per use.
    expect(sql.match(/\?/g)).toHaveLength(1);
  });
});
