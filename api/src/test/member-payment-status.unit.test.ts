import { describe, it, expect } from 'vitest';
import { memberPaymentStatusSql } from '../domain/memberPaymentStatus';

describe('memberPaymentStatusSql (#2574)', () => {
  const sql = memberPaymentStatusSql('m');
  it('reads Billing Events, not payment requests as the source', () => {
    expect(sql).toContain('FROM billing_events be');
    expect(sql).toContain('be.member_id = m.id');
  });
  it('puts unsettled events first, newest first', () => {
    expect(sql).toMatch(/ORDER BY \(.* = 'paid'\), be\.created_at DESC, be\.id DESC/s);
  });
  it('leaves out verifications, waivers, status changes and unattempted obligations', () => {
    expect(sql).toContain('be.is_scheduled = 0');
    expect(sql).toContain("'card_verification'");
    expect(sql).toContain("'waived_billing'");
  });
});
