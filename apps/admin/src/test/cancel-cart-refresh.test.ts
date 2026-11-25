import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #3164 — cancelling (or expiring) the In Cart ProductSet must re-read the Products table too:
// `reloadConfiguration` alone re-reads the ProductSet, so the cancelled cart's rows stayed on
// screen as In Cart beside the restored Active ProductSet.
const src = readFileSync(join(__dirname, '../app/[locale]/members/MemberExpandedRow.tsx'), 'utf8');

describe('#3164 the Products table refreshes when the cart ends', () => {
  it('reloadProducts re-reads the purchases and the configuration', () => {
    const fn = src.slice(src.indexOf('async function reloadProducts()'), src.indexOf('async function reloadConfiguration()'));
    expect(fn).toContain('/members/${memberId}/products');
    expect(fn).toContain('setPurchasedProducts(');
    expect(fn).toContain('await reloadConfiguration()');
  });
  it('wires the cart Cancel, the cart expiry and the in-flight sets to it', () => {
    expect(src).toContain('onDiscarded={reloadProducts}');
    expect(src).not.toContain('onDiscarded={reloadConfiguration}');
    // #3378 — the countdown lives in the Purchase header; its expiry still re-reads the Products table.
    expect(src).toContain('{ seconds: cartSeconds, onExpire: reloadProducts }');
    expect(src).not.toContain('<CartStatusBar');
    expect(src).toMatch(/review=\{draftReview\}\s*onChanged=\{reloadProducts\}/);
  });
});
