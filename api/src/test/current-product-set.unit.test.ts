import { describe, it, expect } from 'vitest';
import { resolveCurrentProductSet } from '../domain/currentProductSet';

const s = (id: number, status: string) => ({ id, status });

describe('resolveCurrentProductSet (#1582)', () => {
  it('no sets', () => expect(resolveCurrentProductSet([])).toEqual({ kind: 'none' }));
  it('only superseded: no active, history kept', () => {
    const r = resolveCurrentProductSet([s(2, 'superseded'), s(1, 'superseded')]);
    expect(r.kind).toBe('no_active');
  });
  it('one active is current', () => {
    const r = resolveCurrentProductSet([s(3, 'active'), s(1, 'superseded')]);
    expect(r).toMatchObject({ kind: 'current', current: { id: 3 } });
  });
  it('in-flight outranks active', () => {
    const r = resolveCurrentProductSet([s(4, 'draft'), s(3, 'active')]);
    expect(r).toMatchObject({ kind: 'current', current: { id: 4 } });
  });
  it('two active is ambiguous, never a silent pick', () => {
    expect(resolveCurrentProductSet([s(3, 'active'), s(2, 'active')])).toMatchObject({
      kind: 'ambiguous', reason: 'multiple_active',
    });
  });
  it('two in-flight is ambiguous', () => {
    expect(resolveCurrentProductSet([s(4, 'draft'), s(5, 'pending_payment')])).toMatchObject({
      kind: 'ambiguous', reason: 'multiple_in_flight',
    });
  });
});
