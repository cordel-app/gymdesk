// #2609 stage 2 — the Members App's decisions about who a Product is for: when the
// Buy dialog asks, in which order it offers the family, what the request carries,
// and when a purchase says who it is for. Pure, so asserted here; in the API suite
// because CI runs `npm test` in `api/` only (#1009's reason).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  type OwnPurchase,
  type ProductAssignee,
  assigneeOptions,
  assigneePayload,
  ownPurchaseAssigneeName,
  purchaseErrorKey,
  showsAssigneeChoice,
} from '../../../apps/member/src/lib/memberProducts';

const FAMILY: ProductAssignee[] = [
  { member_id: 1, name: 'Owner', is_owner: true },
  { member_id: 2, name: 'Kid', is_owner: false },
  { member_id: 3, name: 'Partner', is_owner: false },
];
const ALONE: ProductAssignee[] = [];

describe('showsAssigneeChoice', () => {
  it('asks only a member with a family buying an Individual Product', () => {
    expect(showsAssigneeChoice({ sharing_type: 'individual' }, FAMILY)).toBe(true);
    expect(showsAssigneeChoice({}, FAMILY)).toBe(true);
    expect(showsAssigneeChoice({ sharing_type: 'shared' }, FAMILY)).toBe(false);
    expect(showsAssigneeChoice({ sharing_type: 'individual' }, ALONE)).toBe(false);
    expect(showsAssigneeChoice({ sharing_type: 'individual' }, [FAMILY[0]])).toBe(false);
  });
});

describe('assigneeOptions', () => {
  it('offers the buyer first, then the family in the server order', () => {
    expect(assigneeOptions(FAMILY, 2).map((a) => a.member_id)).toEqual([2, 1, 3]);
    expect(assigneeOptions(FAMILY, 1).map((a) => a.member_id)).toEqual([1, 2, 3]);
  });
});

describe('assigneePayload', () => {
  it('names the chosen member only when the dialog asked', () => {
    expect(assigneePayload({ sharing_type: 'individual' }, FAMILY, 2)).toEqual({ assigned_member_id: 2 });
    expect(assigneePayload({ sharing_type: 'shared' }, FAMILY, 2)).toEqual({});
    expect(assigneePayload({ sharing_type: 'individual' }, ALONE, 7)).toEqual({});
    expect(assigneePayload({ sharing_type: 'individual' }, FAMILY, null)).toEqual({});
  });
});

describe('ownPurchaseAssigneeName', () => {
  const purchase = (name: string | null): OwnPurchase => ({
    id: 1, product_name: 'Locker', amount: 30, currency: 'EUR', billing_frequency: 'once',
    own_state: 'active', end_date: null, assigned_member_id: 2, assigned_member_name: name,
  });
  it('names the recipient to a member with a family, and nobody otherwise', () => {
    expect(ownPurchaseAssigneeName(purchase('Kid'), FAMILY)).toBe('Kid');
    expect(ownPurchaseAssigneeName(purchase('Kid'), ALONE)).toBeNull();
    expect(ownPurchaseAssigneeName(purchase(null), FAMILY)).toBeNull();
    expect(ownPurchaseAssigneeName(purchase('  '), FAMILY)).toBeNull();
  });
});

describe('purchaseErrorKey', () => {
  it('reads every assignee refusal in the member language', () => {
    for (const code of ['assignee_not_in_family', 'assignee_not_allowed', 'assignee_invalid']) {
      expect(purchaseErrorKey(code)).toBe('membership.product_assignee_error');
    }
  });
});

describe('locale keys', () => {
  it('exist in the three Members App locales', () => {
    for (const locale of ['en', 'es', 'ca']) {
      const file = join(__dirname, '..', '..', '..', 'apps', 'member', 'locales', 'base', `${locale}.json`);
      const membership = JSON.parse(readFileSync(file, 'utf8')).membership;
      for (const key of ['product_assignee_label', 'product_assignee_self', 'product_assignee_line', 'product_assignee_error']) {
        expect(typeof membership[key], `${locale}.${key}`).toBe('string');
      }
    }
  });
});
