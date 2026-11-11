import { describe, expect, it } from 'vitest';
import { decideProductSharingType } from '../domain/productSharingType';

describe('decideProductSharingType (#2662)', () => {
  it('forces Family while linked and keeps the request otherwise', () => {
    expect(decideProductSharingType({ requested: undefined, linkedServiceCount: 1 })).toEqual({ ok: true, value: 'shared' });
    expect(decideProductSharingType({ requested: 'shared', linkedServiceCount: 2 })).toEqual({ ok: true, value: 'shared' });
    expect(decideProductSharingType({ requested: 'individual', linkedServiceCount: 1 }).ok).toBe(false);
    expect(decideProductSharingType({ requested: 'individual', linkedServiceCount: 0 })).toEqual({ ok: true, value: 'individual' });
    expect(decideProductSharingType({ requested: undefined, linkedServiceCount: 0 })).toEqual({ ok: true, value: null });
  });
});
