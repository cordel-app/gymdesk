/**
 * #959 — a Promotion's Sellable Item line carries a **Requirement** (Mandatory /
 * Optional): the option set, the replace-all input rule, and the "two places"
 * guard (the list in `domain/promotionItemRequirement.ts` and the CHECK migration
 * 207 writes have to say the same thing, or the dropdown could offer a value the
 * table refuses).
 *
 * Pure module, no DB (CLAUDE.md): the migration is read as a module and its
 * exported list compared, the way `session-benefit-frequency.unit.test.ts` reads
 * back migration 205's and `sellable-item-benefit-actions.unit.test.ts` 203's.
 * The schema itself, the API and the snapshot copy are integration-tested in
 * `promotion-item-requirements.test.ts`.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROMOTION_ITEM_REQUIREMENT,
  PROMOTION_ITEM_REQUIREMENTS,
  describePromotionItemRequirements,
  isPromotionItemRequirement,
  parsePromotionItemRequirementInput,
  toPromotionItemRequirement,
} from '../domain/promotionItemRequirement';

const require = createRequire(__filename);
const migration = require('../infra/migrations/207_promotion_item_requirement.js') as {
  PROMOTION_ITEM_REQUIREMENTS: string[];
  DEFAULT_REQUIREMENT: string;
  DEFINITION_TABLES: string[];
  SNAPSHOT_TABLES: string[];
  TABLES: string[];
};

describe('#959 — the option set', () => {
  it('offers Mandatory and Optional, in that order', () => {
    expect(PROMOTION_ITEM_REQUIREMENTS).toEqual(['mandatory', 'optional']);
  });

  it('defaults to mandatory — what every line written before the ticket means', () => {
    // An applied Promotion grants everything it configures today, and nothing
    // offers the member a choice. Defaulting to `optional` would announce a
    // choice the assignment process does not implement yet, for every stored row.
    expect(DEFAULT_PROMOTION_ITEM_REQUIREMENT).toBe('mandatory');
  });

  it('recognizes only its own values', () => {
    expect(isPromotionItemRequirement('mandatory')).toBe(true);
    expect(isPromotionItemRequirement('optional')).toBe(true);
    expect(isPromotionItemRequirement('Optional')).toBe(false);
    expect(isPromotionItemRequirement('')).toBe(false);
    expect(isPromotionItemRequirement(null)).toBe(false);
    expect(isPromotionItemRequirement(true)).toBe(false);
  });

  it('normalizes a stored value, and anything unusable to the default', () => {
    expect(toPromotionItemRequirement('optional')).toBe('optional');
    expect(toPromotionItemRequirement('mandatory')).toBe('mandatory');
    expect(toPromotionItemRequirement(null)).toBe('mandatory');
    expect(toPromotionItemRequirement('required')).toBe('mandatory');
  });

  it('names the accepted set in the 400 message', () => {
    expect(describePromotionItemRequirements()).toBe('mandatory, optional');
  });
});

describe('#959 — what a replace-all PUT does with one line', () => {
  it('keeps the stored value when the request names none', () => {
    // The load-bearing case: the three section `PUT`s are replace-all, so a
    // client that sends `gym_charge_id` + `quantity` alone — anything written
    // before this ticket — must not reset an optional item to mandatory.
    expect(parsePromotionItemRequirementInput({ gym_charge_id: 1, quantity: 2 }))
      .toEqual({ keep: true });
    expect(parsePromotionItemRequirementInput({ requirement: undefined })).toEqual({ keep: true });
    expect(parsePromotionItemRequirementInput(null)).toEqual({ keep: true });
  });

  it('treats null and the empty string as "named none" rather than a value', () => {
    // The column is NOT NULL: there is nothing for a `—` to mean here, so an
    // empty select value is the absence of a choice and keeps what is stored.
    expect(parsePromotionItemRequirementInput({ requirement: null })).toEqual({ keep: true });
    expect(parsePromotionItemRequirementInput({ requirement: '' })).toEqual({ keep: true });
  });

  it('accepts an explicit value', () => {
    expect(parsePromotionItemRequirementInput({ requirement: 'optional' }))
      .toEqual({ keep: false, requirement: 'optional' });
    expect(parsePromotionItemRequirementInput({ requirement: 'mandatory' }))
      .toEqual({ keep: false, requirement: 'mandatory' });
  });

  it('refuses anything else rather than coercing it', () => {
    // `optional` and `mandatory` are opposite promises to the member, so a typo
    // must not silently become either one.
    for (const bad of ['Optional', 'required', 'true', 0, {}]) {
      const parsed = parsePromotionItemRequirementInput({ requirement: bad });
      expect(parsed.error).toBe('requirement must be one of: mandatory, optional');
      expect(parsed.keep).toBeUndefined();
    }
  });
});

describe('#959 — the list and the CHECK agree (two places)', () => {
  it('mirrors the domain list in migration 207', () => {
    expect(migration.PROMOTION_ITEM_REQUIREMENTS).toEqual([...PROMOTION_ITEM_REQUIREMENTS]);
  });

  it('mirrors the default, which is also the backfill', () => {
    expect(migration.DEFAULT_REQUIREMENT).toBe(DEFAULT_PROMOTION_ITEM_REQUIREMENT);
  });

  it('puts the column on the three Promotion tables and their three snapshots', () => {
    expect(migration.DEFINITION_TABLES).toEqual([
      'promotion_session', 'promotion_oneoff', 'promotion_periodical',
    ]);
    expect(migration.SNAPSHOT_TABLES).toEqual([
      'user_membership_promotion_session_snapshot',
      'user_membership_promotion_oneoff_snapshot',
      'user_membership_promotion_periodical_snapshot',
    ]);
    expect(migration.TABLES).toEqual([
      ...migration.DEFINITION_TABLES, ...migration.SNAPSHOT_TABLES,
    ]);
  });

  it('touches no Membership Plan table — the thread excludes Plans from this ticket', () => {
    for (const table of migration.TABLES) {
      expect(table).not.toMatch(/membership_plan/);
      expect(table).not.toMatch(/^user_membership_(session|oneoff|periodical)$/);
    }
  });

  it('touches no Membership Fee Benefit table — the thread answers Q3 "No"', () => {
    expect(migration.TABLES).not.toContain('promotion_membership_fee_benefits');
  });
});
