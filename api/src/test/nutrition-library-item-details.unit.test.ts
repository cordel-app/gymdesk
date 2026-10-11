// Unit tests for the pure helpers #799 added to domain/nutritionLibrary.ts:
// the submitted-description rule, the actor snapshot both routers write, and the
// one column list every item-shaped response is built from.
//
// No DB and no HTTP — the round trip through the routers is covered by
// nutrition-library.test.ts and platform-nutrition-library.test.ts.

import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_LENGTH,
  itemDetailColumnsSql,
  normalizeDescription,
} from '../domain/nutritionLibrary';

describe('normalizeDescription', () => {
  it('leaves the column alone when the field is absent', () => {
    // `undefined` is what keeps PUT a partial update: a request that does not
    // mention the description must not clear it.
    expect(normalizeDescription(undefined)).toEqual({ value: undefined });
  });

  it('stores an explicit null, an empty string and whitespace as NULL', () => {
    for (const input of [null, '', '   ', '\n\t ']) {
      expect(normalizeDescription(input), `${JSON.stringify(input)} means "no description"`)
        .toEqual({ value: null });
    }
  });

  it('trims what it stores', () => {
    expect(normalizeDescription('  Lean red meat  ')).toEqual({ value: 'Lean red meat' });
  });

  it('accepts exactly the column width and refuses one character more', () => {
    expect(normalizeDescription('x'.repeat(DESCRIPTION_MAX_LENGTH)))
      .toEqual({ value: 'x'.repeat(DESCRIPTION_MAX_LENGTH) });
    const tooLong = normalizeDescription('x'.repeat(DESCRIPTION_MAX_LENGTH + 1));
    expect('error' in tooLong).toBe(true);
  });

  it('measures the trimmed value, so trailing spaces cannot push it over', () => {
    const padded = `${'x'.repeat(DESCRIPTION_MAX_LENGTH)}     `;
    expect(normalizeDescription(padded)).toEqual({ value: 'x'.repeat(DESCRIPTION_MAX_LENGTH) });
  });

  it('refuses anything that is not a string', () => {
    for (const input of [42, true, { nope: true }, ['a'], () => 'a']) {
      const result = normalizeDescription(input);
      expect('error' in result, `${JSON.stringify(input)} is not a description`).toBe(true);
    }
  });
});

describe('itemDetailColumnsSql', () => {
  it('qualifies every column with the caller\'s alias', () => {
    const sql = itemDetailColumnsSql('nli');
    for (const column of [
      'description',
      'created_by', 'modified_by',
      'deleted_at', 'deleted_by',
    ]) {
      expect(sql).toContain(`nli.${column}`);
    }
    // Every fragment is qualified — an unqualified column would be ambiguous in
    // a query that joins the translations table.
    for (const fragment of sql.split(', ')) {
      expect(fragment.startsWith('nli.')).toBe(true);
    }
  });

  it('masks only the actor names on the shared system rows, and keeps the keys', () => {
    const masked = itemDetailColumnsSql('nli', { maskPlatformActors: true });
    for (const column of ['created_by', 'modified_by', 'deleted_by']) {
      // Still projected under the same key, so a reader needs no rule of its own.
      expect(masked).toContain(`END AS ${column}`);
      expect(masked).toContain(`CASE WHEN nli.gym_id IS NULL THEN NULL ELSE nli.${column} END`);
    }
    // A date names nobody, and the description is the food's, not an actor's.
    expect(masked).toContain('nli.description');
    expect(masked).toContain('nli.deleted_at');
    expect(masked).not.toContain('THEN NULL ELSE nli.deleted_at');
    expect(masked).not.toContain('THEN NULL ELSE nli.description');
  });

  it('projects the same keys masked or not', () => {
    const keyOf = (fragment: string) => fragment.replace(/^.* AS /, '').replace('nli.', '').trim();
    const plain = itemDetailColumnsSql('nli').split(', ').map(keyOf);
    // The CASE expressions contain no top-level comma, so splitting is safe.
    const masked = itemDetailColumnsSql('nli', { maskPlatformActors: true }).split(', ').map(keyOf);
    expect(masked).toEqual(plain);
  });

  it('is the same set whichever alias asks for it', () => {
    const withAlias = itemDetailColumnsSql('x').split(', ').map((c) => c.replace('x.', ''));
    const withOther = itemDetailColumnsSql('nli').split(', ').map((c) => c.replace('nli.', ''));
    expect(withAlias).toEqual(withOther);
  });
});
