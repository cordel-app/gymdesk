import { describe, it, expect } from 'vitest';
import {
  worstPaymentStatus,
  memberPaymentStatusSql,
  PAYMENT_STATUS_SEVERITY,
} from '../domain/memberPaymentStatus';

describe('worstPaymentStatus (#1235)', () => {
  it('failed beats pending, pending beats paid', () => {
    expect(worstPaymentStatus(['completed', 'completed', 'failed'])).toBe('failed');
    expect(worstPaymentStatus(['completed', 'pending'])).toBe('pending');
    expect(worstPaymentStatus(['pending', 'failed'])).toBe('failed');
  });

  it('all paid is paid', () => {
    expect(worstPaymentStatus(['completed', 'completed'])).toBe('completed');
  });

  it('null when nothing is billed', () => {
    expect(worstPaymentStatus([])).toBeNull();
    expect(worstPaymentStatus([null, undefined])).toBeNull();
  });

  it('ranks expired between failed and pending', () => {
    expect(worstPaymentStatus(['pending', 'expired'])).toBe('expired');
    expect(worstPaymentStatus(['expired', 'failed'])).toBe('failed');
  });

  it('covers every payment_requests status', () => {
    expect([...PAYMENT_STATUS_SEVERITY].sort()).toEqual(['completed', 'expired', 'failed', 'pending']);
  });
});

describe('memberPaymentStatusSql', () => {
  const sql = memberPaymentStatusSql('m');
  it('excludes card verifications but not product purchases', () => {
    expect(sql).toContain("NOT IN ('card_update')");
    expect(sql).not.toContain('product_purchase');
  });
  it('takes the latest request per concept and orders by severity', () => {
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain("WHEN 'failed' THEN 0");
  });
});
