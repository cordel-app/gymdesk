// Tests for operating-hours.ts router (#418 "Operating Hours & Holidays")
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '@clerk/backend';
import { db } from '../infra/db';
import {
  TEST_AUTH_HEADER,
  TEST_USER_ID,
  cleanupTestGyms,
  createTestGym,
  createTestMembership,
  request,
} from './helpers';

let gymId: string;
let otherGymId: string;

beforeAll(async () => {
  gymId = await createTestGym('Operating Hours Test Gym');
  await createTestMembership(gymId, 'admin');

  otherGymId = await createTestGym('Other Operating Hours Gym');
  await createTestMembership(otherGymId, 'admin', 'other-user');
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.end();
});

describe('GET /operating-hours/weekly', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/operating-hours/weekly').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const strangerGymId = await createTestGym('Stranger Gym');
    const res = await request
      .get('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', strangerGymId);
    expect(res.status).toBe(403);
  });

  it('returns 200 with an array for a read-only role (front_desk)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user' } as any);
    const staffGymId = await createTestGym('Staff Weekly Read Gym');
    await createTestMembership(staffGymId, 'front_desk', 'staff-user');
    const res = await request
      .get('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 200 with an empty array before any hours are set', async () => {
    const freshGymId = await createTestGym('Fresh Weekly Gym');
    await createTestMembership(freshGymId, 'admin');
    const res = await request
      .get('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', freshGymId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('PUT /operating-hours/weekly', () => {
  it('returns 401 without auth', async () => {
    const res = await request
      .put('/operating-hours/weekly')
      .set('x-gym-id', gymId)
      .send({ shifts: [] });
    expect(res.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const strangerGymId = await createTestGym('Stranger Write Gym');
    const res = await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', strangerGymId)
      .send({ shifts: [] });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a read-only role (front_desk)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user-2' } as any);
    const staffGymId = await createTestGym('Staff Weekly Write Gym');
    await createTestMembership(staffGymId, 'front_desk', 'staff-user-2');
    const res = await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ shifts: [{ weekday: 1, start_time: '09:00', end_time: '17:00' }] });
    expect(res.status).toBe(403);
  });

  it('returns 400 when weekday is out of 0-6 range', async () => {
    const res = await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ shifts: [{ weekday: 7, start_time: '09:00', end_time: '17:00' }] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when end_time is not after start_time', async () => {
    const res = await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ shifts: [{ weekday: 1, start_time: '17:00', end_time: '09:00' }] });
    expect(res.status).toBe(400);
  });

  it('bulk-replaces the week, supports split shifts on the same weekday, and returns them ordered', async () => {
    const first = await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        shifts: [
          { weekday: 1, start_time: '09:00', end_time: '12:00' },
          { weekday: 1, start_time: '14:00', end_time: '20:00' },
          { weekday: 3, start_time: '08:00', end_time: '18:00' },
        ],
      });
    expect(first.status).toBe(200);
    expect(first.body.length).toBe(3);

    const getAfterFirst = await request
      .get('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getAfterFirst.status).toBe(200);
    expect(getAfterFirst.body.length).toBe(3);
    // Ordered by weekday ASC, start_time ASC — the two Monday (weekday=1) shifts come
    // first, in start_time order, followed by the Wednesday (weekday=3) shift.
    expect(getAfterFirst.body[0]).toMatchObject({ weekday: 1, start_time: '09:00:00', end_time: '12:00:00' });
    expect(getAfterFirst.body[1]).toMatchObject({ weekday: 1, start_time: '14:00:00', end_time: '20:00:00' });
    expect(getAfterFirst.body[2]).toMatchObject({ weekday: 3, start_time: '08:00:00', end_time: '18:00:00' });

    // Bulk-replace with a different, smaller set — old shifts must be gone entirely,
    // not appended to.
    const second = await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ shifts: [{ weekday: 5, start_time: '10:00', end_time: '15:00' }] });
    expect(second.status).toBe(200);
    expect(second.body.length).toBe(1);
    expect(second.body[0]).toMatchObject({ weekday: 5, start_time: '10:00:00', end_time: '15:00:00' });

    const getAfterSecond = await request
      .get('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(getAfterSecond.status).toBe(200);
    expect(getAfterSecond.body.length).toBe(1);
    expect(getAfterSecond.body.some((s: any) => s.weekday === 1)).toBe(false);
    expect(getAfterSecond.body.some((s: any) => s.weekday === 3)).toBe(false);
  });

  it('does not leak weekly hours across gyms (tenant isolation)', async () => {
    await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ shifts: [{ weekday: 2, start_time: '06:00', end_time: '22:00' }] });

    const res = await request
      .get('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(200);
    expect(res.body.some((s: any) => s.weekday === 2 && s.start_time === '06:00:00')).toBe(false);
  });
});

describe('holidays CRUD', () => {
  it('returns 401 without auth on every endpoint', async () => {
    const getRes = await request.get('/operating-hours/holidays').set('x-gym-id', gymId);
    expect(getRes.status).toBe(401);

    const postRes = await request
      .post('/operating-hours/holidays')
      .set('x-gym-id', gymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-25', is_closed: true });
    expect(postRes.status).toBe(401);

    const putRes = await request
      .put('/operating-hours/holidays/1')
      .set('x-gym-id', gymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-25', is_closed: true });
    expect(putRes.status).toBe(401);

    const delRes = await request.delete('/operating-hours/holidays/1').set('x-gym-id', gymId);
    expect(delRes.status).toBe(401);
  });

  it('returns 403 when user has no membership in this gym', async () => {
    const strangerGymId = await createTestGym('Stranger Holidays Gym');
    const res = await request
      .get('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', strangerGymId);
    expect(res.status).toBe(403);
  });

  it('allows GET but forbids POST/PUT/DELETE for a read-only role (front_desk)', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user-3' } as any);
    const staffGymId = await createTestGym('Staff Holidays Gym');
    await createTestMembership(staffGymId, 'front_desk', 'staff-user-3');

    const getRes = await request
      .get('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId);
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body)).toBe(true);

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user-3' } as any);
    const postRes = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-25', is_closed: true });
    expect(postRes.status).toBe(403);

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user-3' } as any);
    const putRes = await request
      .put('/operating-hours/holidays/1')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-25', is_closed: true });
    expect(putRes.status).toBe(403);

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'staff-user-3' } as any);
    const delRes = await request
      .delete('/operating-hours/holidays/1')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', staffGymId);
    expect(delRes.status).toBe(403);
  });

  it('returns 400 when date_end is before date_start', async () => {
    const res = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-20', is_closed: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 when is_closed is true but start_time/end_time are also set', async () => {
    const res = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        date_start: '2026-12-25',
        date_end: '2026-12-25',
        is_closed: true,
        start_time: '09:00',
        end_time: '17:00',
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 when is_closed is false but start_time/end_time are missing', async () => {
    const res = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ date_start: '2026-12-24', date_end: '2026-12-24', is_closed: false });
    expect(res.status).toBe(400);
  });

  it('returns 400 when start_time is not before end_time on a special-hours holiday', async () => {
    const res = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        date_start: '2026-11-11',
        date_end: '2026-11-11',
        is_closed: false,
        start_time: '17:00',
        end_time: '09:00',
      });
    expect(res.status).toBe(400);
  });

  it('supports the full create/list/update/delete lifecycle', async () => {
    const create = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        date_start: '2026-12-25',
        date_end: '2026-12-26',
        is_closed: true,
        label: 'Christmas',
      });
    expect(create.status).toBe(201);
    expect(create.body.label).toBe('Christmas');
    expect(create.body.is_closed).toBe(1);
    const holidayId = create.body.id;

    const list = await request
      .get('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.some((h: any) => h.id === holidayId)).toBe(true);

    const update = await request
      .put(`/operating-hours/holidays/${holidayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        date_start: '2026-12-25',
        date_end: '2026-12-25',
        is_closed: false,
        start_time: '10:00',
        end_time: '14:00',
        label: 'Christmas (half day)',
      });
    expect(update.status).toBe(200);
    expect(update.body.label).toBe('Christmas (half day)');
    expect(update.body.is_closed).toBe(0);
    expect(update.body.start_time).toBe('10:00:00');
    expect(update.body.end_time).toBe('14:00:00');

    const del = await request
      .delete(`/operating-hours/holidays/${holidayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(del.status).toBe(204);

    // Soft-deleted — hidden from the list.
    const listAfterDelete = await request
      .get('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(listAfterDelete.status).toBe(200);
    expect(listAfterDelete.body.some((h: any) => h.id === holidayId)).toBe(false);

    // Second delete / update against an already-deleted row returns 404.
    const delAgain = await request
      .delete(`/operating-hours/holidays/${holidayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(delAgain.status).toBe(404);

    const updateAfterDelete = await request
      .put(`/operating-hours/holidays/${holidayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-25', is_closed: true });
    expect(updateAfterDelete.status).toBe(404);
  });

  it('supports annual_renewal holidays', async () => {
    const create = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({
        date_start: '2027-01-01',
        date_end: '2027-01-01',
        is_closed: true,
        annual_renewal: true,
        label: "New Year's Day",
      });
    expect(create.status).toBe(201);
    expect(create.body.annual_renewal).toBe(1);
  });

  it('does not return a holiday from another gym (tenant isolation) and 404s on direct access', async () => {
    const otherCreate = await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', otherGymId)
      .send({ date_start: '2026-07-04', date_end: '2026-07-04', is_closed: true, label: 'Other Gym Holiday' });
    expect(otherCreate.status).toBe(201);
    const otherHolidayId = otherCreate.body.id;

    const list = await request
      .get('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(list.status).toBe(200);
    expect(list.body.some((h: any) => h.id === otherHolidayId)).toBe(false);

    // Attempting to update/delete gym A's holiday while scoped to gym B is a 404,
    // not a leak of gym A's data.
    const updateCrossTenant = await request
      .put(`/operating-hours/holidays/${otherHolidayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId)
      .send({ date_start: '2026-07-04', date_end: '2026-07-04', is_closed: true });
    expect(updateCrossTenant.status).toBe(404);

    const deleteCrossTenant = await request
      .delete(`/operating-hours/holidays/${otherHolidayId}`)
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(deleteCrossTenant.status).toBe(404);
  });
});

describe('GET /me/operating-hours', () => {
  it('returns 401 without auth', async () => {
    const res = await request.get('/me/operating-hours').set('x-gym-id', gymId);
    expect(res.status).toBe(401);
  });

  it('requires a member role — a staff (admin) membership is forbidden', async () => {
    const res = await request
      .get('/me/operating-hours')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', gymId);
    expect(res.status).toBe(403);
  });

  it("returns the member's own gym's weekly hours and holidays", async () => {
    const memberGymId = await createTestGym('Member Operating Hours Gym');
    await createTestMembership(memberGymId, 'member', TEST_USER_ID);

    // Set up hours via the admin API, using a second admin membership for the
    // member's gym, so the member-facing GET below has data to read back.
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'admin-for-member-gym' } as any);
    await createTestMembership(memberGymId, 'admin', 'admin-for-member-gym');
    await request
      .put('/operating-hours/weekly')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', memberGymId)
      .send({ shifts: [{ weekday: 4, start_time: '07:00', end_time: '21:00' }] });

    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: 'admin-for-member-gym' } as any);
    await request
      .post('/operating-hours/holidays')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', memberGymId)
      .send({ date_start: '2026-12-25', date_end: '2026-12-25', is_closed: true, label: 'Christmas' });

    const res = await request
      .get('/me/operating-hours')
      .set('Authorization', TEST_AUTH_HEADER)
      .set('x-gym-id', memberGymId);
    expect(res.status).toBe(200);
    expect(res.body.weekly).toEqual([{ weekday: 4, start_time: '07:00:00', end_time: '21:00:00' }]);
    expect(res.body.holidays.length).toBe(1);
    // date_start/date_end are DATE columns — assert with a substring match rather
    // than strict equality, since mysql2 may hand back a JS Date that Express
    // then serializes to a full ISO datetime string (see members.test.ts).
    expect(res.body.holidays[0].date_start).toMatch(/2026-12-25/);
    expect(res.body.holidays[0].is_closed).toBe(1);
  });
});
