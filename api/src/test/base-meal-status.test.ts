// #3328 stage 3: a Base Meal's Status — an inactive meal is kept and still read,
// but no longer offered or accepted as a new choice.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../infra/db';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, request } from './helpers';

// A superadmin is an admin of every gym (tenantContext) and may write Cordel's Base Meals.
vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn().mockResolvedValue({ sub: 'test-user-id' }),
    createClerkClient: vi.fn(() => ({
      users: {
        getUser: vi.fn().mockResolvedValue({
          publicMetadata: { platform_role: 'superadmin' }, fullName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
        }),
        getUserList: vi.fn().mockResolvedValue({ data: [], totalCount: 0 }),
      },
      invitations: { createInvitation: vi.fn(), revokeInvitation: vi.fn() },
      emailAddresses: { getEmailAddress: vi.fn().mockResolvedValue({ emailAddress: 'test@example.com' }) },
    })),
  };
});

const H = { Authorization: TEST_AUTH_HEADER };
const NAME = `Test Base Meal 3328s3 ${Date.now()}`;
let gymId: string;
let mealId: number;
let tplId: number;
let dayId: number;
let planMealId: number;

const gym = () => ({ ...H, 'x-gym-id': gymId });

beforeAll(async () => {
  gymId = await createTestGym('Base Meal Status Gym');
  const tpl = await request.post('/nutrition-plan-templates').set(gym()).send({ name: `BMS Template ${Date.now()}` });
  tplId = tpl.body.id;
  const day = await request.post(`/nutrition-plan-templates/${tplId}/days`).set(gym()).send({ weekday: 2 });
  dayId = day.body.id;
});

afterAll(async () => {
  await cleanupTestGyms();
  await db.query('DELETE FROM base_meals WHERE name LIKE ?', ['Test Base Meal 3328s3%']);
  await db.end();
});

describe('Base Meal status (#3328 stage 3)', () => {
  it('a new meal is active unless created inactive; an unknown status is a 400', async () => {
    const res = await request.post('/platform/base-meals').set(H).send({ name: NAME });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    mealId = res.body.id;
    expect((await request.post('/platform/base-meals').set(H).send({ name: `${NAME} x`, status: 'archived' })).status).toBe(400);
    const inactive = await request.post('/platform/base-meals').set(H).send({ name: `${NAME} off`, status: 'inactive' });
    expect(inactive.status).toBe(201);
    expect(inactive.body.status).toBe('inactive');
  });

  it('PUT changes the status, a PUT that omits it keeps it', async () => {
    const plan = await request.post(`/nutrition-plan-templates/${tplId}/days/${dayId}/meals`).set(gym()).send({ base_meal_id: mealId });
    expect(plan.status).toBe(201);
    planMealId = plan.body.id;

    const off = await request.put(`/platform/base-meals/${mealId}`).set(H).send({ status: 'inactive' });
    expect(off.status).toBe(200);
    expect(off.body.status).toBe('inactive');
    const renamed = await request.put(`/platform/base-meals/${mealId}`).set(H).send({ description: 'still off' });
    expect(renamed.body.status).toBe('inactive');
    expect((await request.put(`/platform/base-meals/${mealId}`).set(H).send({ status: 1 })).status).toBe(400);
  });

  it('the list filters by status and refuses an unknown one', async () => {
    const inactive = await request.get('/platform/base-meals').query({ status: 'inactive' }).set(H);
    expect(inactive.status).toBe(200);
    expect(inactive.body.map((m: any) => m.id)).toContain(mealId);
    expect(inactive.body.every((m: any) => m.status === 'inactive')).toBe(true);
    const active = await request.get('/platform/base-meals').query({ status: 'active' }).set(H);
    expect(active.body.map((m: any) => m.id)).not.toContain(mealId);
    expect((await request.get('/platform/base-meals').query({ status: 'gone' }).set(H)).status).toBe(400);
  });

  it('an inactive meal is not offered by the pickers and is refused as a new choice', async () => {
    const picker = await request.get('/nutrition-plan-templates/base-meals').set(gym());
    expect(picker.body.map((m: any) => m.id)).not.toContain(mealId);
    const url = `/nutrition-plan-templates/${tplId}/days/${dayId}/meals`;
    expect((await request.post(url).set(gym()).send({ base_meal_id: mealId })).status).toBe(400);
    const lunch = await request.post(url).set(gym()).send({ meal_type: 'lunch' });
    expect((await request.put(`${url}/${lunch.body.id}`).set(gym()).send({ base_meal_id: mealId })).status).toBe(400);
  });

  it('a meal already referencing it keeps reading it and may resend it on an unrelated edit', async () => {
    const url = `/nutrition-plan-templates/${tplId}/days/${dayId}/meals/${planMealId}`;
    const res = await request.put(url).set(gym()).send({ base_meal_id: mealId, notes: 'unrelated edit' });
    expect(res.status).toBe(200);
    expect(res.body.base_meal_id).toBe(mealId);
    expect(res.body.meal_name).toBe(NAME);
  });

  it('reactivating offers it again', async () => {
    await request.put(`/platform/base-meals/${mealId}`).set(H).send({ status: 'active' });
    const picker = await request.get('/nutrition-plan-templates/base-meals').set(gym());
    expect(picker.body.map((m: any) => m.id)).toContain(mealId);
  });
});
