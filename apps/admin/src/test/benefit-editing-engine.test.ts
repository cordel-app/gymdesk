import { describe, expect, it, vi } from 'vitest';
import { saveBenefitSection, ProductBenefitRow } from '@/lib/benefitEditing';

// #2093 stage 1 — the context-agnostic save contract the Plans, Promotion and
// Assigned Plan editors share.
const row = (over: Partial<ProductBenefitRow> = {}): ProductBenefitRow => ({
  product_id: 1, quantity: 2, product_name: 'Locker', product_type: 'fee',
  product_billing_frequency: null, product_status: 'active', ...over,
});

describe('saveBenefitSection', () => {
  it('sends nothing when a line asks for a value it lacks', async () => {
    const save = vi.fn();
    const r = await saveBenefitSection({ save }, [row({ action: 'fixed_price', value: null })]);
    expect(r).toMatchObject({ ok: false, reason: 'incomplete_value' });
    expect(save).not.toHaveBeenCalled();
  });

  it('hands the replace-all payload to the adapter', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const r = await saveBenefitSection({ save }, [row({ action: 'percentage_discount', value: 20 })]);
    expect(r).toEqual({ ok: true });
    expect(save).toHaveBeenCalledWith([
      { product_id: 1, quantity: 2, action: 'percentage_discount', value: 20 },
    ]);
  });

  it('keeps quantity-only lines quantity-only', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await saveBenefitSection({ save }, [row()]);
    expect(save).toHaveBeenCalledWith([{ product_id: 1, quantity: 2 }]);
  });

  it('propagates an adapter failure so the editor stays open', async () => {
    const save = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(saveBenefitSection({ save }, [row()])).rejects.toThrow('boom');
  });
});
