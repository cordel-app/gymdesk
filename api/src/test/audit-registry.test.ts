// Unit test for audit-registry.ts (#675) — no DB, no HTTP.
//
// The Audit Log's entity-type filter is built from AUDIT_ENTITY_REGISTRY
// (`GET /audit-logs/meta`), and #675 deep-links every entity's Details view into
// that filter. An entity type a router writes but the registry does not know
// resolves no entity_name and is missing from the dropdown the deep link
// preselects, so every Details view's entity type must be registered — and must
// point at the table and name column that actually back it.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { AUDIT_ENTITY_REGISTRY } from '../infra/audit-registry';

/** Entity types reachable from a Details view, with the table backing each. */
const DETAILS_VIEW_ENTITIES: Record<string, string | null> = {
  member: 'members',
  membership_plan: 'membership_plans',
  promotion: 'promotions',
  exercise: 'exercises',
  workout_template: 'workout_templates',
  training_plan: 'training_plans',
  training_plan_template: 'training_plan_templates',
  center: 'centers',
  space: 'spaces',
  gym: 'gyms',
  activity_type: 'activity_types',
  theme: 'themes',
  tax_rate: 'tax_rates',
  gym_charge: 'gym_charges',
  professional_service: 'professional_services',
  nutrition_library_item: 'nutrition_library_items',
  nutrition_plan_template: 'nutrition_plan_templates',
  member_nutrition_plan: 'member_nutrition_plans',
  // #636: Cordel → Payment Providers.
  payment_provider: 'payment_providers',
  // Composed entries resolve their display name with a join, not one column.
  user_membership: null,
  billing_event: null,
  staff: null,
};

function routerSources(): { file: string; src: string }[] {
  const dir = join(__dirname, '..', 'api');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({ file, src: readFileSync(join(dir, file), 'utf-8') }));
}

describe('audit entity registry (#675)', () => {
  it.each(Object.entries(DETAILS_VIEW_ENTITIES))(
    'registers "%s" so the Audit Log filter can preselect it',
    (entityType, table) => {
      const meta = AUDIT_ENTITY_REGISTRY[entityType];
      expect(meta, `"${entityType}" is deep-linked from a Details view but is not registered`).toBeDefined();
      expect(meta.label.length, `"${entityType}" needs a human label for the filter dropdown`).toBeGreaterThan(0);

      if (table === null) {
        expect(meta.kind, `"${entityType}" resolves its name with a join`).toBe('composed');
      } else {
        expect(meta.kind).toBe('simple');
        expect((meta as { table: string }).table).toBe(table);
        expect((meta as { nameColumn: string }).nameColumn).toBe('name');
      }
    },
  );

  it('gives every registered entity type a unique label', () => {
    const labels = Object.values(AUDIT_ENTITY_REGISTRY).map((m) => m.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('registers every entity type the Details-view routers write', () => {
    // The routers behind the Details views above must not write an entity type
    // the registry has never heard of — that is exactly the gap #675 closed.
    const routerFiles = [
      'activity-types.ts', 'taxes.ts', 'sellable-items.ts', 'professional-services.ts',
      'nutrition-library.ts', 'nutrition-plan-templates.ts', 'member-nutrition-plans.ts',
      'gym-themes.ts', 'themes.ts', 'staff.ts',
    ];
    const written = new Set<string>();
    for (const { file, src } of routerSources()) {
      if (!routerFiles.includes(file)) continue;
      for (const m of src.matchAll(/entityType:\s*'([a-z_]+)'/g)) written.add(m[1]);
    }

    expect(written.size, 'expected to find entity types written by these routers').toBeGreaterThan(0);
    const unregistered = [...written].filter((t) => !AUDIT_ENTITY_REGISTRY[t]);
    expect(unregistered, 'these entity types are written but not registered').toEqual([]);
  });
});
