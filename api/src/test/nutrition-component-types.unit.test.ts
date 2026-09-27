import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TEMPLATE_COMPONENT_TYPES,
  MEMBER_PLAN_COMPONENT_TYPES,
  isComponentType,
} from '../domain/nutritionComponentTypes';

/**
 * #812 — the Food Type (`component_type`) sets.
 *
 * The bug this ticket fixes was a frontend one, but it was only visible because
 * nothing tied the options the UI offers to the values the database accepts.
 * These tests tie the two together: each set is checked against the CHECK
 * constraint that enforces it, so widening one without the other fails here
 * rather than at INSERT time (a CHECK violation) or in the browser (a 400).
 */

const MIGRATIONS = join(__dirname, '..', 'infra', 'migrations');

/** The slugs inside `CHECK (component_type IN ('a','b',…))`, in declared order. */
function checkedTypes(file: string, constraint: string): string[] {
  const src = readFileSync(join(MIGRATIONS, file), 'utf-8');
  // The last definition in the file is the one the migration leaves behind:
  // 111 drops and re-adds the constraint in up(), and down() restores the old
  // list further down, so scope the search to up().
  const up = src.slice(0, src.indexOf('exports.down'));
  const at = up.lastIndexOf(constraint);
  expect(at, `${constraint} not found in ${file} up()`).toBeGreaterThan(-1);
  const tail = up.slice(at);
  const match = tail.match(/CHECK\s*\(component_type IN \(([^)]*)\)\)/);
  expect(match, `no component_type CHECK after ${constraint} in ${file}`).toBeTruthy();
  return match![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

describe('#812 component_type sets match their CHECK constraints', () => {
  it('a template meal item takes all seven (chk_nptmi_component_type, migration 111)', () => {
    expect([...TEMPLATE_COMPONENT_TYPES]).toEqual(
      checkedTypes('111_meal_item_component_type.js', 'chk_nptmi_component_type'),
    );
  });

  it('an assigned plan meal item takes four (chk_mnpmi_comp, migration 105)', () => {
    expect([...MEMBER_PLAN_COMPONENT_TYPES]).toEqual(
      checkedTypes('105_base_nutrition.js', 'chk_mnpmi_comp'),
    );
  });

  it('the assigned-plan set is narrower — #294 widened the template table only', () => {
    expect([...MEMBER_PLAN_COMPONENT_TYPES].every((c) =>
      (TEMPLATE_COMPONENT_TYPES as readonly string[]).includes(c))).toBe(true);
    for (const onlyOnTemplates of ['drink', 'dessert', 'other']) {
      expect(TEMPLATE_COMPONENT_TYPES as readonly string[]).toContain(onlyOnTemplates);
      expect(MEMBER_PLAN_COMPONENT_TYPES as readonly string[]).not.toContain(onlyOnTemplates);
    }
  });

  it('every slug has a Food Type label in all three locales', () => {
    // The selector renders `tree_component_type_<slug>`; next-intl prints a
    // missing key verbatim, which is how `…_undefined` reached the screen.
    for (const locale of ['en', 'es', 'ca']) {
      const messages = JSON.parse(
        readFileSync(join(__dirname, '..', '..', '..', 'apps', 'admin', 'locales', 'base', `${locale}.json`), 'utf-8'),
      );
      const section = messages.nutrition_plan_templates ?? {};
      for (const slug of TEMPLATE_COMPONENT_TYPES) {
        expect(section[`tree_component_type_${slug}`], `${locale}: ${slug}`).toBeTruthy();
      }
    }
  });
});

describe('#812 isComponentType', () => {
  it('accepts a member of the set', () => {
    expect(isComponentType(MEMBER_PLAN_COMPONENT_TYPES, 'main_dish')).toBe(true);
    expect(isComponentType(TEMPLATE_COMPONENT_TYPES, 'dessert')).toBe(true);
  });

  it('refuses a value the surface does not accept', () => {
    // The exact case the narrower CHECK exists for.
    expect(isComponentType(MEMBER_PLAN_COMPONENT_TYPES, 'dessert')).toBe(false);
  });

  it('refuses a missing, empty or non-string value without throwing', () => {
    // It replaces `!component_type || !…includes(component_type)`, so it has to
    // be false for everything that guard caught.
    for (const bad of [undefined, null, '', 0, false, [], {}, 'MAIN_DISH', 'undefined']) {
      expect(isComponentType(TEMPLATE_COMPONENT_TYPES, bad)).toBe(false);
    }
  });
});
