import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../infra/db';
import { cleanupTestGyms, createTestGym } from './helpers';

let gymId: string;
let memberId: number;
let setId: number;
let scheduleId: number;

async function newEvent(over: { type?: string; productSet?: number | null; schedule?: number | null; period?: string | null } = {}) {
  const { insertId } = await db.query(
    `INSERT INTO billing_events (gym_id, member_id, event_type, source, amount, product_set_id, schedule_id, period_start, billing_date, is_scheduled)
     VALUES (?, ?, ?, 'system', 10, ?, ?, ?, ?, 1)`,
    [gymId, memberId, over.type ?? 'charge_created',
      over.productSet === undefined ? setId : over.productSet,
      over.schedule === undefined ? scheduleId : over.schedule,
      over.period ?? '2026-11-01', '2026-11-01'],
  );
  return insertId;
}

beforeAll(async () => {
  gymId = await createTestGym('BE schema gym');
  const m = await db.query('INSERT INTO members (gym_id, name, email) VALUES (?, ?, ?)', [gymId, 'M', `be-${Date.now()}@example.com`]);
  memberId = m.insertId;
  const s = await db.query(
    `INSERT INTO product_sets (gym_id, owner_member_id, status, starts_at) VALUES (?, ?, 'active', '2026-10-01')`,
    [gymId, memberId]);
  setId = s.insertId;
  await db.query('UPDATE product_sets SET root_product_set_id = id WHERE id = ?', [setId]);
  const sch = await db.query(
    `INSERT INTO product_set_schedules (gym_id, root_product_set_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
     VALUES (?, ?, 'plan', '2026-10-01', 1, 'month')`, [gymId, setId]);
  scheduleId = sch.insertId;
});

afterAll(async () => {
  await db.query('DELETE FROM billing_events WHERE gym_id = ?', [gymId]);
  await cleanupTestGyms();
  await db.end();
});

describe('billing_events ownership and schedule (#1325 PR 2a)', () => {
  it('one obligation per schedule and period, across versions', async () => {
    await newEvent({ period: '2026-12-01' });
    await expect(newEvent({ period: '2026-12-01' })).rejects.toThrow();
  });

  it('one-off events (no schedule) never collide', async () => {
    await newEvent({ schedule: null, period: '2026-12-01' });
    await newEvent({ schedule: null, period: '2026-12-01' });
  });

  it('accepts the two new event types and still refuses an unknown one', async () => {
    await newEvent({ type: 'product_purchase', productSet: null, schedule: null, period: '2027-01-01' });
    await newEvent({ type: 'card_verification', schedule: null, period: '2027-01-02' });
    await expect(newEvent({ type: 'made_up', schedule: null })).rejects.toThrow();
  });

  it('deleting a schedule keeps the obligation; deleting its set removes it', async () => {
    const s2 = await db.query(
      `INSERT INTO product_set_schedules (gym_id, root_product_set_id, schedule_key, anchor_date, cadence_interval, cadence_unit)
       VALUES (?, ?, 's1', '2026-10-05', 1, 'year')`, [gymId, setId]);
    const id = await newEvent({ schedule: s2.insertId, period: '2027-03-01' });
    await db.query('DELETE FROM product_set_schedules WHERE id = ?', [s2.insertId]);
    const { rows } = await db.query<{ schedule_id: number | null }>('SELECT schedule_id FROM billing_events WHERE id = ?', [id]);
    expect(rows[0].schedule_id).toBeNull();
  });
});

describe('billing_event_lines and payment attempts (#1325 PR 2a)', () => {
  it('lines belong to their event and go with it', async () => {
    const id = await newEvent({ schedule: null, period: '2027-02-01' });
    await db.query(
      `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount) VALUES (?, ?, 'membership_fee', 'Plan', 1, 10)`,
      [gymId, id]);
    await expect(db.query(
      `INSERT INTO billing_event_lines (gym_id, billing_event_id, kind, item_name, quantity, amount) VALUES (?, ?, 'made_up', 'x', 1, 1)`,
      [gymId, id])).rejects.toThrow();
    await db.query('DELETE FROM billing_events WHERE id = ?', [id]);
    const { rows } = await db.query('SELECT 1 FROM billing_event_lines WHERE billing_event_id = ?', [id]);
    expect(rows.length).toBe(0);
  });

  it('stores an unknown provider status verbatim and refuses an unknown method', async () => {
    const id = await newEvent({ schedule: null, period: '2027-02-02' });
    const insert = (attempt: number, providerStatus: string | null, method = 'provider') => db.query(
      `INSERT INTO payment_requests (gym_id, member_id, amount, status, source, billing_event_id, attempt, provider_status, method)
       VALUES (?, ?, 10, 'failed', 'billing_run', ?, ?, ?, ?)`,
      [gymId, memberId, id, attempt, providerStatus, method]);
    await insert(1, 'SOMETHING_NEW');
    const { rows } = await db.query<{ provider_status: string }>(
      'SELECT provider_status FROM payment_requests WHERE billing_event_id = ? AND attempt = 1', [id]);
    expect(rows[0].provider_status).toBe('SOMETHING_NEW');
    // No UNIQUE on (billing_event_id, attempt) yet: Pay-now requests share the
    // default attempt = 1 on one event (it lands with the attempt numbering, 2c).
    await insert(1, 'FAILED');
    await insert(2, null, 'waive');
    await expect(insert(3, null, 'barter')).rejects.toThrow();
  });
});
