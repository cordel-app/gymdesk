import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../infra/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('../infra/db', () => ({ db: { query: vi.fn() } }));

import { recordAudit } from '../infra/audit';
import { recordDeclinedBenefitsAudit } from '../api/declined-plan-benefits';

describe('recordDeclinedBenefitsAudit (#1184 §22)', () => {
  beforeEach(() => vi.mocked(recordAudit).mockClear());

  it('writes nothing when nothing was declined', () => {
    recordDeclinedBenefitsAudit({} as any, 7, []);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('audits the declination against the assignment, never the membership plan', () => {
    const declined = [{ section: 'session' as const, product_id: 3 }];
    recordDeclinedBenefitsAudit({} as any, 7, declined);
    expect(recordAudit).toHaveBeenCalledWith({}, {
      action: 'decline_benefits', entityType: 'user_membership', entityId: 7,
      next: { declined_benefits: declined },
    });
  });
});
