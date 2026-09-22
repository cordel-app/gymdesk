// #613: a role with read-only access (R / R_ASSIGNED per the #156 matrix) can list a
// module's data but every write is rejected with 403. The admin app disables the
// write controls for these roles; this pins the API side so a new route can't ship
// without its guard.
//
// Writes target an id that doesn't exist on purpose: the permission guard runs
// before the handler, so a route that lost its guard answers 400/404 instead of 403.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_AUTH_HEADER, cleanupTestGyms, createTestGym, createTestMembership, request } from './helpers';

type Role = 'front_desk' | 'accountant' | 'trainer_performance';
type Verb = 'post' | 'put' | 'delete';

// module → the read-only role used for it, the endpoints it can list, and writes that must 403.
const CASES: { module: string; role: Role; reads: string[]; writes: [Verb, string][] }[] = [
  { module: 'MEMBERS (R_ASSIGNED)', role: 'trainer_performance', reads: ['/members'],
    writes: [['post', '/members'], ['put', '/members/999999'], ['delete', '/members/999999']] },
  { module: 'ORGANIZATION (R)', role: 'front_desk', reads: ['/spaces', '/centers', '/activity-types', '/professional-services', '/staff'],
    writes: [['post', '/spaces'], ['put', '/spaces/999999'], ['delete', '/spaces/999999'],
             ['post', '/centers'], ['put', '/centers/999999'], ['delete', '/centers/999999'],
             ['post', '/activity-types'], ['put', '/activity-types/999999'], ['delete', '/activity-types/999999'],
             ['post', '/professional-services'], ['put', '/professional-services/999999'], ['delete', '/professional-services/999999'],
             ['post', '/staff'], ['put', '/staff/999999'], ['delete', '/staff/999999']] },
  { module: 'TRAINING (R)', role: 'front_desk', reads: ['/exercises', '/workout-templates', '/training-plan-templates'],
    writes: [['post', '/exercises'], ['put', '/exercises/999999'], ['delete', '/exercises/999999'],
             ['post', '/workout-templates'], ['post', '/training-plan-templates'], ['post', '/training-plans']] },
  { module: 'NUTRITION (R)', role: 'front_desk', reads: ['/nutrition-library', '/nutrition-plan-templates'],
    writes: [['post', '/nutrition-library'], ['post', '/nutrition-plan-templates']] },
  { module: 'FINANCIALS (R)', role: 'front_desk', reads: ['/membership-plans', '/promotions', '/sellable-items', '/taxes'],
    writes: [['post', '/membership-plans'], ['put', '/membership-plans/999999'], ['delete', '/membership-plans/999999'],
             ['post', '/promotions'], ['post', '/sellable-items'], ['post', '/taxes'], ['put', '/taxes/999999'], ['delete', '/taxes/999999']] },
  { module: 'PAYMENTS (R)', role: 'accountant', reads: ['/user-memberships'],
    writes: [['post', '/user-memberships'],
             // #640: the two audited Billing Event payment actions.
             ['post', '/payments/billing-events/999999/retry'],
             ['post', '/payments/billing-events/999999/manual-payment']] },
];

const gyms = {} as Record<Role, string>;

beforeAll(async () => {
  for (const role of ['front_desk', 'accountant', 'trainer_performance'] as Role[]) {
    gyms[role] = await createTestGym(`Read-only ${role}`);
    await createTestMembership(gyms[role], role);
  }
});

afterAll(async () => {
  await cleanupTestGyms();
  const { db } = await import('../infra/db');
  await db.end();
});

describe('read-only roles can list but not write (#613)', () => {
  for (const c of CASES) {
    describe(c.module, () => {
      for (const path of c.reads) {
        it(`${c.role} GET ${path} → 200`, async () => {
          const res = await request.get(path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gyms[c.role]);
          expect(res.status).toBe(200);
        });
      }
      for (const [verb, path] of c.writes) {
        it(`${c.role} ${verb.toUpperCase()} ${path} → 403`, async () => {
          const res = await request[verb](path).set('Authorization', TEST_AUTH_HEADER).set('x-gym-id', gyms[c.role]).send({});
          expect(res.status).toBe(403);
        });
      }
    });
  }
});
