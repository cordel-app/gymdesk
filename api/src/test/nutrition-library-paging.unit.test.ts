import { describe, it, expect } from 'vitest';
import { pagingClause } from '../domain/nutritionLibrary';

describe('pagingClause (#1302)', () => {
  it('limit=all returns no LIMIT clause', () => {
    expect(pagingClause('all', '40')).toEqual({ clause: '', limit: null, offset: 0 });
    expect(pagingClause('ALL', undefined).clause).toBe('');
  });
  it('keeps the validated literal paging otherwise', () => {
    expect(pagingClause('20', '40')).toEqual({ clause: 'LIMIT 20 OFFSET 40', limit: 20, offset: 40 });
    expect(pagingClause(undefined, undefined).clause).toBe('LIMIT 50 OFFSET 0');
    expect(pagingClause('9999', '0').clause).toBe('LIMIT 200 OFFSET 0');
  });
});
