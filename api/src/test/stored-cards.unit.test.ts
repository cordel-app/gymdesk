// #788: the pure rules behind a member's stored card — no DB, no provider.
import { describe, expect, it } from 'vitest';
import {
  CARD_UPDATE_SOURCE,
  cardRemovalBlock,
  describeStoredCard,
  withPurposeParam,
} from '../domain/storedCards';

describe('CARD_UPDATE_SOURCE', () => {
  // Migration 195's CHECK carries this literal, and so do the three financial
  // surfaces that exclude it (`members.ts`'s payment_status, the staff request
  // list, the member's own history). A rename that reached only the constant
  // would make every one of those queries silently stop excluding anything.
  it('is the value migration 195 added to chk_payment_requests_source', () => {
    expect(CARD_UPDATE_SOURCE).toBe('card_update');
  });
});

describe('cardRemovalBlock', () => {
  it('allows removal when the member has no assignments at all', () => {
    expect(cardRemovalBlock([])).toBeNull();
  });

  it('blocks removal while an active assignment is scheduled to be charged', () => {
    expect(cardRemovalBlock([{ status: 'active', next_billing_date: '2026-11-01' }]))
      .toBe('billable_membership');
  });

  it('blocks removal for a paused assignment that still has a due date', () => {
    // #785 pauses an assignment after the second consecutive rejection, and
    // reactivating it means "bill this again" — so the card is still owed.
    expect(cardRemovalBlock([{ status: 'paused', next_billing_date: '2026-11-01' }]))
      .toBe('billable_membership');
  });

  it('allows removal for an active assignment with no due date', () => {
    // Nothing has ever been billed and nothing is scheduled: the nightly run's
    // due query cannot select it, so removing the card takes no money away.
    expect(cardRemovalBlock([{ status: 'active', next_billing_date: null }])).toBeNull();
  });

  it('allows removal once every assignment is cancelled or expired', () => {
    expect(cardRemovalBlock([
      { status: 'cancelled', next_billing_date: '2026-11-01' },
      { status: 'expired', next_billing_date: '2026-12-01' },
    ])).toBeNull();
  });

  it('blocks when any one of several assignments is still billable', () => {
    // #634: a member may hold several Assigned Plans at once, and they share the
    // one stored card — so one live contract is enough to keep it.
    expect(cardRemovalBlock([
      { status: 'cancelled', next_billing_date: '2026-10-01' },
      { status: 'active', next_billing_date: '2026-11-01' },
    ])).toBe('billable_membership');
  });

  it('accepts a Date, as mysql2 may return a DATE column', () => {
    expect(cardRemovalBlock([{ status: 'active', next_billing_date: new Date('2026-11-01') }]))
      .toBe('billable_membership');
  });
});

describe('describeStoredCard', () => {
  const row = {
    provider: 'monei',
    card_brand: 'visa',
    card_last4: '4242',
    created_at: '2026-01-05 10:00:00',
    updated_at: '2026-09-20 09:30:00',
  };

  it('returns null when no card is stored', () => {
    expect(describeStoredCard(null)).toBeNull();
    expect(describeStoredCard(undefined)).toBeNull();
  });

  it('never projects the token or the sequence id', () => {
    // The pair is what charges this member; nothing outside the nightly run and
    // the staff retry has any use for it, so it must not be reachable from a
    // route's response shape at all.
    const described = describeStoredCard({ ...row, payment_token: 'tok_live', sequence_id: 'seq_1' } as any);
    expect(described).toEqual({
      provider: 'monei',
      card_brand: 'visa',
      card_last4: '4242',
      since: '2026-09-20 09:30:00',
    });
    expect(JSON.stringify(described)).not.toContain('tok_live');
    expect(JSON.stringify(described)).not.toContain('seq_1');
  });

  it('dates the card on file by the last upsert, not the row', () => {
    // `created_at` is when the member's first payment stored a card; after a
    // replacement it says nothing about the card that is there now.
    expect(describeStoredCard(row)!.since).toBe('2026-09-20 09:30:00');
  });

  it('falls back to created_at for a card stored before migration 195', () => {
    expect(describeStoredCard({ ...row, updated_at: null })!.since).toBe('2026-01-05 10:00:00');
  });
});

describe('withPurposeParam', () => {
  it('adds the first query parameter', () => {
    expect(withPurposeParam('https://members.example/payment/success', 'card_update'))
      .toBe('https://members.example/payment/success?purpose=card_update');
  });

  it('appends to an existing query string', () => {
    expect(withPurposeParam('https://members.example/payment/success?lang=es', 'card_update'))
      .toBe('https://members.example/payment/success?lang=es&purpose=card_update');
  });

  it('keeps a fragment at the end, where the browser expects it', () => {
    expect(withPurposeParam('https://members.example/payment/success#done', 'card_update'))
      .toBe('https://members.example/payment/success?purpose=card_update#done');
  });

  it('leaves an unset URL empty, which the payment page reads as "no redirect"', () => {
    expect(withPurposeParam('', 'card_update')).toBe('');
  });
});
